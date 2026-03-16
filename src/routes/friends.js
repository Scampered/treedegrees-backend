// src/routes/friends.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Helper: is this friendship private from the requester's perspective?
function isPrivateForMe(f, myId) {
  if (f.user_id_1 === myId) return f.private_for_user1;
  return f.private_for_user2;
}

// ── GET /api/friends ──────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        u.id, u.full_name, u.nickname, u.city, u.country, u.latitude, u.longitude,
        u.friend_code, u.bio, u.is_public, u.connections_public,
        u.daily_note, u.daily_note_updated_at,
        f.id AS friendship_id, f.created_at AS connected_since,
        f.user_id_1, f.private_for_user1, f.private_for_user2
       FROM friendships f
       JOIN users u ON (
         CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END = u.id
       )
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1)
         AND f.status = 'accepted'
         AND u.deleted_at IS NULL
       ORDER BY u.nickname, u.full_name`,
      [req.user.id]
    );

    res.json(rows.map(u => {
      const myPrivate = u.user_id_1 === req.user.id ? u.private_for_user1 : u.private_for_user2;
      return {
        id: u.id,
        friendshipId: u.friendship_id,
        displayName: u.nickname || u.full_name,
        fullName: u.full_name,
        city: u.city,
        country: u.country,
        latitude: u.latitude,
        longitude: u.longitude,
        friendCode: u.friend_code,
        bio: u.is_public ? u.bio : null,
        isPublic: u.is_public,
        dailyNote: u.is_public ? u.daily_note : null,
        dailyNoteUpdatedAt: u.is_public ? u.daily_note_updated_at : null,
        connectedSince: u.connected_since,
        isPrivate: myPrivate, // MY setting for this friendship
      };
    }));
  } catch (err) {
    console.error('List friends error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/friends/requests ─────────────────────────────────────────────────
router.get('/requests', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id AS request_id, u.id, u.nickname, u.full_name, u.bio, u.city, u.country, f.created_at
       FROM friendships f
       JOIN users u ON f.requester_id = u.id
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1)
         AND f.status = 'pending'
         AND f.requester_id != $1
         AND u.deleted_at IS NULL
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );

    res.json(rows.map(r => ({
      requestId: r.request_id,
      user: {
        id: r.id,
        displayName: r.nickname || r.full_name,
        city: r.city,
        country: r.country,
        bio: r.bio || null,
      },
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error('Requests error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/friends/add ─────────────────────────────────────────────────────
// isPrivate = whether the SENDER marks this as private from their side
router.post('/add', requireAuth, async (req, res) => {
  try {
    const { friendCode, isPrivate = false } = req.body;
    if (!friendCode) return res.status(400).json({ error: 'Friend code required' });

    const targetResult = await pool.query(
      'SELECT id, nickname, full_name, city, country FROM users WHERE friend_code = $1 AND deleted_at IS NULL',
      [friendCode.toUpperCase().trim()]
    );

    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: 'No user found with that friend code' });
    }

    const target = targetResult.rows[0];
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });

    const [uid1, uid2] = [req.user.id, target.id].sort();
    const iAmUser1 = req.user.id === uid1;

    const existing = await pool.query(
      'SELECT id, status FROM friendships WHERE user_id_1 = $1 AND user_id_2 = $2',
      [uid1, uid2]
    );

    if (existing.rows.length > 0) {
      const { status } = existing.rows[0];
      if (status === 'accepted') return res.status(409).json({ error: 'Already connected' });
      if (status === 'pending') return res.status(409).json({ error: 'Connection request already sent' });
      if (status === 'blocked') return res.status(403).json({ error: 'Cannot connect with this user' });
    }

    // Store sender's privacy preference immediately
    await pool.query(
      `INSERT INTO friendships
        (user_id_1, user_id_2, status, requester_id, private_for_user1, private_for_user2)
       VALUES ($1, $2, 'pending', $3, $4, $5)`,
      [uid1, uid2, req.user.id,
        iAmUser1 ? isPrivate : false,
        iAmUser1 ? false : isPrivate]
    );

    const displayName = target.nickname || target.full_name;
    res.status(201).json({
      message: `Connection request sent to ${displayName}`,
      target: { id: target.id, displayName, city: target.city, country: target.country },
    });
  } catch (err) {
    console.error('Add friend error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/friends/respond/:requestId ─────────────────────────────────────
// Accept or decline — acceptor can also set their own privacy side
router.patch('/respond/:requestId', requireAuth, async (req, res) => {
  try {
    const { action, isPrivate = false } = req.body;
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'Action must be accept or decline' });
    }

    const result = await pool.query(
      `SELECT * FROM friendships
       WHERE id = $1 AND (user_id_1 = $2 OR user_id_2 = $2)
         AND status = 'pending' AND requester_id != $2`,
      [req.params.requestId, req.user.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Request not found' });

    const f = result.rows[0];
    const iAmUser1 = f.user_id_1 === req.user.id;

    if (action === 'accept') {
      // Set acceptor's privacy preference on their side
      await pool.query(
        `UPDATE friendships SET
          status = 'accepted',
          private_for_user1 = CASE WHEN user_id_1 = $2 THEN $3 ELSE private_for_user1 END,
          private_for_user2 = CASE WHEN user_id_2 = $2 THEN $3 ELSE private_for_user2 END
         WHERE id = $1`,
        [req.params.requestId, req.user.id, isPrivate]
      );
      res.json({ message: 'Connection accepted' });
    } else {
      await pool.query('DELETE FROM friendships WHERE id = $1', [req.params.requestId]);
      res.json({ message: 'Connection declined' });
    }
  } catch (err) {
    console.error('Respond error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/friends/:friendshipId/privacy ──────────────────────────────────
// Toggle private/public for MY side of an existing friendship
router.patch('/:friendshipId/privacy', requireAuth, async (req, res) => {
  try {
    const { isPrivate } = req.body;
    if (typeof isPrivate !== 'boolean') {
      return res.status(400).json({ error: 'isPrivate must be a boolean' });
    }

    const result = await pool.query(
      `UPDATE friendships SET
        private_for_user1 = CASE WHEN user_id_1 = $2 THEN $3 ELSE private_for_user1 END,
        private_for_user2 = CASE WHEN user_id_2 = $2 THEN $3 ELSE private_for_user2 END
       WHERE id = $1
         AND (user_id_1 = $2 OR user_id_2 = $2)
         AND status = 'accepted'
       RETURNING id`,
      [req.params.friendshipId, req.user.id, isPrivate]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Friendship not found' });
    res.json({ message: `Connection is now ${isPrivate ? 'private' : 'public'}` });
  } catch (err) {
    console.error('Privacy toggle error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/friends/preview/:friendCode ─────────────────────────────────────
// Look up a user's public info before sending a request — shows bio preview
router.get('/preview/:friendCode', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nickname, full_name, city, country, bio, is_public
       FROM users WHERE friend_code = $1 AND deleted_at IS NULL`,
      [req.params.friendCode.toUpperCase().trim()]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'No user found with that friend code' });
    const u = rows[0];
    if (u.id === req.user.id) return res.status(400).json({ error: 'That is your own code' });
    res.json({
      id: u.id,
      displayName: u.nickname || u.full_name,
      city: u.city,
      country: u.country,
      bio: u.is_public ? u.bio : null,
    });
  } catch (err) {
    console.error('Preview error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/friends/:userId ───────────────────────────────────────────────
router.delete('/:userId', requireAuth, async (req, res) => {
  try {
    const [uid1, uid2] = [req.user.id, req.params.userId].sort();
    await pool.query(
      'DELETE FROM friendships WHERE user_id_1 = $1 AND user_id_2 = $2',
      [uid1, uid2]
    );
    res.json({ message: 'Connection removed' });
  } catch (err) {
    console.error('Remove friend error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
