// src/routes/graph.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { buildAdjacency, computeDegrees, findPath } from '../utils/graph.js';

const router = Router();

// ── GET /api/graph/map ────────────────────────────────────────────────────────
// Returns nodes + edges for the interactive globe map
// Nodes: user positions (respecting privacy)
// Edges: connections with degree labels
router.get('/map', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Fetch ALL accepted friendships across the entire graph
    const { rows: allFriendships } = await pool.query(
      `SELECT user_id_1, user_id_2 FROM friendships WHERE status = 'accepted'`
    );

    const adjacency = buildAdjacency(allFriendships);
    const degrees = computeDegrees(adjacency, userId, 3);

    // 2. Get current user's data
    const { rows: [me] } = await pool.query(
      `SELECT id, full_name, city, country, latitude, longitude, is_public, connections_public
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );

    // 3. Collect IDs within 3 degrees + direct friends
    const relevantIds = [userId, ...degrees.keys()];

    // 4. Fetch user data for relevant nodes
    const { rows: users } = await pool.query(
      `SELECT id, full_name, city, country, latitude, longitude,
              is_public, connections_public, daily_note, daily_note_updated_at
       FROM users
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND latitude IS NOT NULL`,
      [relevantIds]
    );

    // 5. Build nodes (privacy-aware)
    const nodes = users.map(u => {
      const degree = u.id === userId ? 0 : (degrees.get(u.id) || null);
      const isMe = u.id === userId;

      return {
        id: u.id,
        degree,
        latitude: u.latitude,
        longitude: u.longitude,
        city: u.city,
        country: u.country,
        // Reveal identity only if public or is the requesting user
        fullName: (isMe || u.is_public) ? u.full_name : '🔒 Private',
        isPublic: u.is_public,
        connectionsPublic: u.connections_public,
        dailyNote: u.is_public ? u.daily_note : null,
        dailyNoteUpdatedAt: u.is_public ? u.daily_note_updated_at : null,
      };
    });

    // 6. Build edges — only between nodes we're displaying
    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = [];

    for (const { user_id_1, user_id_2 } of allFriendships) {
      if (!nodeIds.has(user_id_1) || !nodeIds.has(user_id_2)) continue;

      const deg1 = user_id_1 === userId ? 0 : (degrees.get(user_id_1) ?? 99);
      const deg2 = user_id_2 === userId ? 0 : (degrees.get(user_id_2) ?? 99);
      const edgeDegree = Math.max(deg1, deg2);

      if (edgeDegree > 3) continue;

      // Privacy check: hide identity on edge if either party is private
      const u1 = users.find(u => u.id === user_id_1);
      const u2 = users.find(u => u.id === user_id_2);
      const isPrivate = (!u1?.is_public || !u2?.is_public) &&
                        user_id_1 !== userId && user_id_2 !== userId;

      edges.push({
        source: user_id_1,
        target: user_id_2,
        degree: edgeDegree,
        isPrivate,
      });
    }

    res.json({ nodes, edges, myId: userId });
  } catch (err) {
    console.error('Graph map error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/graph/path/:targetId ─────────────────────────────────────────────
// Find shortest path between current user and a target
router.get('/path/:targetId', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT user_id_1, user_id_2 FROM friendships WHERE status = $1',
      ['accepted']
    );
    const adjacency = buildAdjacency(rows);
    const path = findPath(adjacency, req.user.id, req.params.targetId);

    if (!path) {
      return res.json({ connected: false, path: null, degrees: null });
    }

    // Fetch user names for path display
    const { rows: pathUsers } = await pool.query(
      `SELECT id, full_name, city, is_public FROM users WHERE id = ANY($1::uuid[])`,
      [path]
    );
    const userMap = Object.fromEntries(pathUsers.map(u => [u.id, u]));

    res.json({
      connected: true,
      degrees: path.length - 1,
      path: path.map(id => {
        const u = userMap[id];
        return {
          id,
          fullName: u?.is_public ? u.full_name : '🔒 Private',
          city: u?.city,
        };
      }),
    });
  } catch (err) {
    console.error('Path error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
