// src/routes/groups.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { haversineKm } from '../utils/letters.js';

const router = Router();

// Bahrain→UK = ~5300km in 60s → speed = 5300/60 ≈ 88.3 km/s
const GROUP_SPEED_KM_PER_S = 5300 / 60;

function groupDeliveryMs(distKm) {
  if (distKm < 1) return 2000;
  return Math.max(2000, Math.round((distKm / GROUP_SPEED_KM_PER_S) * 1000));
}

// ── GET /api/groups — groups the viewer belongs to (accepted only) ────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.description, g.color, g.admin_id, g.created_at,
              COUNT(DISTINCT gm2.user_id) FILTER (WHERE gm2.status='accepted') AS member_count
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1 AND gm.status = 'accepted'
       LEFT JOIN group_members gm2 ON gm2.group_id = g.id
       GROUP BY g.id ORDER BY g.created_at DESC`,
      [req.user.id]
    );
    res.json(rows.map(g => ({
      id: g.id, name: g.name, description: g.description,
      color: g.color, adminId: g.admin_id,
      memberCount: parseInt(g.member_count) || 0,
      isAdmin: g.admin_id === req.user.id,
      createdAt: g.created_at,
    })));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/invites — pending invites for the viewer ──────────────────
router.get('/invites', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT gm.group_id, gm.invited_at, gm.invited_by,
              g.name, g.description, g.color,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS inviter_name
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       LEFT JOIN users u ON u.id = gm.invited_by
       WHERE gm.user_id = $1 AND gm.status = 'pending'
       ORDER BY gm.invited_at DESC`,
      [req.user.id]
    );
    res.json(rows.map(r => ({
      groupId: r.group_id, groupName: r.name,
      groupDescription: r.description, groupColor: r.color,
      inviterName: r.inviter_name, invitedAt: r.invited_at,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/groups/invites/:groupId/respond — accept or decline ─────────────
router.post('/invites/:groupId/respond', requireAuth, async (req, res) => {
  try {
    const { action } = req.body; // 'accept' | 'decline'
    if (!['accept', 'decline'].includes(action))
      return res.status(400).json({ error: 'action must be accept or decline' });

    if (action === 'accept') {
      const { rowCount } = await pool.query(
        `UPDATE group_members SET status = 'accepted'
         WHERE group_id = $1 AND user_id = $2 AND status = 'pending'`,
        [req.params.groupId, req.user.id]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Invite not found' });
    } else {
      // Decline = remove the row entirely so admin can re-invite
      await pool.query(
        `DELETE FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='pending'`,
        [req.params.groupId, req.user.id]
      );
    }
    res.json({ message: action === 'accept' ? 'Joined group!' : 'Invite declined' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/outbound — pending invites the viewer sent ────────────────
router.get('/outbound', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT gm.group_id, gm.user_id, gm.invited_at,
              g.name AS group_name, g.color,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS invitee_name
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id AND g.admin_id = $1
       JOIN users u ON u.id = gm.user_id
       WHERE gm.invited_by = $1 AND gm.status = 'pending'
       ORDER BY gm.invited_at DESC`,
      [req.user.id]
    );
    res.json(rows.map(r => ({
      groupId: r.group_id, inviteeId: r.user_id,
      inviteeName: r.invitee_name, groupName: r.group_name,
      groupColor: r.color, invitedAt: r.invited_at,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/groups/outbound/:groupId/:userId — recall invite ──────────────
router.delete('/outbound/:groupId/:userId', requireAuth, async (req, res) => {
  try {
    // Must be admin of the group to recall
    const { rowCount } = await pool.query(
      `DELETE FROM group_members gm
       USING groups g
       WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.status = 'pending'
         AND g.id = gm.group_id AND g.admin_id = $3`,
      [req.params.groupId, req.params.userId, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Pending invite not found' });
    res.json({ message: 'Invite recalled' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/groups — create ─────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, color } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Group name is required' });
    const validColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4dba4d';
    const { rows: [group] } = await client.query(
      `INSERT INTO groups (name, description, color, admin_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name.trim(), description?.trim() || null, validColor, req.user.id]
    );
    await client.query(
      `INSERT INTO group_members (group_id, user_id, status, invited_by) VALUES ($1,$2,'accepted',$2)`,
      [group.id, req.user.id]
    );
    res.status(201).json({ id: group.id, name: group.name, color: group.color, adminId: group.admin_id, memberCount: 1, isAdmin: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── PATCH /api/groups/:id ─────────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, color } = req.body;
    const { rows } = await pool.query(
      `UPDATE groups SET
        name = COALESCE($1, name), description = COALESCE($2, description),
        color = COALESCE($3, color)
       WHERE id=$4 AND admin_id=$5 RETURNING *`,
      [name?.trim()||null, description?.trim()||null,
       /^#[0-9a-fA-F]{6}$/.test(color)?color:null, req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(403).json({ error: 'Not found or not admin' });
    res.json({ id: rows[0].id, name: rows[0].name, color: rows[0].color });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── DELETE /api/groups/:id ────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM groups WHERE id=$1 AND admin_id=$2`, [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(403).json({ error: 'Not found or not admin' });
    res.json({ message: 'Group deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/groups/:id/members — accepted + pending ─────────────────────────
router.get('/:id/members', requireAuth, async (req, res) => {
  try {
    const access = await pool.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'`,
      [req.params.id, req.user.id]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    const { rows } = await pool.query(
      `SELECT u.id, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS display_name,
              u.city, u.country, u.latitude, u.longitude,
              gm.joined_at, gm.status, gm.invited_by, g.admin_id
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.group_id=$1 AND u.deleted_at IS NULL
       ORDER BY gm.status, gm.joined_at`,
      [req.params.id]
    );
    res.json(rows.map(m => ({
      id: m.id, displayName: m.display_name,
      city: m.city, country: m.country,
      latitude: m.latitude, longitude: m.longitude,
      isAdmin: m.admin_id === m.id,
      status: m.status,
      joinedAt: m.joined_at,
    })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/groups/:id/members — invite (admin only, creates pending) ───────
router.post('/:id/members', requireAuth, async (req, res) => {
  try {
    const { rows: [grp] } = await pool.query(
      `SELECT admin_id FROM groups WHERE id=$1`, [req.params.id]
    );
    if (!grp) return res.status(404).json({ error: 'Group not found' });
    if (grp.admin_id !== req.user.id) return res.status(403).json({ error: 'Only admin can invite' });

    const { userId } = req.body;
    // Must be a direct friend
    const [u1, u2] = [req.user.id, userId].sort();
    const friend = await pool.query(
      `SELECT id FROM friendships WHERE user_id_1=$1 AND user_id_2=$2 AND status='accepted'`,
      [u1, u2]
    );
    if (friend.rows.length === 0)
      return res.status(403).json({ error: 'You can only invite your direct connections' });

    // Check not already a member or pending
    const existing = await pool.query(
      `SELECT status FROM group_members WHERE group_id=$1 AND user_id=$2`, [req.params.id, userId]
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].status === 'accepted')
        return res.status(409).json({ error: 'Already a member' });
      if (existing.rows[0].status === 'pending')
        return res.status(409).json({ error: 'Already invited — waiting for response' });
    }

    await pool.query(
      `INSERT INTO group_members (group_id, user_id, status, invited_by, invited_at)
       VALUES ($1,$2,'pending',$3,NOW())`,
      [req.params.id, userId, req.user.id]
    );
    res.json({ message: 'Invite sent! Waiting for them to accept.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/groups/:id/members/:userId ────────────────────────────────────
router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    const { rows: [grp] } = await pool.query(
      `SELECT admin_id FROM groups WHERE id=$1`, [req.params.id]
    );
    if (!grp) return res.status(404).json({ error: 'Group not found' });
    const canRemove = grp.admin_id === req.user.id || req.params.userId === req.user.id;
    if (!canRemove) return res.status(403).json({ error: 'Not allowed' });
    if (req.params.userId === grp.admin_id)
      return res.status(400).json({ error: 'Admin cannot leave — delete the group instead' });
    await pool.query(
      `DELETE FROM group_members WHERE group_id=$1 AND user_id=$2`,
      [req.params.id, req.params.userId]
    );
    res.json({ message: 'Removed' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/groups/:id/letters ─────────────────────────────────────────────
router.post('/:id/letters', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    if (content.length > 500) return res.status(400).json({ error: '500 chars max' });

    const memberCheck = await client.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'`,
      [req.params.id, req.user.id]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    const { rows: [sender] } = await client.query(
      `SELECT latitude, longitude FROM users WHERE id=$1`, [req.user.id]
    );
    if (!sender?.latitude) return res.status(400).json({ error: 'Location required' });

    const expiresAt = new Date(Date.now() + 7 * 86400000);
    const { rows: [letter] } = await client.query(
      `INSERT INTO group_letters (group_id, sender_id, content, expires_at) VALUES ($1,$2,$3,$4) RETURNING id, sent_at`,
      [req.params.id, req.user.id, content.trim(), expiresAt]
    );

    const { rows: members } = await client.query(
      `SELECT u.id, u.latitude, u.longitude FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id=$1 AND gm.user_id!=$2 AND gm.status='accepted'
         AND u.deleted_at IS NULL AND u.latitude IS NOT NULL`,
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
        `INSERT INTO group_letter_deliveries (letter_id, recipient_id, arrives_at) VALUES ($1,$2,$3)`,
        [letter.id, m.id, arrivesAt]
      );
      deliveries.push({ recipientId: m.id, arrivesAt, distKm: Math.round(dist) });
    }

    res.status(201).json({ id: letter.id, sentAt: letter.sent_at, deliveries });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── GET /api/groups/:id/letters ───────────────────────────────────────────────
router.get('/:id/letters', requireAuth, async (req, res) => {
  try {
    const memberCheck = await pool.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'`,
      [req.params.id, req.user.id]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    const now = new Date();
    const { rows } = await pool.query(
      `SELECT gl.id, gl.content, gl.sent_at, gl.expires_at, gl.sender_id,
              COALESCE(su.nickname, split_part(su.full_name,' ',1)) AS sender_name,
              -- Deliveries: array of {recipient_id, arrives_at, opened_at, display_name}
              COALESCE(
                json_agg(
                  json_build_object(
                    'recipientId', gld.recipient_id,
                    'arrivesAt', gld.arrives_at,
                    'openedAt', gld.opened_at,
                    'displayName', COALESCE(ru.nickname, split_part(ru.full_name,' ',1))
                  )
                ) FILTER (WHERE gld.recipient_id IS NOT NULL),
                '[]'::json
              ) AS deliveries,
              -- This viewer's delivery
              MAX(CASE WHEN gld.recipient_id = $2 THEN gld.arrives_at END) AS my_arrives_at,
              MAX(CASE WHEN gld.recipient_id = $2 THEN gld.opened_at::text END) AS my_opened_at
       FROM group_letters gl
       JOIN users su ON gl.sender_id = su.id
       LEFT JOIN group_letter_deliveries gld ON gld.letter_id = gl.id
       LEFT JOIN users ru ON ru.id = gld.recipient_id
       WHERE gl.group_id=$1 AND (gl.expires_at IS NULL OR gl.expires_at > NOW())
       GROUP BY gl.id, su.nickname, su.full_name
       ORDER BY gl.sent_at DESC LIMIT 100`,
      [req.params.id, req.user.id]
    );

    res.json(rows.map(l => {
      const isSender = l.sender_id === req.user.id;
      const myArrivesAt = l.my_arrives_at ? new Date(l.my_arrives_at) : null;
      const arrived = isSender || (myArrivesAt && myArrivesAt <= now);
      const deliveries = (l.deliveries || []).map(d => ({
        recipientId: d.recipientId,
        displayName: d.displayName,
        arrivesAt: d.arrivesAt,
        openedAt: d.openedAt,
        arrived: new Date(d.arrivesAt) <= now,
      }));
      return {
        id: l.id,
        content: arrived ? l.content : null,
        sentAt: l.sent_at,
        expiresAt: l.expires_at,
        senderId: l.sender_id,
        senderName: l.sender_name,
        isSender,
        arrivesAt: l.my_arrives_at,
        openedAt: l.my_opened_at,
        inTransit: !isSender && myArrivesAt && myArrivesAt > now,
        deliveries,
      };
    }));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/in-transit ────────────────────────────────────────────────
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
       JOIN group_members gm ON gm.group_id = gl.group_id AND gm.user_id=$1 AND gm.status='accepted'
       WHERE gld.arrives_at > NOW()`,
      [req.user.id]
    );
    res.json(rows.map(r => ({
      id: `${r.id}-${r.recipient_id}`,
      groupId: r.group_id, senderId: r.sender_id, senderName: r.sender_name,
      groupColor: r.group_color, sentAt: r.sent_at, arrivesAt: r.arrives_at,
      recipientId: r.recipient_id,
      senderLat: r.sender_lat, senderLon: r.sender_lon,
      recipientLat: r.recipient_lat, recipientLon: r.recipient_lon,
    })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/groups/map-data ──────────────────────────────────────────────────
router.get('/map-data', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id AS group_id, g.name, g.color,
              u.id AS user_id, u.latitude, u.longitude,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS display_name
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       JOIN group_members gm_me ON gm_me.group_id = g.id AND gm_me.user_id=$1 AND gm_me.status='accepted'
       JOIN users u ON gm.user_id = u.id
       WHERE gm.status='accepted' AND u.deleted_at IS NULL AND u.latitude IS NOT NULL`,
      [req.user.id]
    );
    const groups = {};
    for (const r of rows) {
      if (!groups[r.group_id]) groups[r.group_id] = { id: r.group_id, name: r.name, color: r.color, members: [] };
      groups[r.group_id].members.push({
        id: r.user_id, lat: parseFloat(r.latitude), lon: parseFloat(r.longitude), displayName: r.display_name
      });
    }
    res.json(Object.values(groups));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── PATCH /api/groups/letters/:id/open ───────────────────────────────────────
router.patch('/letters/:letterId/open', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE group_letter_deliveries SET opened_at=NOW()
       WHERE letter_id=$1 AND recipient_id=$2 AND arrives_at<=NOW() AND opened_at IS NULL`,
      [req.params.letterId, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/groups/notifications ─────────────────────────────────────────────
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    // New friend requests
    const { rows: reqRows } = await pool.query(
      `SELECT f.id, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS from_name
       FROM friendships f JOIN users u ON f.requester_id = u.id
       WHERE (f.user_id_1=$1 OR f.user_id_2=$1) AND f.status='pending'
         AND f.requester_id!=$1
         AND f.id NOT IN (SELECT friendship_id FROM friend_request_notified)
         AND u.deleted_at IS NULL`,
      [req.user.id]
    );
    for (const r of reqRows) {
      await pool.query(
        `INSERT INTO friend_request_notified (friendship_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [r.id]
      );
    }

    // New group invites
    const { rows: inviteRows } = await pool.query(
      `SELECT gm.group_id, g.name AS group_name,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS inviter_name
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       LEFT JOIN users u ON u.id = gm.invited_by
       WHERE gm.user_id=$1 AND gm.status='pending'
         AND gm.invited_at > NOW() - INTERVAL '60 seconds'`,
      [req.user.id]
    );

    res.json({
      friendRequests: reqRows.map(r => ({ friendshipId: r.id, fromName: r.from_name })),
      groupInvites: inviteRows.map(r => ({ groupId: r.group_id, groupName: r.group_name, inviterName: r.inviter_name })),
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

export default router;
