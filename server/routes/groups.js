import { Router } from 'express';
import { randomBytes } from 'crypto';
import db from '../db.js';
import redis from '../redis.js';
import { hmacHash } from '../hmac.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

const MAX_MSG_LENGTH = 2000;
const MAX_GROUP_MEMBERS = 50;

function generateGroupCode() {
  return randomBytes(6).toString('base64url');
}

// ── POST /groups ──────────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, anonymousMode, selfDestructDays, maxMembers } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length > 50) {
      return res.status(400).json({ error: 'Group name must be 1-50 characters' });
    }

    const code = generateGroupCode();
    const result = await db.query(
      `INSERT INTO groups (name, invite_code, creator_code, anonymous_mode, self_destruct_days, max_members, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id, invite_code`,
      [
        name.trim(),
        code,
        req.user.accountCode,
        anonymousMode || false,
        selfDestructDays ? Math.min(selfDestructDays, 365) : null,
        maxMembers ? Math.min(maxMembers, MAX_GROUP_MEMBERS) : MAX_GROUP_MEMBERS,
      ]
    );

    // Add creator as member
    const memberAlias = hmacHash(req.user.accountCode + result.rows[0].id).slice(0, 8);
    await db.query(
      `INSERT INTO group_members (group_id, account_code, member_alias, joined_at)
       VALUES ($1, $2, $3, NOW())`,
      [result.rows[0].id, req.user.accountCode, memberAlias]
    );

    res.status(201).json({ groupId: result.rows[0].id, inviteCode: result.rows[0].invite_code });
  } catch (err) {
    console.error('Create group error:', err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// ── POST /groups/join ─────────────────────────────────────────────────────────
router.post('/join', authenticate, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ error: 'Missing invite code' });

    const group = await db.query(
      'SELECT * FROM groups WHERE invite_code = $1 AND (expires_at IS NULL OR expires_at > NOW())',
      [inviteCode]
    );

    if (!group.rows[0]) return res.status(404).json({ error: 'Group not found or invite expired' });

    const g = group.rows[0];

    // Check member count
    const memberCount = await db.query(
      'SELECT COUNT(*) FROM group_members WHERE group_id = $1',
      [g.id]
    );
    if (parseInt(memberCount.rows[0].count) >= g.max_members) {
      return res.status(403).json({ error: 'Group is full' });
    }

    // Check if already member
    const existing = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND account_code = $2',
      [g.id, req.user.accountCode]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'Already a member' });

    const memberAlias = hmacHash(req.user.accountCode + g.id).slice(0, 8);
    await db.query(
      `INSERT INTO group_members (group_id, account_code, member_alias, joined_at)
       VALUES ($1, $2, $3, NOW())`,
      [g.id, req.user.accountCode, memberAlias]
    );

    res.json({ ok: true, groupId: g.id, groupName: g.name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to join group' });
  }
});

// ── GET /groups/:groupId/messages ─────────────────────────────────────────────
router.get('/:groupId/messages', authenticate, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);

    // Verify membership
    const member = await db.query(
      'SELECT member_alias FROM group_members WHERE group_id = $1 AND account_code = $2',
      [groupId, req.user.accountCode]
    );
    if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });

    const group = await db.query('SELECT anonymous_mode FROM groups WHERE id = $1', [groupId]);

    const result = await db.query(
      `SELECT gm.id, gm.content, gm.created_at, gm.self_destruct_at,
              ${group.rows[0]?.anonymous_mode
                ? `mem.member_alias AS sender`
                : `mem.member_alias AS sender`
              }
       FROM group_messages gm
       JOIN group_members mem ON gm.sender_code = mem.account_code AND mem.group_id = $1
       WHERE gm.group_id = $1
         AND (gm.self_destruct_at IS NULL OR gm.self_destruct_at > NOW())
       ORDER BY gm.created_at DESC
       LIMIT 100`,
      [groupId]
    );

    // Never expose account_code, only alias
    res.json({ messages: result.rows.reverse() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// ── POST /groups/:groupId/messages ────────────────────────────────────────────
router.post('/:groupId/messages', authenticate, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { content, selfDestructSeconds } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing content' });
    }

    const trimmed = content.trim();
    if (!trimmed.length || trimmed.length > MAX_MSG_LENGTH) {
      return res.status(400).json({ error: `Message must be 1-${MAX_MSG_LENGTH} characters` });
    }

    // Verify membership
    const member = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND account_code = $2',
      [groupId, req.user.accountCode]
    );
    if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });

    // Rate limit
    const ratKey = `grp_rate:${req.user.accountCode}:${groupId}`;
    const recent = await redis.get(ratKey);
    if (recent) return res.status(429).json({ error: 'Slow down' });
    await redis.setex(ratKey, 2, '1');

    const selfDestructAt = selfDestructSeconds
      ? new Date(Date.now() + Math.min(selfDestructSeconds, 86400) * 1000)
      : null;

    const result = await db.query(
      `INSERT INTO group_messages (group_id, sender_code, content, self_destruct_at, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, content, created_at, self_destruct_at`,
      [groupId, req.user.accountCode, trimmed, selfDestructAt]
    );

    res.status(201).json({ message: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── DELETE /groups/:groupId/leave ─────────────────────────────────────────────
router.delete('/:groupId/leave', authenticate, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    await db.query(
      'DELETE FROM group_members WHERE group_id = $1 AND account_code = $2',
      [groupId, req.user.accountCode]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to leave group' });
  }
});

export default router;
