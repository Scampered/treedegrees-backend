// src/middleware/admin.js
import pool from '../db/pool.js';

export async function requireAdmin(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT is_admin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    if (rows.length === 0 || !rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    console.error('Admin check error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
}
