// src/routes/friends.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── GET /api/friends ──────────────────────────────────────────────────────────
// List current user's accepted friends
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        u.id, u.full_name, u.city, u.country, u.latitude, u.longitude,
        u.friend_code, u.bio, u.is_public, u.connections_public,
        u.daily_note, u.daily_note_updated_at,
        f.created_at AS connected_since
       FROM friendships f
       JOIN users u ON (
         CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END = u.id
       )
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1)
         AND f.status = 'accepted'
         AND u.deleted_at IS NULL
       ORDER BY u.full_name`,
      [req.user.id]
    );

    res.json(rows.map(u => ({
      id: u.id,
      fullName: u.is_public ? u.full_name : '🔒 Private User',
      city: u.city,
      country: u.country,
      latitude: u.latitude,
      longitude: u.longitude,
      friendCode: u.friend_code,
      bio: u.is_public ? u.bio : null,
      isPublic: u.is_public,
      connectionsPublic: u.connections_public,
      dailyNote: u.is_public ? u.daily_note : null,
      dailyNoteUpdatedAt: u.is_public ? u.daily_note_updated_at : null,
      connectedSince: u.connected_since,
    })));
  } catch (err) {
    console.error('List friends error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/friends/requests ─────────────────────────────────────────────────
// Incoming pending requests
router.get('/requests', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id AS request_id, u.id, u.full_name, u.city, u.country, f.created_at
       FROM friendships f
       JOIN users u ON f.requester_id = u.id
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1)
         AND f.status = 'pending'
         AND f.requester_id != $1
         AND u.deleted_at IS NULL
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );

    res.json(rows.map(r => ({
      requestId: r.request_id,
      user: { id: r.id, fullName: r.full_name, city: r.city, country: r.country },
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error('Requests error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/friends/add ─────────────────────────────────────────────────────
// Add a friend by their unique friend code
router.post('/add', requireAuth, async (req, res) => {
  try {
    const { friendCode } = req.body;
    if (!friendCode) return res.status(400).json({ error: 'Friend code required' });

    // Find target user
    const targetResult = await pool.query(
      'SELECT id, full_name, city, country FROM users WHERE friend_code = $1 AND deleted_at IS NULL',
      [friendCode.toUpperCase().trim()]
    );

    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: 'No user found with that friend code' });
    }

    const target = targetResult.rows[0];
    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot add yourself' });
    }

    // Canonical order for undirected edge
    const [uid1, uid2] = [req.user.id, target.id].sort();

    // Check existing relationship
    const existing = await pool.query(
      'SELECT id, status FROM friendships WHERE user_id_1 = $1 AND user_id_2 = $2',
      [uid1, uid2]
    );

    if (existing.rows.length > 0) {
      const { status } = existing.rows[0];
      if (status === 'accepted') return res.status(409).json({ error: 'Already connected' });
      if (status === 'pending') return res.status(409).json({ error: 'Connection request already sent' });
      if (status === 'blocked') return res.status(403).json({ error: 'Cannot connect with this user' });
    }

    await pool.query(
      `INSERT INTO friendships (user_id_1, user_id_2, status, requester_id)
       VALUES ($1, $2, 'pending', $3)`,
      [uid1, uid2, req.user.id]
    );

    res.status(201).json({
      message: `Connection request sent to ${target.full_name}`,
      target: { id: target.id, fullName: target.full_name, city: target.city, country: target.country },
    });
  } catch (err) {
    console.error('Add friend error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/friends/respond/:requestId ─────────────────────────────────────
// Accept or decline a request
router.patch('/respond/:requestId', requireAuth, async (req, res) => {
  try {
    const { action } = req.body; // 'accept' | 'decline'
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'Action must be accept or decline' });
    }

    const result = await pool.query(
      `SELECT * FROM friendships
       WHERE id = $1 AND (user_id_1 = $2 OR user_id_2 = $2)
         AND status = 'pending' AND requester_id != $2`,
      [req.params.requestId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (action === 'accept') {
      await pool.query("UPDATE friendships SET status = 'accepted' WHERE id = $1", [req.params.requestId]);
      res.json({ message: 'Connection accepted' });
    } else {
      await pool.query('DELETE FROM friendships WHERE id = $1', [req.params.requestId]);
      res.json({ message: 'Connection declined' });
    }
  } catch (err) {
    console.error('Respond error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/friends/:userId ───────────────────────────────────────────────
router.delete('/:userId', requireAuth, async (req, res) => {
  try {
    const [uid1, uid2] = [req.user.id, req.params.userId].sort();
    await pool.query(
      'DELETE FROM friendships WHERE user_id_1 = $1 AND user_id_2 = $2',
      [uid1, uid2]
    );
    res.json({ message: 'Connection removed' });
  } catch (err) {
    console.error('Remove friend error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
