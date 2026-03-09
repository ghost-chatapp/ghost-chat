import { Router } from 'express';
import validator from 'validator';
import db from '../db.js';
import redis from '../redis.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// ── GET /friends ──────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
         CASE WHEN account_code_1 = $1 THEN account_code_2 ELSE account_code_1 END AS account_code,
         status,
         created_at
       FROM friends
       WHERE (account_code_1 = $1 OR account_code_2 = $1)
         AND status = 'accepted'`,
      [req.user.accountCode]
    );
    res.json({ friends: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get friends' });
  }
});

// ── POST /friends/add ─────────────────────────────────────────────────────────
router.post('/add', authenticate, async (req, res) => {
  try {
    const { friendCode } = req.body;

    if (!friendCode || typeof friendCode !== 'string') {
      return res.status(400).json({ error: 'Invalid friend code' });
    }

    // Rate limit friend requests
    const key = `friend_req:${req.user.accountCode}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 3600);
    if (count > 20) return res.status(429).json({ error: 'Too many friend requests' });

    // Find account by friend_code
    const target = await db.query(
      'SELECT account_code FROM accounts WHERE friend_code = $1 AND is_banned = false',
      [friendCode]
    );

    if (!target.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetCode = target.rows[0].account_code;

    if (targetCode === req.user.accountCode) {
      return res.status(400).json({ error: 'Cannot add yourself' });
    }

    // Check if blocked
    const blocked = await db.query(
      `SELECT 1 FROM blocks WHERE blocker = $1 AND blocked = $2`,
      [targetCode, req.user.accountCode]
    );
    if (blocked.rows.length) {
      return res.status(403).json({ error: 'Cannot send request' });
    }

    // Check existing relationship
    const existing = await db.query(
      `SELECT status FROM friends 
       WHERE (account_code_1 = $1 AND account_code_2 = $2)
          OR (account_code_1 = $2 AND account_code_2 = $1)`,
      [req.user.accountCode, targetCode]
    );

    if (existing.rows[0]) {
      return res.status(409).json({ error: `Already ${existing.rows[0].status}` });
    }

    await db.query(
      `INSERT INTO friends (account_code_1, account_code_2, status, created_at)
       VALUES ($1, $2, 'pending', NOW())`,
      [req.user.accountCode, targetCode]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Add friend error:', err);
    res.status(500).json({ error: 'Failed to add friend' });
  }
});

// ── POST /friends/accept ──────────────────────────────────────────────────────
router.post('/accept', authenticate, async (req, res) => {
  try {
    const { requesterCode } = req.body;

    const result = await db.query(
      `UPDATE friends SET status = 'accepted' 
       WHERE account_code_1 = $1 AND account_code_2 = $2 AND status = 'pending'
       RETURNING *`,
      [requesterCode, req.user.accountCode]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Request not found' });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to accept friend request' });
  }
});

// ── DELETE /friends/:friendCode ───────────────────────────────────────────────
router.delete('/:friendCode', authenticate, async (req, res) => {
  try {
    const { friendCode } = req.params;

    await db.query(
      `DELETE FROM friends 
       WHERE (account_code_1 = $1 AND account_code_2 = $2)
          OR (account_code_1 = $2 AND account_code_2 = $1)`,
      [req.user.accountCode, friendCode]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

// ── POST /friends/block ───────────────────────────────────────────────────────
router.post('/block', authenticate, async (req, res) => {
  try {
    const { targetCode } = req.body;
    if (!targetCode) return res.status(400).json({ error: 'Missing target' });

    await db.query(
      `INSERT INTO blocks (blocker, blocked, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT DO NOTHING`,
      [req.user.accountCode, targetCode]
    );

    // Remove friendship if exists
    await db.query(
      `DELETE FROM friends 
       WHERE (account_code_1 = $1 AND account_code_2 = $2)
          OR (account_code_1 = $2 AND account_code_2 = $1)`,
      [req.user.accountCode, targetCode]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Block failed' });
  }
});

// ── GET /friends/pending ──────────────────────────────────────────────────────
router.get('/pending', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT account_code_1 AS requester_code, created_at
       FROM friends
       WHERE account_code_2 = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [req.user.accountCode]
    );
    res.json({ requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get pending requests' });
  }
});

export default router;
