// src/routes/groups.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { haversineKm, calcDeliveryMs } from '../utils/letters.js';

const router = Router();
const MAX_EARTH_KM = 20037;

// ── Helper: compute group letter delivery time ────────────────────────────────
// Group letters travel at "airliner" speed (5h max = 5.5min Bahrain→London ish)
// Actually per spec: London to Bahrain at group speed = 5.5 minutes
// Distance BHR→LHR ≈ 5300km. 5.5min = 330s. Speed = 5300/330 ≈ 16km/s
// Max earth 20037km / 16km/s ≈ 1252s ≈ 20.9 min max
const GROUP_SPEED_KM_PER_S = 5300 / 330; // ~16.06 km/s

function groupDeliveryMs(distKm) {
  if (distKm < 5) return 5000; // min 5s for local
  return Math.round((distKm / GROUP_SPEED_KM_PER_S) * 1000);
}

// ── GET /api/groups — list groups the viewer belongs to ──────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.description, g.color, g.admin_id, g.created_at,
              COUNT(gm2.user_id) AS member_count
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
       JOIN group_members gm2 ON gm2.group_id = g.id
       GROUP BY g.id
       ORDER BY g.created_at DESC`,
      [req.user.id]
    );
    res.json(rows.map(g => ({
      id: g.id, name: g.name, description: g.description,
      color: g.color, adminId: g.admin_id,
      memberCount: parseInt(g.member_count),
      isAdmin: g.admin_id === req.user.id,
      createdAt: g.created_at,
    })));
  } catch (err) {
    console.error('Get groups error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/groups — create a group ────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, color } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Group name is required' });
    if (name.trim().length > 60) return res.status(400).json({ error: 'Name too long (max 60)' });
    const validColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4dba4d';

    const { rows: [group] } = await client.query(
      `INSERT INTO groups (name, description, color, admin_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), description?.trim() || null, validColor, req.user.id]
    );
    // Admin is always the first member
    await client.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
      [group.id, req.user.id]
    );
    res.status(201).json({ id: group.id, name: group.name, color: group.color, adminId: group.admin_id, memberCount: 1, isAdmin: true });
  } catch (err) {
    console.error('Create group error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── PATCH /api/groups/:id — edit group (admin only) ──────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, color } = req.body;
    const { rows } = await pool.query(
      `UPDATE groups SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        color = COALESCE($3, color)
       WHERE id = $4 AND admin_id = $5 RETURNING *`,
      [name?.trim() || null, description?.trim() || null,
       /^#[0-9a-fA-F]{6}$/.test(color) ? color : null,
       req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(403).json({ error: 'Not found or not admin' });
    res.json({ id: rows[0].id, name: rows[0].name, color: rows[0].color });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/groups/:id — delete group (admin only) ───────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM groups WHERE id = $1 AND admin_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(403).json({ error: 'Not found or not admin' });
    res.json({ message: 'Group deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/:id/members ───────────────────────────────────────────────
router.get('/:id/members', requireAuth, async (req, res) => {
  try {
    // Only members can view the member list
    const access = await pool.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    const { rows } = await pool.query(
      `SELECT u.id, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS display_name,
              u.city, u.country, u.latitude, u.longitude, gm.joined_at,
              g.admin_id
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.group_id = $1 AND u.deleted_at IS NULL
       ORDER BY gm.joined_at`,
      [req.params.id]
    );
    res.json(rows.map(m => ({
      id: m.id, displayName: m.display_name,
      city: m.city, country: m.country,
      latitude: m.latitude, longitude: m.longitude,
      isAdmin: m.admin_id === m.id,
      joinedAt: m.joined_at,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/groups/:id/members — add member (admin only) ───────────────────
router.post('/:id/members', requireAuth, async (req, res) => {
  try {
    // Must be admin
    const { rows: [grp] } = await pool.query(
      `SELECT admin_id FROM groups WHERE id = $1`, [req.params.id]
    );
    if (!grp) return res.status(404).json({ error: 'Group not found' });
    if (grp.admin_id !== req.user.id) return res.status(403).json({ error: 'Only the group admin can add members' });

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Must be a direct friend of the admin
    const [u1, u2] = [req.user.id, userId].sort();
    const friend = await pool.query(
      `SELECT id FROM friendships WHERE user_id_1=$1 AND user_id_2=$2 AND status='accepted'`,
      [u1, u2]
    );
    if (friend.rows.length === 0) return res.status(403).json({ error: 'You can only add your direct connections to groups' });

    await pool.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, userId]
    );
    res.json({ message: 'Member added' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/groups/:id/members/:userId — remove member ───────────────────
router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    const { rows: [grp] } = await pool.query(
      `SELECT admin_id FROM groups WHERE id=$1`, [req.params.id]
    );
    if (!grp) return res.status(404).json({ error: 'Group not found' });
    // Admin can remove anyone; members can only remove themselves
    const canRemove = grp.admin_id === req.user.id || req.params.userId === req.user.id;
    if (!canRemove) return res.status(403).json({ error: 'Not allowed' });
    if (req.params.userId === grp.admin_id) return res.status(400).json({ error: 'Admin cannot leave — delete the group instead' });

    await pool.query(
      `DELETE FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [req.params.id, req.params.userId]
    );
    res.json({ message: 'Removed' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/groups/:id/letters — send a group letter ───────────────────────
router.post('/:id/letters', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    if (content.length > 500) return res.status(400).json({ error: '500 chars max' });

    // Sender must be a member
    const memberCheck = await client.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    // Sender location
    const { rows: [sender] } = await client.query(
      `SELECT latitude, longitude FROM users WHERE id=$1`, [req.user.id]
    );
    if (!sender?.latitude) return res.status(400).json({ error: 'Location required to send group letters' });

    const expiresAt = new Date(Date.now() + 7 * 86400000);
    const { rows: [letter] } = await client.query(
      `INSERT INTO group_letters (group_id, sender_id, content, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING id, sent_at`,
      [req.params.id, req.user.id, content.trim(), expiresAt]
    );

    // Create delivery record for each OTHER member
    const { rows: members } = await client.query(
      `SELECT u.id, u.latitude, u.longitude FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id=$1 AND gm.user_id != $2 AND u.deleted_at IS NULL AND u.latitude IS NOT NULL`,
      [req.params.id, req.user.id]
    );

    const deliveries = [];
    for (const m of members) {
      const dist = haversineKm(
        parseFloat(sender.latitude), parseFloat(sender.longitude),
        parseFloat(m.latitude), parseFloat(m.longitude)
      );
      const ms = groupDeliveryMs(dist);
      const arrivesAt = new Date(Date.now() + ms);
      await client.query(
        `INSERT INTO group_letter_deliveries (letter_id, recipient_id, arrives_at)
         VALUES ($1,$2,$3)`,
        [letter.id, m.id, arrivesAt]
      );
      deliveries.push({ recipientId: m.id, arrivesAt, distKm: Math.round(dist), ms });
    }

    res.status(201).json({
      id: letter.id, sentAt: letter.sent_at,
      deliveries: deliveries.map(d => ({
        recipientId: d.recipientId,
        arrivesAt: d.arrivesAt,
        distanceKm: d.distKm,
      })),
    });
  } catch (err) {
    console.error('Group letter error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── GET /api/groups/:id/letters — group letter history ───────────────────────
router.get('/:id/letters', requireAuth, async (req, res) => {
  try {
    const memberCheck = await pool.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    const now = new Date();
    const { rows } = await pool.query(
      `SELECT gl.id, gl.content, gl.sent_at, gl.expires_at,
              gl.sender_id,
              COALESCE(su.nickname, split_part(su.full_name,' ',1)) AS sender_name,
              gld.arrives_at, gld.opened_at, gld.recipient_id
       FROM group_letters gl
       JOIN users su ON gl.sender_id = su.id
       LEFT JOIN group_letter_deliveries gld ON gld.letter_id = gl.id AND gld.recipient_id = $2
       WHERE gl.group_id = $1
         AND (gl.expires_at IS NULL OR gl.expires_at > NOW())
       ORDER BY gl.sent_at DESC
       LIMIT 100`,
      [req.params.id, req.user.id]
    );

    res.json(rows.map(l => {
      const isSender = l.sender_id === req.user.id;
      const arrived = isSender || (l.arrives_at && new Date(l.arrives_at) <= now);
      return {
        id: l.id,
        content: arrived ? l.content : null,
        sentAt: l.sent_at,
        expiresAt: l.expires_at,
        senderId: l.sender_id,
        senderName: l.sender_name,
        isSender,
        arrivesAt: l.arrives_at,
        openedAt: l.opened_at,
        inTransit: !isSender && l.arrives_at && new Date(l.arrives_at) > now,
      };
    }));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/in-transit — for map animation ───────────────────────────
router.get('/in-transit', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT gl.id, gl.group_id, gl.sender_id, gl.sent_at,
              COALESCE(su.nickname, split_part(su.full_name,' ',1)) AS sender_name,
              su.latitude AS sender_lat, su.longitude AS sender_lon,
              g.color AS group_color,
              gld.recipient_id, gld.arrives_at,
              ru.latitude AS recipient_lat, ru.longitude AS recipient_lon
       FROM group_letter_deliveries gld
       JOIN group_letters gl ON gld.letter_id = gl.id
       JOIN users su ON gl.sender_id = su.id
       JOIN users ru ON gld.recipient_id = ru.id
       JOIN groups g ON g.id = gl.group_id
       JOIN group_members gm ON gm.group_id = gl.group_id AND gm.user_id = $1
       WHERE gld.arrives_at > NOW()`,
      [req.user.id]
    );
    res.json(rows.map(r => ({
      id: `${r.id}-${r.recipient_id}`,
      groupId: r.group_id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      groupColor: r.group_color,
      sentAt: r.sent_at,
      arrivesAt: r.arrives_at,
      recipientId: r.recipient_id,
      senderLat: r.sender_lat, senderLon: r.sender_lon,
      recipientLat: r.recipient_lat, recipientLon: r.recipient_lon,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/map-data — group edges for map overlay ───────────────────
router.get('/map-data', requireAuth, async (req, res) => {
  try {
    // Get all groups the viewer is in + their members' coords
    const { rows } = await pool.query(
      `SELECT g.id AS group_id, g.name, g.color,
              u.id AS user_id, u.latitude, u.longitude,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS display_name
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       JOIN group_members gm_me ON gm_me.group_id = g.id AND gm_me.user_id = $1
       JOIN users u ON gm.user_id = u.id
       WHERE u.deleted_at IS NULL AND u.latitude IS NOT NULL`,
      [req.user.id]
    );

    // Group by group_id
    const groups = {};
    for (const r of rows) {
      if (!groups[r.group_id]) groups[r.group_id] = { id: r.group_id, name: r.name, color: r.color, members: [] };
      groups[r.group_id].members.push({
        id: r.user_id, lat: parseFloat(r.latitude), lon: parseFloat(r.longitude), displayName: r.display_name
      });
    }

    res.json(Object.values(groups));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/groups/letters/:letterId/open ──────────────────────────────────
router.patch('/letters/:letterId/open', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE group_letter_deliveries SET opened_at=NOW()
       WHERE letter_id=$1 AND recipient_id=$2 AND arrives_at<=NOW() AND opened_at IS NULL`,
      [req.params.letterId, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/notifications — check for new friend requests ─────────────
// Called by frontend polling to check if user has new friend requests to notify about
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    // New pending requests not yet notified
    const { rows } = await pool.query(
      `SELECT f.id, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS from_name
       FROM friendships f
       JOIN users u ON f.requester_id = u.id
       WHERE (f.user_id_1=$1 OR f.user_id_2=$1)
         AND f.status='pending'
         AND f.requester_id != $1
         AND f.id NOT IN (SELECT friendship_id FROM friend_request_notified)
         AND u.deleted_at IS NULL`,
      [req.user.id]
    );

    // Mark as notified
    for (const r of rows) {
      await pool.query(
        `INSERT INTO friend_request_notified (friendship_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [r.id]
      );
    }

    res.json(rows.map(r => ({ friendshipId: r.id, fromName: r.from_name })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
