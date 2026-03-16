// src/routes/graph.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { buildAdjacency, computeDegrees, findPath } from '../utils/graph.js';

const router = Router();

const COUNTRY_CAPITALS = {
  'bahrain': [26.2235, 50.5876], 'saudi arabia': [24.6877, 46.7219],
  'united arab emirates': [24.4539, 54.3773], 'kuwait': [29.3759, 47.9774],
  'qatar': [25.2854, 51.5310], 'oman': [23.5880, 58.3829],
  'united states': [38.9072, -77.0369], 'united kingdom': [51.5074, -0.1278],
  'germany': [52.5200, 13.4050], 'france': [48.8566, 2.3522],
  'japan': [35.6762, 139.6503], 'china': [39.9042, 116.4074],
  'india': [28.6139, 77.2090], 'australia': [-35.2809, 149.1300],
  'canada': [45.4215, -75.6972], 'brazil': [-15.7942, -47.8822],
  'south africa': [-25.7479, 28.2293], 'nigeria': [9.0765, 7.3986],
  'egypt': [30.0444, 31.2357], 'turkey': [39.9334, 32.8597],
  'russia': [55.7558, 37.6173], 'pakistan': [33.7294, 73.0931],
  'indonesia': [-6.2088, 106.8456], 'malaysia': [3.1390, 101.6869],
  'singapore': [1.3521, 103.8198],
};

function getApproxCoords(country) {
  return COUNTRY_CAPITALS[(country || '').toLowerCase().trim()] || null;
}

function resolveCoords(user, viewerDegree) {
  const privacy = user.location_privacy || 'exact';
  const isDirectFriend = viewerDegree === 1 || viewerDegree === 0;
  if (privacy === 'exact') return { lat: user.latitude, lon: user.longitude, isApproximate: false };
  if (privacy === 'private') {
    if (isDirectFriend) return { lat: user.latitude, lon: user.longitude, isApproximate: false };
    const approx = getApproxCoords(user.country);
    if (approx) return { lat: approx[0], lon: approx[1], isApproximate: true };
    return { lat: user.latitude, lon: user.longitude, isApproximate: true };
  }
  const approx = getApproxCoords(user.country);
  if (approx) return { lat: approx[0], lon: approx[1], isApproximate: true };
  return { lat: user.latitude, lon: user.longitude, isApproximate: true };
}

// ── GET /api/graph/map ────────────────────────────────────────────────────────
router.get('/map', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows: allFriendships } = await pool.query(
      `SELECT user_id_1, user_id_2, private_for_user1, private_for_user2
       FROM friendships WHERE status = 'accepted'`
    );

    const adjacency = buildAdjacency(allFriendships);
    const degrees = computeDegrees(adjacency, userId, 3);
    const relevantIds = [userId, ...degrees.keys()];

    // Also fetch direct friends of viewer to know who allowed full name reveal
    const { rows: myFriendships } = await pool.query(
      `SELECT CASE WHEN user_id_1 = $1 THEN user_id_2 ELSE user_id_1 END AS friend_id
       FROM friendships WHERE (user_id_1 = $1 OR user_id_2 = $1) AND status = 'accepted'`,
      [userId]
    );
    const myFriendIds = new Set(myFriendships.map(r => r.friend_id));

    const { rows: users } = await pool.query(
      `SELECT id, full_name, nickname, city, country, latitude, longitude,
              is_public, location_privacy, daily_note
       FROM users
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND latitude IS NOT NULL`,
      [relevantIds]
    );

    const nodes = users.map(u => {
      const degree = u.id === userId ? 0 : (degrees.get(u.id) || null);
      const isMe = u.id === userId;
      const { lat, lon, isApproximate } = isMe
        ? { lat: u.latitude, lon: u.longitude, isApproximate: false }
        : resolveCoords(u, degree);

      // Full name visible only to: self OR direct friends (degree 1) OR if user is public
      const canSeeFullName = isMe || myFriendIds.has(u.id) || u.is_public;
      const displayNick = u.nickname || u.full_name?.split(' ')[0] || '?';

      return {
        id: u.id, degree,
        latitude: lat, longitude: lon,
        locationPrivacy: isApproximate,
        city: u.city, country: u.country,
        nickname: displayNick,
        fullName: canSeeFullName ? u.full_name : null,
        isPublic: u.is_public,
        // Notes visible to: self, direct friends (degree 1), or public profiles
        dailyNote: (isMe || degree === 1 || u.is_public) ? u.daily_note : null,
      };
    });

    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = [];

    for (const f of allFriendships) {
      const { user_id_1, user_id_2, private_for_user1, private_for_user2 } = f;
      if (!nodeIds.has(user_id_1) || !nodeIds.has(user_id_2)) continue;

      const deg1 = user_id_1 === userId ? 0 : (degrees.get(user_id_1) ?? 99);
      const deg2 = user_id_2 === userId ? 0 : (degrees.get(user_id_2) ?? 99);
      const edgeDegree = Math.max(deg1, deg2);
      if (edgeDegree > 3) continue;

      // Edge is private if either end marked it private (from viewer's perspective)
      const isPrivate = private_for_user1 || private_for_user2;

      edges.push({ source: user_id_1, target: user_id_2, degree: edgeDegree, isPrivate });
    }

    res.json({ nodes, edges, myId: userId });
  } catch (err) {
    console.error('Graph map error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/graph/path/:targetId ─────────────────────────────────────────────
router.get('/path/:targetId', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT user_id_1, user_id_2 FROM friendships WHERE status = $1', ['accepted']
    );
    const adjacency = buildAdjacency(rows);
    const path = findPath(adjacency, req.user.id, req.params.targetId);
    if (!path) return res.json({ connected: false, path: null, degrees: null });

    const { rows: pathUsers } = await pool.query(
      `SELECT id, nickname, full_name, city, is_public FROM users WHERE id = ANY($1::uuid[])`, [path]
    );
    const userMap = Object.fromEntries(pathUsers.map(u => [u.id, u]));

    res.json({
      connected: true, degrees: path.length - 1,
      path: path.map(id => {
        const u = userMap[id];
        return { id, displayName: u?.nickname || u?.full_name || '?', city: u?.city };
      }),
    });
  } catch (err) {
    console.error('Path error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
