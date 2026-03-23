// src/routes/letters.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getVehicleTier, haversineKm, calcDeliveryMs,
  calculateEffectiveStreak, VEHICLE_TIERS, nextVehicleMilestone, formatDuration,
} from '../utils/letters.js';
import { awardSeeds } from './grove.js';
import { sendPush } from '../utils/push.js';

const router = Router();

async function getStreak(client, uid1, uid2) {
  const [u1, u2] = [uid1, uid2].sort();
  const { rows } = await client.query(
    `SELECT * FROM letter_streaks WHERE user_id_1 = $1 AND user_id_2 = $2`, [u1, u2]
  );
  return rows.length === 0 ? null : rows[0];
}

async function upsertStreak(client, u1, u2, data) {
  await client.query(
    `INSERT INTO letter_streaks (user_id_1, user_id_2, streak_days, fuel, last_day_processed, user1_sent_today, user2_sent_today)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id_1, user_id_2) DO UPDATE SET
       streak_days=$3, fuel=$4, last_day_processed=$5,
       user1_sent_today=$6, user2_sent_today=$7`,
    [u1, u2, data.streak_days, data.fuel, data.last_day_processed,
     data.user1_sent_today, data.user2_sent_today]
  );
}

// Helper: look up all personal nicknames the viewer has set, return a map
async function getMyNicknameMap(viewerId) {
  const { rows } = await pool.query(
    `SELECT target_id, nickname FROM connection_nicknames WHERE creator_id = $1`,
    [viewerId]
  );
  return Object.fromEntries(rows.map(r => [r.target_id, r.nickname]));
}

// Resolve display name for another user, preferring viewer's personal nickname
function resolveDisplayName(userId, ownNickname, myNicknameMap) {
  return myNicknameMap[userId] || ownNickname || '?';
}

// ── POST /api/letters — send a letter ────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { recipientId, content } = req.body;
    if (!recipientId || !content?.trim())
      return res.status(400).json({ error: 'Recipient and content are required' });
    if (content.trim().length > 500)
      return res.status(400).json({ error: 'Letters are 500 characters max' });

    // Must be a direct friend
    const [uid1, uid2] = [req.user.id, recipientId].sort();
    const friendCheck = await client.query(
      `SELECT id FROM friendships WHERE user_id_1=$1 AND user_id_2=$2 AND status='accepted'`,
      [uid1, uid2]
    );
    if (friendCheck.rows.length === 0)
      return res.status(403).json({ error: 'You can only send letters to direct connections' });

    // ONE LETTER IN TRANSIT RULE: block if sender already has a letter in transit to this recipient
    const inTransitCheck = await client.query(
      `SELECT id FROM letters
       WHERE sender_id=$1 AND recipient_id=$2 AND arrives_at > NOW()`,
      [req.user.id, recipientId]
    );
    if (inTransitCheck.rows.length > 0)
      return res.status(409).json({
        error: 'You already have a letter in transit to this person. Wait for it to arrive (or recall it) before sending another.',
        code: 'LETTER_IN_TRANSIT',
      });

    // Get coords
    const { rows: users } = await client.query(
      `SELECT id, latitude, longitude, city, country,
              COALESCE(nickname, split_part(full_name,' ',1)) AS display_name
       FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [[req.user.id, recipientId]]
    );
    const sender    = users.find(u => u.id === req.user.id);
    const recipient = users.find(u => u.id === recipientId);

    if (!sender?.latitude || !recipient?.latitude)
      return res.status(400).json({ error: 'Both users need location data to send letters' });

    const raw    = await getStreak(client, req.user.id, recipientId);
    const streak = calculateEffectiveStreak(raw);
    const tier   = getVehicleTier(streak.streak_days);
    const distKm = haversineKm(
      parseFloat(sender.latitude), parseFloat(sender.longitude),
      parseFloat(recipient.latitude), parseFloat(recipient.longitude)
    );
    const deliveryMs = calcDeliveryMs(distKm, tier);
    const arrivesAt  = new Date(Date.now() + deliveryMs);
    // Letters expire 7 days after arrival
    const expiresAt  = new Date(arrivesAt.getTime() + 7 * 24 * 3600 * 1000);

    const { rows: [letter] } = await client.query(
      `INSERT INTO letters (sender_id, recipient_id, content, vehicle_tier, arrives_at, expires_at, streak_at_send, distance_km, delivery_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, sent_at, arrives_at, vehicle_tier`,
      [req.user.id, recipientId, content.trim(), tier, arrivesAt, expiresAt, streak.streak_days, Math.round(distKm), deliveryMs]
    );

    // Use sender's local date so streak day boundaries respect their timezone
    const senderLocalDate = req.body.senderLocalDate || new Date().toISOString().split('T')[0];
    const isUser1  = req.user.id === uid1;

    // Re-evaluate streak from sender's local date perspective
    const freshStreak = calculateEffectiveStreak(raw, senderLocalDate);

    // Mark sender as "sent today" — fuel is added when the letter ARRIVES, not now
    // This prevents fuel farming and correctly rewards actual delivery
    await upsertStreak(client, uid1, uid2, {
      streak_days: freshStreak.streak_days,
      fuel: freshStreak.fuel, // unchanged at send time
      last_day_processed: senderLocalDate,
      user1_sent_today: isUser1 ? true : (freshStreak.user1_sent_today || false),
      user2_sent_today: !isUser1 ? true : (freshStreak.user2_sent_today || false),
    });

    // Seeds awarded on ARRIVAL only (both sender and receiver) — prevents farming
    // distKm is available here and stored in the letter for arrival lookup
    res.status(201).json({
      id: letter.id, sentAt: letter.sent_at,
      arrivesAt: letter.arrives_at, vehicleTier: letter.vehicle_tier,
      vehicleEmoji: VEHICLE_TIERS[tier].emoji,
      deliveryTime: formatDuration(deliveryMs),
      distanceKm: Math.round(distKm),
      recipient: { id: recipient.id, displayName: recipient.display_name, city: recipient.city },
      streak: { days: freshStreak.streak_days, fuel: freshStreak.fuel, tier },
    });
  } catch (err) {
    console.error('Send letter error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── GET /api/letters — inbox + outbox with personal nickname resolution ────────
router.get('/', requireAuth, async (req, res) => {
  try {
    // Fetch personal nicknames viewer has set
    const myNicknameMap = await getMyNicknameMap(req.user.id);

    const { rows } = await pool.query(
      `SELECT
        l.id, l.content, l.vehicle_tier, l.sent_at, l.arrives_at, l.opened_at, l.expires_at,
        l.sender_id, l.recipient_id, l.streak_at_send,
        COALESCE(l.seeds_awarded, false) AS seeds_awarded,
        COALESCE(su.nickname, split_part(su.full_name,' ',1)) AS sender_own_nick,
        COALESCE(ru.nickname, split_part(ru.full_name,' ',1)) AS recipient_own_nick
       FROM letters l
       JOIN users su ON l.sender_id = su.id
       JOIN users ru ON l.recipient_id = ru.id
       WHERE (l.sender_id=$1 OR l.recipient_id=$1)
         AND (l.expires_at IS NULL OR l.expires_at > NOW())
       ORDER BY l.arrives_at DESC, l.sent_at DESC
       LIMIT 200`,
      [req.user.id]
    );

    const now = new Date();
    res.json(rows.map(l => ({
      id: l.id,
      content: new Date(l.arrives_at) > now ? null : l.content,
      vehicleTier: l.vehicle_tier,
      vehicleEmoji: VEHICLE_TIERS[l.vehicle_tier]?.emoji || '🚗',
      sentAt: l.sent_at,
      arrivesAt: l.arrives_at,
      expiresAt: l.expires_at,
      openedAt: l.opened_at,
      streakAtSend: l.streak_at_send,
      inTransit: new Date(l.arrives_at) > now,
      isInbox: l.recipient_id === req.user.id,
      seedsAwarded: l.seeds_awarded || false,
      senderId: l.sender_id,
      recipientId: l.recipient_id,
      // Use viewer's personal nickname for the other party if set
      senderName: resolveDisplayName(l.sender_id, l.sender_own_nick, myNicknameMap),
      recipientName: resolveDisplayName(l.recipient_id, l.recipient_own_nick, myNicknameMap),
    })));
  } catch (err) {
    console.error('Get letters error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/letters/stats — dashboard counts ─────────────────────────────────
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const { rows } = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE recipient_id=$1 AND arrives_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())) AS received,
        COUNT(*) FILTER (WHERE recipient_id=$1 AND arrives_at > NOW()) AS incoming,
        COUNT(*) FILTER (WHERE sender_id=$1 AND arrives_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())) AS sent,
        COUNT(*) FILTER (WHERE sender_id=$1 AND arrives_at > NOW()) AS outgoing
       FROM letters`,
      [req.user.id]
    );
    const r = rows[0];
    res.json({
      received: parseInt(r.received),
      incoming: parseInt(r.incoming),
      sent: parseInt(r.sent),
      outgoing: parseInt(r.outgoing),
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/letters/in-transit ───────────────────────────────────────────────
router.get('/in-transit', requireAuth, async (req, res) => {
  try {
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
         AND (l.sender_id=$1 OR l.recipient_id=$1)`,
      [req.user.id]
    );
    res.json(rows.map(l => ({
      id: l.id,
      vehicleTier: l.vehicle_tier,
      vehicleEmoji: VEHICLE_TIERS[l.vehicle_tier]?.emoji || '🚗',
      sentAt: l.sent_at, arrivesAt: l.arrives_at,
      senderId: l.sender_id, recipientId: l.recipient_id,
      senderName: l.sender_name,
      senderLat: l.sender_lat, senderLon: l.sender_lon,
      recipientLat: l.recipient_lat, recipientLon: l.recipient_lon,
    })));
  } catch (err) {
    console.error('In-transit error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/letters/streaks ──────────────────────────────────────────────────
router.get('/streaks', requireAuth, async (req, res) => {
  try {
    const myNicknameMap = await getMyNicknameMap(req.user.id);
    const { rows: friends } = await pool.query(
      `SELECT
        CASE WHEN f.user_id_1=$1 THEN f.user_id_2 ELSE f.user_id_1 END AS friend_id,
        COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS own_nick
       FROM friendships f
       JOIN users u ON (CASE WHEN f.user_id_1=$1 THEN f.user_id_2 ELSE f.user_id_1 END = u.id)
       WHERE (f.user_id_1=$1 OR f.user_id_2=$1) AND f.status='accepted' AND u.deleted_at IS NULL`,
      [req.user.id]
    );

    const client = await pool.connect();
    const results = [];
    try {
      for (const friend of friends) {
        const raw    = await getStreak(client, req.user.id, friend.friend_id);
        const streak = calculateEffectiveStreak(raw);
        if (streak._dirty) {
          const [u1, u2] = [req.user.id, friend.friend_id].sort();
          await upsertStreak(client, u1, u2, streak);
        }
        const tier = getVehicleTier(streak.streak_days);
        const isUser1 = req.user.id === [req.user.id, friend.friend_id].sort()[0];
        results.push({
          friendId: friend.friend_id,
          displayName: resolveDisplayName(friend.friend_id, friend.own_nick, myNicknameMap),
          streakDays: streak.streak_days,
          fuel: streak.fuel,
          tier,
          tierLabel: VEHICLE_TIERS[tier].label,
          tierEmoji: VEHICLE_TIERS[tier].emoji,
          nextMilestone: nextVehicleMilestone(streak.streak_days),
          iSentToday: isUser1 ? (streak.user1_sent_today || false) : (streak.user2_sent_today || false),
          theySentToday: isUser1 ? (streak.user2_sent_today || false) : (streak.user1_sent_today || false),
          lastDayProcessed: streak.last_day_processed || null,
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


// ── PATCH /api/letters/:id/arrived — fuel+1 when letter reaches recipient ────
// Called by the frontend when the letter's arrivesAt timestamp is crossed
router.patch('/:id/arrived', requireAuth, async (req, res) => {
  try {
    console.log(`[arrived] called — letterId=${req.params.id} userId=${req.user.id}`);

    // First check what the letter looks like before the UPDATE
    const { rows: [check] } = await pool.query(
      `SELECT id, sender_id, recipient_id, arrives_at, seeds_awarded, delivery_ms, distance_km
       FROM letters WHERE id=$1`,
      [req.params.id]
    );
    console.log(`[arrived] letter lookup:`, check
      ? `found, recipient=${check.recipient_id}, arrives_at=${check.arrives_at}, seeds_awarded=${check.seeds_awarded}, delivery_ms=${check.delivery_ms}`
      : 'NOT FOUND'
    );

    const { rows: [letter] } = await pool.query(
      `UPDATE letters SET seeds_awarded = true
       WHERE id=$1 AND recipient_id=$2 AND arrives_at <= NOW() AND (seeds_awarded = false OR seeds_awarded IS NULL)
       RETURNING sender_id, recipient_id, COALESCE(distance_km, 0) AS distance_km, COALESCE(delivery_ms, 0) AS delivery_ms`,
      [req.params.id, req.user.id]
    );

    if (!letter) {
      console.log(`[arrived] UPDATE returned no rows — already awarded, wrong recipient, or not yet arrived`);
      return res.status(404).json({ error: 'Already processed or not found' });
    }

    const MAX_MS        = 72 * 3600 * 1000;
    const delivMs       = Math.max(30000, Math.min(letter.delivery_ms || 0, MAX_MS));
    const ratio         = Math.sqrt(delivMs / MAX_MS);
    const seedsSender   = 5  + Math.floor(ratio * 35);
    const seedsReceiver = 10 + Math.floor(ratio * 50);

    console.log(`[arrived] awarding — sender=${letter.sender_id} +${seedsSender}, recipient=${letter.recipient_id} +${seedsReceiver}, delivMs=${delivMs}, ratio=${ratio.toFixed(3)}`);

    await awardSeeds(letter.sender_id,    seedsSender,   'send_letter');
    await awardSeeds(letter.recipient_id, seedsReceiver, 'receive_letter');

    console.log(`[arrived] seeds awarded OK`);
    sendPush(letter.recipient_id, '✉️ Letter arrived!', `You received a letter!`, '/letters').catch(()=>{});

    const [uid1, uid2] = [letter.sender_id, letter.recipient_id].sort();
    const raw    = await pool.query(
      `SELECT * FROM letter_streaks WHERE user_id_1=$1 AND user_id_2=$2`, [uid1, uid2]
    );
    const streak = calculateEffectiveStreak(raw.rows[0] || null);

    res.json({ fuel: streak.fuel || 0, streakDays: streak.streak_days || 0,
               seedsSender, seedsReceiver });
  } catch (err) {
    console.error('[arrived] ERROR:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/letters/:id/open ───────────────────────────────────────────────
router.patch('/:id/open', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE letters SET opened_at=NOW()
       WHERE id=$1 AND recipient_id=$2 AND arrives_at<=NOW() AND opened_at IS NULL
       RETURNING id, opened_at`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ error: 'Letter not found or not yet arrived' });
    res.json({ openedAt: rows[0].opened_at });
  } catch (err) {
    console.error('Open letter error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/letters/:id — recall/destroy in-transit letter ───────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    // Only sender can recall, only while still in transit
    const { rows } = await pool.query(
      `DELETE FROM letters
       WHERE id=$1 AND sender_id=$2 AND arrives_at > NOW()
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ error: 'Letter not found, already arrived, or not yours to recall' });
    res.json({ message: 'Letter recalled successfully' });
  } catch (err) {
    console.error('Recall letter error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
