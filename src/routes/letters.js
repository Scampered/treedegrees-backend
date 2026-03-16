// src/routes/letters.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getVehicleTier, haversineKm, calcDeliveryMs,
  calculateEffectiveStreak, VEHICLE_TIERS, nextVehicleMilestone, formatDuration,
} from '../utils/letters.js';

const router = Router();

// ── Helper: get or create streak record for a pair ────────────────────────────
async function getStreak(client, uid1, uid2) {
  const [u1, u2] = [uid1, uid2].sort();
  const { rows } = await client.query(
    `SELECT * FROM letter_streaks WHERE user_id_1 = $1 AND user_id_2 = $2`,
    [u1, u2]
  );
  if (rows.length === 0) return null;
  return rows[0];
}

async function upsertStreak(client, u1, u2, data) {
  await client.query(
    `INSERT INTO letter_streaks (user_id_1, user_id_2, streak_days, fuel, last_day_processed, user1_sent_today, user2_sent_today)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id_1, user_id_2) DO UPDATE SET
       streak_days      = $3,
       fuel             = $4,
       last_day_processed = $5,
       user1_sent_today = $6,
       user2_sent_today = $7`,
    [u1, u2, data.streak_days, data.fuel, data.last_day_processed,
     data.user1_sent_today, data.user2_sent_today]
  );
}

// ── POST /api/letters — send a letter ────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { recipientId, content } = req.body;
    if (!recipientId || !content?.trim()) {
      return res.status(400).json({ error: 'Recipient and content are required' });
    }
    if (content.trim().length > 500) {
      return res.status(400).json({ error: 'Letters are 500 characters max' });
    }

    // Must be a direct friend
    const [uid1, uid2] = [req.user.id, recipientId].sort();
    const friendCheck = await client.query(
      `SELECT id FROM friendships WHERE user_id_1 = $1 AND user_id_2 = $2 AND status = 'accepted'`,
      [uid1, uid2]
    );
    if (friendCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You can only send letters to direct connections' });
    }

    // Get sender and recipient coordinates
    const { rows: users } = await client.query(
      `SELECT id, latitude, longitude, city, country,
              COALESCE(nickname, split_part(full_name,' ',1)) AS display_name
       FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [[req.user.id, recipientId]]
    );
    const sender    = users.find(u => u.id === req.user.id);
    const recipient = users.find(u => u.id === recipientId);

    if (!sender?.latitude || !recipient?.latitude) {
      return res.status(400).json({ error: 'Both users need location data set to send letters' });
    }

    // Get current streak (lazy calculated)
    const raw = await getStreak(client, req.user.id, recipientId);
    const streak = calculateEffectiveStreak(raw);
    const tier = getVehicleTier(streak.streak_days);
    const distKm = haversineKm(sender.latitude, sender.longitude, recipient.latitude, recipient.longitude);
    const deliveryMs = calcDeliveryMs(distKm, tier);
    const arrivesAt = new Date(Date.now() + deliveryMs);

    // Insert letter
    const { rows: [letter] } = await client.query(
      `INSERT INTO letters (sender_id, recipient_id, content, vehicle_tier, arrives_at, streak_at_send)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, sent_at, arrives_at, vehicle_tier`,
      [req.user.id, recipientId, content.trim(), tier, arrivesAt, streak.streak_days]
    );

    // Update streak: mark sender as "sent today", fuel +1 for recipient
    const today = new Date().toISOString().split('T')[0];
    const isUser1 = req.user.id === uid1;
    const newFuel = Math.min(3, (streak.fuel || 0) + 1);
    const updatedStreak = {
      streak_days: streak.streak_days,
      fuel: newFuel,
      last_day_processed: today,
      user1_sent_today: isUser1 ? true : (streak.user1_sent_today || false),
      user2_sent_today: !isUser1 ? true : (streak.user2_sent_today || false),
    };
    await upsertStreak(client, uid1, uid2, updatedStreak);

    res.status(201).json({
      id: letter.id,
      sentAt: letter.sent_at,
      arrivesAt: letter.arrives_at,
      vehicleTier: letter.vehicle_tier,
      vehicleEmoji: VEHICLE_TIERS[tier].emoji,
      deliveryTime: formatDuration(deliveryMs),
      distanceKm: Math.round(distKm),
      recipient: { id: recipient.id, displayName: recipient.display_name, city: recipient.city },
      streak: { days: updatedStreak.streak_days, fuel: newFuel, tier },
    });
  } catch (err) {
    console.error('Send letter error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── GET /api/letters — inbox + outbox ─────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        l.id, l.content, l.vehicle_tier, l.sent_at, l.arrives_at, l.opened_at,
        l.sender_id, l.recipient_id,
        COALESCE(su.nickname, split_part(su.full_name,' ',1)) AS sender_name,
        COALESCE(ru.nickname, split_part(ru.full_name,' ',1)) AS recipient_name
       FROM letters l
       JOIN users su ON l.sender_id = su.id
       JOIN users ru ON l.recipient_id = ru.id
       WHERE l.sender_id = $1 OR l.recipient_id = $1
       ORDER BY l.sent_at DESC
       LIMIT 200`,
      [req.user.id]
    );

    res.json(rows.map(l => ({
      id: l.id,
      content: l.arrives_at > new Date() ? null : l.content, // hide content until arrived
      vehicleTier: l.vehicle_tier,
      vehicleEmoji: VEHICLE_TIERS[l.vehicle_tier]?.emoji || '🚗',
      sentAt: l.sent_at,
      arrivesAt: l.arrives_at,
      openedAt: l.opened_at,
      inTransit: l.arrives_at > new Date(),
      isInbox: l.recipient_id === req.user.id,
      senderId: l.sender_id,
      recipientId: l.recipient_id,
      senderName: l.sender_name,
      recipientName: l.recipient_name,
    })));
  } catch (err) {
    console.error('Get letters error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/letters/in-transit — for map animation ──────────────────────────
router.get('/in-transit', requireAuth, async (req, res) => {
  try {
    // Show letters involving the viewer or their direct connections
    const { rows } = await pool.query(
      `SELECT
        l.id, l.vehicle_tier, l.sent_at, l.arrives_at,
        l.sender_id, l.recipient_id,
        COALESCE(su.nickname, split_part(su.full_name,' ',1)) AS sender_name,
        su.latitude AS sender_lat, su.longitude AS sender_lon,
        ru.latitude AS recipient_lat, ru.longitude AS recipient_lon
       FROM letters l
       JOIN users su ON l.sender_id = su.id
       JOIN users ru ON l.recipient_id = ru.id
       WHERE l.arrives_at > NOW()
         AND (l.sender_id = $1 OR l.recipient_id = $1
           OR l.sender_id IN (
             SELECT CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END
             FROM friendships f WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1) AND f.status = 'accepted'
           )
         )`,
      [req.user.id]
    );

    res.json(rows.map(l => ({
      id: l.id,
      vehicleTier: l.vehicle_tier,
      vehicleEmoji: VEHICLE_TIERS[l.vehicle_tier]?.emoji || '🚗',
      sentAt: l.sent_at,
      arrivesAt: l.arrives_at,
      senderId: l.sender_id,
      recipientId: l.recipient_id,
      senderName: l.sender_name,
      senderLat: l.sender_lat,
      senderLon: l.sender_lon,
      recipientLat: l.recipient_lat,
      recipientLon: l.recipient_lon,
    })));
  } catch (err) {
    console.error('In-transit error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/letters/streaks — all streak data with direct connections ─────────
router.get('/streaks', requireAuth, async (req, res) => {
  try {
    // Get all direct friends
    const { rows: friends } = await pool.query(
      `SELECT
        CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END AS friend_id,
        COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS display_name
       FROM friendships f
       JOIN users u ON (CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END = u.id)
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1) AND f.status = 'accepted' AND u.deleted_at IS NULL`,
      [req.user.id]
    );

    const client = await pool.connect();
    const results = [];
    try {
      for (const friend of friends) {
        const raw = await getStreak(client, req.user.id, friend.friend_id);
        const streak = calculateEffectiveStreak(raw);
        // Write back if dirty
        if (streak._dirty) {
          const [u1, u2] = [req.user.id, friend.friend_id].sort();
          await upsertStreak(client, u1, u2, streak);
        }
        const tier = getVehicleTier(streak.streak_days);
        results.push({
          friendId: friend.friend_id,
          displayName: friend.display_name,
          streakDays: streak.streak_days,
          fuel: streak.fuel,
          tier,
          tierLabel: VEHICLE_TIERS[tier].label,
          tierEmoji: VEHICLE_TIERS[tier].emoji,
          nextMilestone: nextVehicleMilestone(streak.streak_days),
        });
      }
    } finally {
      client.release();
    }

    res.json(results);
  } catch (err) {
    console.error('Streaks error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/letters/:id/open ───────────────────────────────────────────────
router.patch('/:id/open', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE letters SET opened_at = NOW()
       WHERE id = $1 AND recipient_id = $2 AND arrives_at <= NOW() AND opened_at IS NULL
       RETURNING id, opened_at`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Letter not found or not yet arrived' });
    res.json({ openedAt: rows[0].opened_at });
  } catch (err) {
    console.error('Open letter error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
