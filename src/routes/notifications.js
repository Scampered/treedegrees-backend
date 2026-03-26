// src/routes/notifications.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/notifications — fetch grouped/stacked notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT type,
              COUNT(*)::int AS count,
              MAX(created_at) AS latest_at,
              -- pick the most recent title/body/link for the stack
              (array_agg(title ORDER BY created_at DESC))[1] AS title,
              (array_agg(body  ORDER BY created_at DESC))[1] AS body,
              (array_agg(link  ORDER BY created_at DESC))[1] AS link,
              BOOL_OR(NOT read) AS has_unread,
              array_agg(id ORDER BY created_at DESC) AS ids
       FROM notifications
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY type
       ORDER BY MAX(created_at) DESC`,
      [req.user.id]
    );

    const total_unread = rows.filter(r => r.has_unread).length;
    res.json({ notifications: rows, total_unread });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/notifications/read — mark all as read
router.patch('/read', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET read = true WHERE user_id = $1 AND read = false`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/notifications/read/:type — mark one type as read
router.patch('/read/:type', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET read = true WHERE user_id = $1 AND type = $2 AND read = false`,
      [req.user.id, req.params.type]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/notifications — clear all older than 7 days (maintenance)
router.delete('/clear', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM notifications WHERE user_id = $1 AND created_at < NOW() - INTERVAL '7 days'`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

export default router;
