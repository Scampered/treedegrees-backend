// src/routes/nicknames.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── GET /api/nicknames — all nicknames the viewer has set ────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cn.target_id, cn.nickname,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS their_name
       FROM connection_nicknames cn
       JOIN users u ON cn.target_id = u.id
       WHERE cn.creator_id = $1`,
      [req.user.id]
    );
    res.json(rows.map(r => ({
      targetId: r.target_id,
      nickname: r.nickname,
      theirName: r.their_name,
    })));
  } catch (err) {
    console.error('Get nicknames error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/nicknames/:targetId — create or update ──────────────────────────
router.put('/:targetId', requireAuth, async (req, res) => {
  try {
    const { nickname } = req.body;
    if (!nickname || !nickname.trim()) {
      return res.status(400).json({ error: 'Nickname cannot be empty' });
    }
    if (nickname.trim().length > 50) {
      return res.status(400).json({ error: 'Nickname too long (max 50 chars)' });
    }
    if (req.params.targetId === req.user.id) {
      return res.status(400).json({ error: 'Cannot nickname yourself' });
    }

    // Must be a direct accepted friend
    const [uid1, uid2] = [req.user.id, req.params.targetId].sort();
    const check = await pool.query(
      `SELECT id FROM friendships
       WHERE user_id_1 = $1 AND user_id_2 = $2 AND status = 'accepted'`,
      [uid1, uid2]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'You can only nickname direct connections' });
    }

    await pool.query(
      `INSERT INTO connection_nicknames (creator_id, target_id, nickname)
       VALUES ($1, $2, $3)
       ON CONFLICT (creator_id, target_id)
       DO UPDATE SET nickname = $3, updated_at = NOW()`,
      [req.user.id, req.params.targetId, nickname.trim()]
    );

    res.json({ message: 'Nickname saved', nickname: nickname.trim() });
  } catch (err) {
    console.error('Set nickname error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/nicknames/:targetId ──────────────────────────────────────────
router.delete('/:targetId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM connection_nicknames WHERE creator_id = $1 AND target_id = $2`,
      [req.user.id, req.params.targetId]
    );
    res.json({ message: 'Nickname removed' });
  } catch (err) {
    console.error('Delete nickname error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
