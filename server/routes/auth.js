import { Router } from 'express';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import validator from 'validator';
import db from '../db.js';
import redis from '../redis.js';
import { generateChallenge, verifyPoW } from '../pow.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Cryptographically secure random code generator
function generateCode(bytes = 8) {
  return randomBytes(bytes).toString('base64url');
}

// ── GET /auth/pow-challenge ──────────────────────────────────────────────────
// Returns a PoW challenge the client must solve before registering
router.get('/pow-challenge', async (req, res) => {
  const challenge = generateChallenge();
  // Store challenge server-side to prevent replay
  await redis.setex(`pow:${challenge.challenge}`, 300, '1');
  res.json(challenge);
});

// ── POST /auth/register ──────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { password, powChallenge, powNonce, powTimestamp } = req.body;

    // 1. Verify PoW solution
    const powResult = verifyPoW(powChallenge, powNonce, powTimestamp);
    if (!powResult.valid) {
      return res.status(400).json({ error: powResult.reason });
    }

    // Ensure challenge was issued by us and hasn't been used
    const challengeExists = await redis.get(`pow:${powChallenge}`);
    if (!challengeExists) {
      return res.status(400).json({ error: 'Invalid or expired challenge' });
    }
    // Delete immediately to prevent reuse
    await redis.del(`pow:${powChallenge}`);

    // 2. IP soft limit (3 accounts per IP per week, warning not hard block)
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0];
    const ipKey = `reg:ip:${ip}`;
    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) {
      await redis.expire(ipKey, 7 * 24 * 60 * 60); // 1 week TTL
    }

    let ipWarning = null;
    if (ipCount > 3) {
      ipWarning = 'Multiple accounts detected from this network.';
      // Soft limit: allow but flag. Hard block at 10.
      if (ipCount > 10) {
        return res.status(429).json({ error: 'Too many accounts created from this network.' });
      }
    }

    // 3. Validate password
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // 4. Generate account code and friend code
    const accountCode = generateCode(8);   // unique identifier
    const friendCode = generateCode(6);    // sharable friend code, shorter

    // 5. Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // 6. Insert into DB
    await db.query(
      `INSERT INTO accounts (account_code, friend_code, password_hash, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [accountCode, friendCode, passwordHash]
    );

    // 7. Issue tokens
    const jti = uuidv4();
    const accessToken = jwt.sign(
      { accountCode, jti },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    const refreshToken = jwt.sign(
      { accountCode, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '30d' }
    );

    // Store refresh token hash in Redis
    await redis.setex(`refresh:${accountCode}`, 30 * 24 * 3600, refreshToken);

    res.status(201).json({
      accountCode,
      friendCode,
      accessToken,
      refreshToken,
      warning: ipWarning,
    });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Account code collision, try again' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { accountCode, password } = req.body;

    if (!accountCode || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    // Brute force protection
    const bruteKey = `brute:${accountCode}`;
    const attempts = await redis.get(bruteKey);
    if (attempts && parseInt(attempts) >= 10) {
      return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
    }

    const result = await db.query(
      'SELECT * FROM accounts WHERE account_code = $1 AND is_banned = false',
      [accountCode]
    );

    if (!result.rows[0]) {
      await redis.incr(bruteKey);
      await redis.expire(bruteKey, 900); // 15 min lockout window
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const account = result.rows[0];
    const valid = await bcrypt.compare(password, account.password_hash);

    if (!valid) {
      await redis.incr(bruteKey);
      await redis.expire(bruteKey, 900);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Clear brute force counter on success
    await redis.del(bruteKey);

    // Check decoy password
    if (account.decoy_password_hash) {
      const isDecoy = await bcrypt.compare(password, account.decoy_password_hash);
      if (isDecoy) {
        // Return fake empty state
        return res.json({
          accountCode,
          accessToken: jwt.sign({ accountCode, decoy: true, jti: uuidv4() }, process.env.JWT_SECRET, { expiresIn: '15m' }),
          refreshToken: '',
          decoy: true,
        });
      }
    }

    const jti = uuidv4();
    const accessToken = jwt.sign(
      { accountCode, jti },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    const refreshToken = jwt.sign(
      { accountCode, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '30d' }
    );

    await redis.setex(`refresh:${accountCode}`, 30 * 24 * 3600, refreshToken);

    res.json({ accountCode, accessToken, refreshToken });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /auth/refresh ───────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Missing refresh token' });

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Invalid token type' });

    // Validate stored token
    const stored = await redis.get(`refresh:${decoded.accountCode}`);
    if (stored !== refreshToken) return res.status(401).json({ error: 'Token reuse detected' });

    const jti = uuidv4();
    const accessToken = jwt.sign(
      { accountCode: decoded.accountCode, jti },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({ accessToken });
  } catch (err) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ── POST /auth/logout ────────────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  try {
    // Blacklist the current access token
    const decoded = jwt.decode(req.headers.authorization.slice(7));
    if (decoded?.jti) {
      const ttl = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
      if (ttl > 0) await redis.setex(`blacklist:${decoded.jti}`, ttl, '1');
    }

    // Revoke refresh token
    await redis.del(`refresh:${req.user.accountCode}`);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ── POST /auth/set-public-key ────────────────────────────────────────────────
router.post('/set-public-key', authenticate, async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey || typeof publicKey !== 'string' || publicKey.length > 256) {
      return res.status(400).json({ error: 'Invalid public key' });
    }

    await db.query(
      'UPDATE accounts SET public_key = $1 WHERE account_code = $2',
      [publicKey, req.user.accountCode]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update public key' });
  }
});

// ── GET /auth/public-key/:accountCode ────────────────────────────────────────
router.get('/public-key/:accountCode', authenticate, async (req, res) => {
  try {
    const { accountCode } = req.params;
    const result = await db.query(
      'SELECT public_key FROM accounts WHERE account_code = $1',
      [accountCode]
    );

    if (!result.rows[0]?.public_key) {
      return res.status(404).json({ error: 'Public key not found' });
    }

    res.json({ publicKey: result.rows[0].public_key });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve public key' });
  }
});

// ── POST /auth/set-decoy-password ────────────────────────────────────────────
router.post('/set-decoy-password', authenticate, async (req, res) => {
  try {
    const { decoyPassword } = req.body;
    if (!decoyPassword || decoyPassword.length < 8) {
      return res.status(400).json({ error: 'Decoy password must be at least 8 characters' });
    }

    const hash = await bcrypt.hash(decoyPassword, 12);
    await db.query(
      'UPDATE accounts SET decoy_password_hash = $1 WHERE account_code = $2',
      [hash, req.user.accountCode]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set decoy password' });
  }
});

// ── POST /auth/rotate-keys ───────────────────────────────────────────────────
// Trigger manual key rotation (also auto-triggered every 30 days client-side)
router.post('/rotate-keys', authenticate, async (req, res) => {
  try {
    const { newPublicKey } = req.body;
    if (!newPublicKey) return res.status(400).json({ error: 'Missing new public key' });

    await db.query(
      `UPDATE accounts SET public_key = $1, key_rotated_at = NOW() WHERE account_code = $2`,
      [newPublicKey, req.user.accountCode]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Key rotation failed' });
  }
});

export default router;
