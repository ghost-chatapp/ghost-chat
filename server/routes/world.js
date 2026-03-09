import { Router } from 'express';
import db from '../db.js';
import redis from '../redis.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

const MAX_MSG_LENGTH = 500;

// ── GET /world ────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, content, created_at
       FROM world_messages
       WHERE created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 100`
    );
    // Note: account_code intentionally excluded from response
    res.json({ messages: result.rows.reverse() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// ── POST /world ───────────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing content' });
    }

    const trimmed = content.trim();
    if (!trimmed.length || trimmed.length > MAX_MSG_LENGTH) {
      return res.status(400).json({ error: `Message must be 1-${MAX_MSG_LENGTH} characters` });
    }

    // Rate limit: 1 message per 3 seconds per account
    const ratKey = `world_rate:${req.user.accountCode}`;
    const recent = await redis.get(ratKey);
    if (recent) return res.status(429).json({ error: 'Slow down' });
    await redis.setex(ratKey, 3, '1');

    const result = await db.query(
      `INSERT INTO world_messages (account_code, content, created_at)
       VALUES ($1, $2, NOW())
       RETURNING id, content, created_at`,
      [req.user.accountCode, trimmed]
    );

    // Return without account_code
    res.status(201).json({ message: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── POST /world/report/:id ────────────────────────────────────────────────────
router.post('/report/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!id || isNaN(parseInt(id))) return res.status(400).json({ error: 'Invalid message ID' });

    // Rate limit reports: 5 per hour
    const key = `report_rate:${req.user.accountCode}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 3600);
    if (count > 5) return res.status(429).json({ error: 'Too many reports' });

    // Check message exists
    const msg = await db.query('SELECT id FROM world_messages WHERE id = $1', [parseInt(id)]);
    if (!msg.rows.length) return res.status(404).json({ error: 'Message not found' });

    // Deduplication
    const dupKey = `report_dup:${req.user.accountCode}:${id}`;
    const already = await redis.get(dupKey);
    if (already) return res.status(409).json({ error: 'Already reported' });
    await redis.setex(dupKey, 86400, '1');

    await db.query(
      `INSERT INTO reports (reporter_code, target_id, target_type, reason, created_at)
       VALUES ($1, $2, 'world_message', $3, NOW())`,
      [req.user.accountCode, parseInt(id), reason?.slice(0, 500) || null]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Report failed' });
  }
});

export default router;
