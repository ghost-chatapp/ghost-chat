import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import redis from '../redis.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

const MAX_MESSAGE_LENGTH = 4096;
const MAX_VOICE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

// ── POST /messages/send ──────────────────────────────────────────────────────
// Server ROUTES message to recipient and immediately discards.
// Encrypted payload is never stored server-side.
// Uses Redis as a temporary delivery buffer (TTL 60s) in case recipient is offline.
router.post('/send', authenticate, async (req, res) => {
  try {
    const { recipientCode, encryptedPayload, messageId, selfDestructSeconds } = req.body;

    if (!recipientCode || !encryptedPayload) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (typeof encryptedPayload !== 'string' || encryptedPayload.length > MAX_MESSAGE_LENGTH * 2) {
      return res.status(400).json({ error: 'Payload too large' });
    }

    // Verify recipient exists and is a friend
    const friendResult = await db.query(
      `SELECT 1 FROM friends 
       WHERE ((account_code_1 = $1 AND account_code_2 = $2) 
          OR (account_code_1 = $2 AND account_code_2 = $1))
         AND status = 'accepted'`,
      [req.user.accountCode, recipientCode]
    );

    if (!friendResult.rows.length) {
      return res.status(403).json({ error: 'Not friends' });
    }

    const msgId = messageId || uuidv4();
    const ttl = selfDestructSeconds ? Math.min(selfDestructSeconds + 120, 86400) : 300; // buffer TTL

    // Store temporarily in Redis for delivery
    const envelope = JSON.stringify({
      id: msgId,
      from: req.user.accountCode,
      payload: encryptedPayload, // already E2E encrypted, we can't read it
      selfDestructSeconds: selfDestructSeconds || null,
      ts: Date.now(),
    });

    await redis.lpush(`inbox:${recipientCode}`, envelope);
    await redis.expire(`inbox:${recipientCode}`, ttl);

    // If recipient is online, signal via Socket.IO (handled in index.js)
    res.json({ ok: true, messageId: msgId });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── GET /messages/inbox ──────────────────────────────────────────────────────
// Drain inbox — messages are deleted from server after delivery
router.get('/inbox', authenticate, async (req, res) => {
  try {
    const messages = [];
    let item;

    // Drain entire inbox (up to 100 messages at once)
    for (let i = 0; i < 100; i++) {
      item = await redis.rpop(`inbox:${req.user.accountCode}`);
      if (!item) break;
      try {
        messages.push(typeof item === 'string' ? JSON.parse(item) : item);
      } catch {}
    }

    // Messages are now gone from server. Client stores them in IndexedDB.
    res.json({ messages });
  } catch (err) {
    console.error('Inbox error:', err);
    res.status(500).json({ error: 'Failed to retrieve messages' });
  }
});

// ── POST /messages/voice ─────────────────────────────────────────────────────
// Encrypted voice message — stored temporarily in Redis, deleted after pickup
router.post('/voice', authenticate, async (req, res) => {
  try {
    const { recipientCode, encryptedAudio, duration, messageId } = req.body;

    if (!recipientCode || !encryptedAudio) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    if (encryptedAudio.length > MAX_VOICE_SIZE_BYTES * 1.4) { // base64 overhead
      return res.status(413).json({ error: 'Voice message too large (max 2MB)' });
    }

    // Verify friendship
    const friendResult = await db.query(
      `SELECT 1 FROM friends 
       WHERE ((account_code_1 = $1 AND account_code_2 = $2) 
          OR (account_code_1 = $2 AND account_code_2 = $1))
         AND status = 'accepted'`,
      [req.user.accountCode, recipientCode]
    );

    if (!friendResult.rows.length) {
      return res.status(403).json({ error: 'Not friends' });
    }

    const msgId = messageId || uuidv4();

    const envelope = JSON.stringify({
      id: msgId,
      from: req.user.accountCode,
      type: 'voice',
      payload: encryptedAudio,
      duration: duration || 0,
      ts: Date.now(),
    });

    await redis.lpush(`inbox:${recipientCode}`, envelope);
    await redis.expire(`inbox:${recipientCode}`, 600); // 10 min delivery window

    res.json({ ok: true, messageId: msgId });
  } catch (err) {
    console.error('Voice message error:', err);
    res.status(500).json({ error: 'Failed to send voice message' });
  }
});

// ── POST /messages/recall ────────────────────────────────────────────────────
// Recall a message within 10 seconds (signals recipient client to delete)
router.post('/recall', authenticate, async (req, res) => {
  try {
    const { messageId, recipientCode } = req.body;
    if (!messageId || !recipientCode) return res.status(400).json({ error: 'Missing fields' });

    // Push a recall signal to recipient's inbox
    const recallSignal = JSON.stringify({
      id: uuidv4(),
      type: 'recall',
      targetId: messageId,
      from: req.user.accountCode,
      ts: Date.now(),
    });

    await redis.lpush(`inbox:${recipientCode}`, recallSignal);
    await redis.expire(`inbox:${recipientCode}`, 120);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Recall failed' });
  }
});

export default router;
