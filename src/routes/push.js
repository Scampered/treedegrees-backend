// src/routes/push.js — Push subscription management
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { savePushSubscription, VAPID_PUBLIC } from '../utils/push.js';
import pool from '../db/pool.js';

const router = Router();

// GET /api/push/vapid-key — frontend needs the public key to subscribe
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC })
})

// POST /api/push/subscribe — save a push subscription
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    await savePushSubscription(req.user.id, req.body)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/push/unsubscribe — remove subscription
router.delete('/unsubscribe', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM push_subscriptions WHERE user_id=$1`, [req.user.id]
    )
    res.json({ ok: true })
  } catch { res.status(500).json({ error: 'Server error' }) }
})

export default router;
