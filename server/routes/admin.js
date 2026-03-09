import { Router } from 'express';
import db from '../db.js';
import { authenticateAdmin } from '../middleware/auth.js';

const router = Router();

// All admin routes require admin secret header
router.use(authenticateAdmin);

// ── GET /admin/stats ──────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [accounts, messages, groups, reports] = await Promise.all([
      db.query('SELECT COUNT(*) FROM accounts'),
      db.query('SELECT COUNT(*) FROM world_messages WHERE created_at > NOW() - INTERVAL \'24 hours\''),
      db.query('SELECT COUNT(*) FROM groups'),
      db.query('SELECT COUNT(*) FROM reports WHERE resolved = false'),
    ]);

    res.json({
      totalAccounts: parseInt(accounts.rows[0].count),
      messagesLast24h: parseInt(messages.rows[0].count),
      totalGroups: parseInt(groups.rows[0].count),
      unresolvedReports: parseInt(reports.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ── GET /admin/reports ────────────────────────────────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, target_id, target_type, reason, created_at
       FROM reports
       WHERE resolved = false
       ORDER BY created_at DESC
       LIMIT 50`
      // reporter_code intentionally excluded from response
    );
    res.json({ reports: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get reports' });
  }
});

// ── POST /admin/ban ───────────────────────────────────────────────────────────
router.post('/ban', async (req, res) => {
  try {
    const { accountCode, reason } = req.body;

    if (!accountCode || typeof accountCode !== 'string' || accountCode.length > 64) {
      return res.status(400).json({ error: 'Invalid account code' });
    }

    const result = await db.query(
      `UPDATE accounts SET is_banned = true, ban_reason = $1 WHERE account_code = $2 AND is_banned = false RETURNING account_code`,
      [reason?.slice(0, 500) || null, accountCode]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Account not found or already banned' });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ban failed' });
  }
});

// ── POST /admin/unban ─────────────────────────────────────────────────────────
router.post('/unban', async (req, res) => {
  try {
    const { accountCode } = req.body;

    if (!accountCode || typeof accountCode !== 'string' || accountCode.length > 64) {
      return res.status(400).json({ error: 'Invalid account code' });
    }

    const result = await db.query(
      `UPDATE accounts SET is_banned = false, ban_reason = null WHERE account_code = $1 AND is_banned = true RETURNING account_code`,
      [accountCode]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Account not found or not banned' });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Unban failed' });
  }
});

// ── POST /admin/resolve-report/:id ────────────────────────────────────────────
router.post('/resolve-report/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid report ID' });

    await db.query(
      'UPDATE reports SET resolved = true, resolved_at = NOW() WHERE id = $1',
      [id]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve report' });
  }
});

export default router;
