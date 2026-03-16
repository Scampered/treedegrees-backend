// src/routes/users.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── PATCH /api/users/profile ──────────────────────────────────────────────────
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { bio, city, country, latitude, longitude, isPublic, connectionsPublic } = req.body;

    const { rows } = await pool.query(
      `UPDATE users SET
        bio = COALESCE($1, bio),
        city = COALESCE($2, city),
        country = COALESCE($3, country),
        latitude = COALESCE($4, latitude),
        longitude = COALESCE($5, longitude),
        is_public = COALESCE($6, is_public),
        connections_public = COALESCE($7, connections_public)
       WHERE id = $8 AND deleted_at IS NULL
       RETURNING id, full_name, bio, city, country, latitude, longitude, is_public, connections_public`,
      [bio, city, country, latitude, longitude, isPublic, connectionsPublic, req.user.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const u = rows[0];
    res.json({
      id: u.id, fullName: u.full_name, bio: u.bio,
      city: u.city, country: u.country,
      latitude: u.latitude, longitude: u.longitude,
      isPublic: u.is_public, connectionsPublic: u.connections_public,
    });
  } catch (err) {
    console.error('Update profile error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/users/daily-note ────────────────────────────────────────────────
// One update per 24 hours — enforced SERVER-SIDE
router.post('/daily-note', requireAuth, async (req, res) => {
  try {
    const { note } = req.body;
    if (!note || note.trim().length === 0) {
      return res.status(400).json({ error: 'Note cannot be empty' });
    }
    if (note.length > 280) {
      return res.status(400).json({ error: 'Note must be 280 characters or less' });
    }

    // Check last update time
    const { rows } = await pool.query(
      'SELECT daily_note_updated_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const lastUpdate = rows[0].daily_note_updated_at;
    if (lastUpdate) {
      const hoursSince = (Date.now() - new Date(lastUpdate).getTime()) / 36e5;
      if (hoursSince < 24) {
        const hoursLeft = (24 - hoursSince).toFixed(1);
        return res.status(429).json({
          error: `You can post again in ${hoursLeft} hours`,
          hoursLeft: parseFloat(hoursLeft),
        });
      }
    }

    const updated = await pool.query(
      `UPDATE users SET daily_note = $1, daily_note_updated_at = NOW()
       WHERE id = $2
       RETURNING daily_note, daily_note_updated_at`,
      [note.trim(), req.user.id]
    );

    res.json({
      dailyNote: updated.rows[0].daily_note,
      dailyNoteUpdatedAt: updated.rows[0].daily_note_updated_at,
    });
  } catch (err) {
    console.error('Daily note error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/users/feed ───────────────────────────────────────────────────────
// Daily notes from accepted friends (public only)
router.get('/feed', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.city, u.country, u.daily_note, u.daily_note_updated_at
       FROM friendships f
       JOIN users u ON (
         CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END = u.id
       )
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1)
         AND f.status = 'accepted'
         AND u.deleted_at IS NULL
         AND u.is_public = true
         AND u.daily_note IS NOT NULL
         AND u.daily_note_updated_at > NOW() - INTERVAL '48 hours'
       ORDER BY u.daily_note_updated_at DESC`,
      [req.user.id]
    );

    res.json(rows.map(u => ({
      id: u.id,
      fullName: u.full_name,
      city: u.city,
      country: u.country,
      note: u.daily_note,
      postedAt: u.daily_note_updated_at,
    })));
  } catch (err) {
    console.error('Feed error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
