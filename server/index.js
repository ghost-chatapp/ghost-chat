import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import redis from './redis.js';
import db from './db.js';

import authRoutes from './routes/auth.js';
import messageRoutes from './routes/messages.js';
import friendRoutes from './routes/friends.js';
import worldRoutes from './routes/world.js';
import groupRoutes from './routes/groups.js';
import adminRoutes from './routes/admin.js';

// ── Validate critical env vars at startup ────────────────────────────────────
const required = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'HMAC_SECRET', 'DATABASE_URL', 'ADMIN_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`FATAL: ${key} is not set`);
    process.exit(1);
  }
}

const app = express();
const httpServer = createServer(app);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';

// ── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
});

// Socket.IO JWT authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check blacklist
    const blacklisted = await redis.get(`blacklist:${decoded.jti}`);
    if (blacklisted) return next(new Error('Token revoked'));

    socket.accountCode = decoded.accountCode;
    socket.isDecoy = decoded.decoy || false;
    next();
  } catch (err) {
    next(new Error('Unauthorized'));
  }
});

// Online users map: accountCode → socket.id
const onlineUsers = new Map();

// Per-socket rate limiting state
const socketRateLimits = new Map();

function socketRateLimit(socketId, event, limit = 10, windowMs = 10000) {
  const key = `${socketId}:${event}`;
  const now = Date.now();
  const state = socketRateLimits.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + windowMs;
  }

  state.count++;
  socketRateLimits.set(key, state);

  return state.count <= limit;
}

io.on('connection', async (socket) => {
  const accountCode = socket.accountCode;
  if (!accountCode) return socket.disconnect();

  // Load display name for this socket session
  try {
    const r = await db.query('SELECT display_name FROM accounts WHERE account_code = $1', [accountCode]);
    socket.displayName = r.rows[0]?.display_name || 'Ghost';
  } catch { socket.displayName = 'Ghost'; }

  // Register presence
  onlineUsers.set(accountCode, socket.id);

  // Update display name on socket when changed
  socket.on('update_display_name', (name) => {
    if (typeof name === 'string' && name.length <= 32) {
      socket.displayName = name.trim() || 'Ghost';
    }
  });

  // Ghost mode: don't broadcast presence if enabled
  socket.on('set_ghost_mode', (enabled) => {
    socket.ghostMode = !!enabled;
    if (!enabled) {
      socket.broadcast.emit('user_online', { accountCode });
    }
  });

  // Notify friends user is online (unless ghost mode)
  if (!socket.ghostMode) {
    socket.broadcast.emit('user_online', { accountCode });
  }

  // ── Private message delivery ──────────────────────────────────────────────
  socket.on('private_message', (data) => {
    if (!socketRateLimit(socket.id, 'private_message', 20, 10000)) {
      socket.emit('error', { code: 'RATE_LIMITED', message: 'Slow down' });
      return;
    }

    if (!data?.recipientCode || !data?.payload || typeof data.payload !== 'string') return;
    if (data.payload.length > 8192) return;

    const recipientSocketId = onlineUsers.get(data.recipientCode);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('private_message', {
        id: data.id || uuidv4(),
        from: accountCode,
        displayName: socket.displayName || null,
        payload: data.payload,
        selfDestructSeconds: data.selfDestructSeconds || null,
        ts: Date.now(),
      });
    }
    // If offline, message was already stored in Redis via HTTP endpoint
  });

  // ── Voice message delivery ────────────────────────────────────────────────
  socket.on('voice_message', (data) => {
    if (!socketRateLimit(socket.id, 'voice_message', 5, 30000)) {
      socket.emit('error', { code: 'RATE_LIMITED', message: 'Voice message rate limit exceeded' });
      return;
    }

    if (!data?.recipientCode || !data?.payload) return;

    const recipientSocketId = onlineUsers.get(data.recipientCode);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('voice_message', {
        id: data.id || uuidv4(),
        from: accountCode,
        payload: data.payload,
        duration: data.duration || 0,
        ts: Date.now(),
      });
    }
  });

  // ── World chat ────────────────────────────────────────────────────────────
  socket.on('world_message', (data) => {
    if (!socketRateLimit(socket.id, 'world_message', 3, 9000)) {
      socket.emit('error', { code: 'RATE_LIMITED', message: 'Too fast' });
      return;
    }

    if (!data?.content || typeof data.content !== 'string') return;
    if (data.content.trim().length > 500) return;

    // Broadcast with display_name but WITHOUT account code
    const displayName = socket.displayName || 'Ghost';
    io.emit('world_message', {
      id: uuidv4(),
      content: data.content.trim(),
      display_name: displayName,
      ts: Date.now(),
    });
  });

  // ── Group message relay ───────────────────────────────────────────────────
  socket.on('group_message', (data) => {
    if (!socketRateLimit(socket.id, 'group_message', 10, 10000)) {
      socket.emit('error', { code: 'RATE_LIMITED' });
      return;
    }

    if (!data?.groupId || !data?.content || typeof data.content !== 'string') return;
    if (data.content.trim().length > 2000) return;

    socket.to(`group:${data.groupId}`).emit('group_message', {
      id: uuidv4(),
      groupId: data.groupId,
      content: data.content.trim(),
      senderAlias: data.senderAlias, // HMAC alias, not real code
      selfDestructSeconds: data.selfDestructSeconds || null,
      ts: Date.now(),
    });
  });

  // ── Join group room ───────────────────────────────────────────────────────
  socket.on('join_group', (groupId) => {
    if (typeof groupId === 'number' || typeof groupId === 'string') {
      socket.join(`group:${groupId}`);
    }
  });

  // ── Typing indicators (ephemeral, never stored) ───────────────────────────
  socket.on('typing_start', (data) => {
    if (!data?.recipientCode) return;
    const recipientSocketId = onlineUsers.get(data.recipientCode);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typing_start', { from: accountCode });
    }
  });

  socket.on('typing_stop', (data) => {
    if (!data?.recipientCode) return;
    const recipientSocketId = onlineUsers.get(data.recipientCode);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typing_stop', { from: accountCode });
    }
  });

  // ── Message recall ────────────────────────────────────────────────────────
  socket.on('recall_message', (data) => {
    if (!data?.messageId || !data?.recipientCode) return;
    const recipientSocketId = onlineUsers.get(data.recipientCode);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('message_recalled', { messageId: data.messageId });
    }
  });

  // ── Delivery receipts ─────────────────────────────────────────────────────
  socket.on('message_delivered', (data) => {
    if (!data?.messageId || !data?.senderCode) return;
    const senderSocketId = onlineUsers.get(data.senderCode);
    if (senderSocketId) {
      io.to(senderSocketId).emit('delivery_receipt', {
        messageId: data.messageId,
        status: 'delivered',
      });
    }
  });

  socket.on('message_seen', (data) => {
    if (!data?.messageId || !data?.senderCode) return;
    const senderSocketId = onlineUsers.get(data.senderCode);
    if (senderSocketId) {
      io.to(senderSocketId).emit('delivery_receipt', {
        messageId: data.messageId,
        status: 'seen',
      });
      // Status auto-clears on sender side after display
    }
  });

  // ── Panic wipe signal ─────────────────────────────────────────────────────
  socket.on('panic', () => {
    // Signal other sessions of this account to wipe
    socket.broadcast.emit(`panic:${accountCode}`);
    socket.disconnect();
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (onlineUsers.get(accountCode) === socket.id) {
      onlineUsers.delete(accountCode);
    }
    // Clean up rate limit state
    for (const key of socketRateLimits.keys()) {
      if (key.startsWith(socket.id)) socketRateLimits.delete(key);
    }
    socket.broadcast.emit('user_offline', { accountCode });
  });
});

// ── Express middleware ───────────────────────────────────────────────────────
app.set('trust proxy', 1);

// Security headers with proper CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", ALLOWED_ORIGIN],
      mediaSrc: ["'self'", 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  permissionsPolicy: {
    features: {
      camera: [],
      geolocation: [],
      microphone: ["'self'"], // needed for voice messages
    },
  },
}));

app.use(cors({
  origin: ALLOWED_ORIGIN,
  credentials: true,
}));

app.use(express.json({ limit: '4mb' }));

// Global rate limiter
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));

// Tighter rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts' },
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth', authLimiter, authRoutes);
app.use('/messages', messageRoutes);
app.use('/friends', friendRoutes);
app.use('/world', worldRoutes);
app.use('/groups', groupRoutes);
app.use('/admin', adminRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Cleanup job: delete expired self-destruct messages ───────────────────────
setInterval(async () => {
  try {
    await db.query(
      `DELETE FROM group_messages WHERE self_destruct_at IS NOT NULL AND self_destruct_at < NOW()`
    );
    await db.query(
      `DELETE FROM world_messages WHERE created_at < NOW() - INTERVAL '48 hours'`
    );
    // Auto-delete inactive groups
    await db.query(
      `DELETE FROM groups WHERE self_destruct_days IS NOT NULL 
       AND created_at < NOW() - (self_destruct_days || ' days')::interval`
    );
  } catch (err) {
    console.error('Cleanup job error:', err);
  }
}, 60 * 60 * 1000); // Every hour

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Ghost Chat server running on port ${PORT}`);
});

export { io, onlineUsers };
