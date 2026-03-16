// src/routes/users.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Capital city coordinates used when location privacy hides the exact position
// Extend this map as needed for more countries
const COUNTRY_CAPITALS = {
  'bahrain': [26.2235, 50.5876],      // Manama
  'saudi arabia': [24.6877, 46.7219], // Riyadh
  'united arab emirates': [24.4539, 54.3773], // Abu Dhabi
  'kuwait': [29.3759, 47.9774],
  'qatar': [25.2854, 51.5310],
  'oman': [23.5880, 58.3829],
  'united states': [38.9072, -77.0369],
  'united kingdom': [51.5074, -0.1278],
  'germany': [52.5200, 13.4050],
  'france': [48.8566, 2.3522],
  'japan': [35.6762, 139.6503],
  'china': [39.9042, 116.4074],
  'india': [28.6139, 77.2090],
  'australia': [-35.2809, 149.1300],
  'canada': [45.4215, -75.6972],
  'brazil': [-15.7942, -47.8822],
  'south africa': [-25.7479, 28.2293],
  'nigeria': [9.0765, 7.3986],
  'egypt': [30.0444, 31.2357],
  'turkey': [39.9334, 32.8597],
  'russia': [55.7558, 37.6173],
  'pakistan': [33.7294, 73.0931],
  'indonesia': [-6.2088, 106.8456],
  'malaysia': [3.1390, 101.6869],
  'singapore': [1.3521, 103.8198],
};

function getCapitalCoords(country) {
  const key = (country || '').toLowerCase().trim();
  return COUNTRY_CAPITALS[key] || null;
}

// ── PATCH /api/users/profile ──────────────────────────────────────────────────
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { bio, nickname, city, country, latitude, longitude, isPublic, connectionsPublic, locationPrivacy } = req.body;

    const validPrivacy = ['exact', 'private', 'hidden'];
    const privacyValue = validPrivacy.includes(locationPrivacy) ? locationPrivacy : null;

    const { rows } = await pool.query(
      `UPDATE users SET
        bio = COALESCE($1, bio),
        nickname = COALESCE($2, nickname),
        city = COALESCE($3, city),
        country = COALESCE($4, country),
        latitude = COALESCE($5, latitude),
        longitude = COALESCE($6, longitude),
        is_public = COALESCE($7, is_public),
        connections_public = COALESCE($8, connections_public),
        location_privacy = COALESCE($9, location_privacy)
       WHERE id = $10 AND deleted_at IS NULL
       RETURNING id, full_name, nickname, bio, city, country, latitude, longitude,
                 is_public, connections_public, location_privacy`,
      [bio, nickname || null, city, country, latitude, longitude, isPublic, connectionsPublic, privacyValue, req.user.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    res.json({
      id: u.id, fullName: u.full_name, nickname: u.nickname, bio: u.bio,
      city: u.city, country: u.country,
      latitude: u.latitude, longitude: u.longitude,
      isPublic: u.is_public, connectionsPublic: u.connections_public,
      locationPrivacy: u.location_privacy,
    });
  } catch (err) {
    console.error('Update profile error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/users/daily-note ────────────────────────────────────────────────
router.post('/daily-note', requireAuth, async (req, res) => {
  try {
    const { note } = req.body;
    if (!note || note.trim().length === 0) return res.status(400).json({ error: 'Note cannot be empty' });
    if (note.length > 280) return res.status(400).json({ error: 'Note must be 280 characters or less' });

    const { rows } = await pool.query('SELECT daily_note_updated_at FROM users WHERE id = $1', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const lastUpdate = rows[0].daily_note_updated_at;
    if (lastUpdate) {
      const hoursSince = (Date.now() - new Date(lastUpdate).getTime()) / 36e5;
      if (hoursSince < 24) {
        const hoursLeft = (24 - hoursSince).toFixed(1);
        return res.status(429).json({ error: `You can post again in ${hoursLeft} hours`, hoursLeft: parseFloat(hoursLeft) });
      }
    }

    const updated = await pool.query(
      `UPDATE users SET daily_note = $1, daily_note_updated_at = NOW()
       WHERE id = $2 RETURNING daily_note, daily_note_updated_at`,
      [note.trim(), req.user.id]
    );
    res.json({ dailyNote: updated.rows[0].daily_note, dailyNoteUpdatedAt: updated.rows[0].daily_note_updated_at });
  } catch (err) {
    console.error('Daily note error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/users/feed ───────────────────────────────────────────────────────
router.get('/feed', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.city, u.country, u.daily_note, u.daily_note_updated_at
       FROM friendships f
       JOIN users u ON (CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END = u.id)
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
      id: u.id, fullName: u.full_name, city: u.city, country: u.country,
      note: u.daily_note, postedAt: u.daily_note_updated_at,
    })));
  } catch (err) {
    console.error('Feed error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export { getCapitalCoords };
export default router;
