// src/routes/admin.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';

const router = Router();
// All admin routes require both JWT auth AND admin flag
router.use(requireAuth, requireAdmin);

// ── Helper: log admin action ──────────────────────────────────────────────────
async function logAction(adminId, action, targetId, details) {
  await pool.query(
    `INSERT INTO admin_log (admin_id, action, target_id, details)
     VALUES ($1, $2, $3, $4)`,
    [adminId, action, targetId || null, details || null]
  ).catch(err => console.error('Log error:', err.message));
}

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { search = '', page = 1 } = req.query;
    const limit = 30;
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `SELECT
        id, full_name, nickname, email, city, country,
        is_public, is_admin, deleted_at, created_at,
        (SELECT COUNT(*) FROM friendships f
         WHERE (f.user_id_1 = u.id OR f.user_id_2 = u.id) AND f.status = 'accepted') AS connection_count,
        (SELECT COUNT(*) FROM letters l WHERE l.sender_id = u.id) AS letter_count
       FROM users u
       WHERE deleted_at IS NULL
         AND ($1 = '' OR full_name ILIKE $1 OR nickname ILIKE $1 OR email ILIKE $1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [`%${search}%`, limit, offset]
    );

    const { rows: [{ total }] } = await pool.query(
      `SELECT COUNT(*) AS total FROM users WHERE deleted_at IS NULL
       AND ($1 = '' OR full_name ILIKE $1 OR nickname ILIKE $1 OR email ILIKE $1)`,
      [`%${search}%`]
    );

    res.json({
      users: rows.map(u => ({
        id: u.id,
        fullName: u.full_name,
        nickname: u.nickname,
        email: u.email,
        city: u.city,
        country: u.country,
        isPublic: u.is_public,
        isAdmin: u.is_admin,
        connectionCount: parseInt(u.connection_count),
        letterCount: parseInt(u.letter_count),
        createdAt: u.created_at,
      })),
      total: parseInt(total),
      page: parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('Admin users error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/admin/users/:id — edit any user's profile ─────────────────────
router.patch('/users/:id', async (req, res) => {
  try {
    const { fullName, nickname, bio, city, country, latitude, longitude } = req.body;

    const { rows } = await pool.query(
      `UPDATE users SET
        full_name = COALESCE($1, full_name),
        nickname  = COALESCE($2, nickname),
        bio       = COALESCE($3, bio),
        city      = COALESCE($4, city),
        country   = COALESCE($5, country),
        latitude  = COALESCE($6, latitude),
        longitude = COALESCE($7, longitude)
       WHERE id = $8 AND deleted_at IS NULL
       RETURNING id, full_name, nickname, email, city, country`,
      [fullName||null, nickname||null, bio||null, city||null, country||null,
       latitude||null, longitude||null, req.params.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await logAction(req.user.id, 'edit_user', req.params.id,
      JSON.stringify({ fullName, nickname, bio, city, country }));

    res.json({ message: 'User updated', user: rows[0] });
  } catch (err) {
    console.error('Admin edit user error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/admin/users/:id — soft delete/ban ─────────────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Cannot delete your own admin account' });

    await pool.query(
      `UPDATE users SET
        deleted_at = NOW(),
        email = 'banned_' || id || '@treedegrees.banned',
        full_name = '[Banned User]', nickname = '[Banned]',
        password_hash = '', bio = NULL, daily_note = NULL
       WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );

    await logAction(req.user.id, 'ban_user', req.params.id, 'User banned by admin');
    res.json({ message: 'User banned' });
  } catch (err) {
    console.error('Admin ban error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/admin/maintenance ────────────────────────────────────────────────
router.get('/maintenance', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM page_maintenance ORDER BY page_key');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/admin/maintenance/:page ───────────────────────────────────────
router.patch('/maintenance/:page', async (req, res) => {
  try {
    const { isDown, message } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO page_maintenance (page_key, is_down, message, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (page_key) DO UPDATE SET
         is_down = $2,
         message = COALESCE($3, page_maintenance.message),
         updated_at = NOW()
       RETURNING *`,
      [req.params.page, isDown, message || null]
    );
    await logAction(req.user.id, isDown ? 'page_down' : 'page_up',
      null, `${req.params.page} maintenance=${isDown}`);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS total_users,
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at > NOW() - INTERVAL '7 days') AS new_users_week,
        (SELECT COUNT(*) FROM friendships WHERE status = 'accepted') AS total_connections,
        (SELECT COUNT(*) FROM letters) AS total_letters,
        (SELECT COUNT(*) FROM letters WHERE sent_at > NOW() - INTERVAL '24 hours') AS letters_today,
        (SELECT COUNT(*) FROM letters WHERE arrives_at > NOW()) AS letters_in_transit,
        (SELECT COUNT(*) FROM users WHERE daily_note IS NOT NULL AND daily_note_updated_at > NOW() - INTERVAL '24 hours' AND deleted_at IS NULL) AS notes_today
    `);
    res.json({
      totalUsers:       parseInt(stats.total_users),
      newUsersWeek:     parseInt(stats.new_users_week),
      totalConnections: parseInt(stats.total_connections),
      totalLetters:     parseInt(stats.total_letters),
      lettersToday:     parseInt(stats.letters_today),
      lettersInTransit: parseInt(stats.letters_in_transit),
      notesToday:       parseInt(stats.notes_today),
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/admin/log ────────────────────────────────────────────────────────
router.get('/log', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT al.*, COALESCE(u.nickname, u.full_name) AS admin_name
       FROM admin_log al
       LEFT JOIN users u ON al.admin_id = u.id
       ORDER BY al.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/admin/me — check if current user is admin ───────────────────────
// (this route doesn't go through requireAdmin since it's used to check)
export async function checkAdmin(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT is_admin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    res.json({ isAdmin: rows[0]?.is_admin || false });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

export default router;
