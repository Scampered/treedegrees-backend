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

function approxCoordsForUser(country, lat, lon) {
  const cap = getApproxCoords(country);
  return cap ? { lat: cap[0], lon: cap[1] } : { lat, lon };
}

function resolveCoords(user, viewerDegree) {
  const privacy = user.location_privacy || 'exact';
  const isDirectFriend = viewerDegree === 1 || viewerDegree === 0;
  if (privacy === 'exact') return { lat: user.latitude, lon: user.longitude, isApproximate: false };
  if (privacy === 'private') {
    if (isDirectFriend) return { lat: user.latitude, lon: user.longitude, isApproximate: false };
    const a = approxCoordsForUser(user.country, user.latitude, user.longitude);
    return { lat: a.lat, lon: a.lon, isApproximate: true };
  }
  // hidden
  const a = approxCoordsForUser(user.country, user.latitude, user.longitude);
  return { lat: a.lat, lon: a.lon, isApproximate: true };
}

// ── GET /api/graph/map ────────────────────────────────────────────────────────
router.get('/map', requireAuth, async (req, res) => {
  try {
    const viewerId = req.user.id;

    // 1. All accepted friendships with per-side privacy flags
    const { rows: allFriendships } = await pool.query(
      `SELECT user_id_1, user_id_2, requester_id,
              private_for_user1, private_for_user2
       FROM friendships WHERE status = 'accepted'`
    );

    // 2. Build adjacency and degrees from viewer
    const adjacency = buildAdjacency(allFriendships);
    const degrees   = computeDegrees(adjacency, viewerId, 4); // up to 4 degrees

    // 3. Viewer's direct friend IDs
    const myFriendIds = new Set(
      allFriendships
        .filter(f => f.user_id_1 === viewerId || f.user_id_2 === viewerId)
        .map(f => f.user_id_1 === viewerId ? f.user_id_2 : f.user_id_1)
    );

    // 4. Build friendship lookup: "nodeA-nodeB" => { private_for_user1, private_for_user2 }
    const friendshipMap = {};
    for (const f of allFriendships) {
      const key = [f.user_id_1, f.user_id_2].sort().join('-');
      friendshipMap[key] = f;
    }

    // Helper: is the connection between two users private FROM a given user's side?
    function isPrivateFor(uid, otherUid) {
      const [u1, u2] = [uid, otherUid].sort();
      const key = `${u1}-${u2}`;
      const f = friendshipMap[key];
      if (!f) return false;
      if (uid === f.user_id_1) return f.private_for_user1;
      return f.private_for_user2;
    }

    // 5. Relevant user IDs (viewer + up to 4 degrees)
    const relevantIds = [viewerId, ...degrees.keys()];

    // 6. Fetch user data for all relevant nodes
    const { rows: users } = await pool.query(
      `SELECT id, full_name, nickname, city, country, latitude, longitude,
              is_public, location_privacy, daily_note, daily_mood, daily_mood_updated_at
       FROM users
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND latitude IS NOT NULL`,
      [relevantIds]
    );
    const userById = Object.fromEntries(users.map(u => [u.id, u]));

    // 7. Fetch all personal nicknames the VIEWER has set for others
    const { rows: myNicknames } = await pool.query(
      `SELECT target_id, nickname FROM connection_nicknames WHERE creator_id = $1`,
      [viewerId]
    );
    const myNicknameMap = Object.fromEntries(myNicknames.map(n => [n.target_id, n.nickname]));

    // 8. Fetch all personal nicknames set BY the viewer's direct friends
    //    (used for degree-2+ propagation)
    //    Only propagate if: creator is public profile AND their connection to the target is public
    const { rows: friendNicknames } = await pool.query(
      `SELECT cn.creator_id, cn.target_id, cn.nickname
       FROM connection_nicknames cn
       JOIN users u ON cn.creator_id = u.id
       WHERE cn.creator_id = ANY($1::uuid[])
         AND u.is_public = true
         AND u.deleted_at IS NULL`,
      [[...myFriendIds]]
    );

    // Group friend nicknames by target_id, track which degree creator is at
    // { targetId => [ { nickname, creatorDegree } ] }
    const propagatedNicknames = {};
    for (const fn of friendNicknames) {
      // Only propagate if the creator's connection to target is public
      if (isPrivateFor(fn.creator_id, fn.target_id)) continue;
      const creatorDegree = fn.creator_id === viewerId ? 0 : (degrees.get(fn.creator_id) ?? 99);
      if (!propagatedNicknames[fn.target_id]) propagatedNicknames[fn.target_id] = [];
      propagatedNicknames[fn.target_id].push({ nickname: fn.nickname, creatorDegree });
    }

    // 9. Nickname resolution function for a given node as seen by the viewer
    function resolveNickname(nodeId, nodeDegree) {
      const u = userById[nodeId];
      if (!u) return '?';
      const ownNick = u.nickname || u.full_name?.split(' ')[0] || '?';

      // Self
      if (nodeId === viewerId) return ownNick;

      // Viewer's personal nickname for this person always wins
      if (myNicknameMap[nodeId]) return myNicknameMap[nodeId];

      // Degree 1: no propagation needed, just their own nickname
      if (nodeDegree === 1) return ownNick;

      // Degree 2+: check propagated nicknames from friends
      const propagated = propagatedNicknames[nodeId];
      if (!propagated || propagated.length === 0) return ownNick;

      // Sort by creatorDegree ascending (closest degree wins)
      propagated.sort((a, b) => a.creatorDegree - b.creatorDegree);
      const minDegree = propagated[0].creatorDegree;
      const closest = propagated.filter(p => p.creatorDegree === minDegree);

      // Multiple at same degree → join with " / "
      const nicknameStr = closest.map(p => p.nickname).join(' / ');
      return nicknameStr || ownNick;
    }

    // 10. "?" rule: public profile + private connection from an intermediate node
    //     → hide identity from the viewer, show approximate location
    function isHiddenByPrivateLink(nodeId, nodeDegree) {
      const u = userById[nodeId];
      if (!u) return false;
      if (nodeId === viewerId) return false;
      if (!u.is_public) return false; // already handled by private profile logic
      if (nodeDegree === 1) return false; // direct friend, always visible

      // Check if ALL paths to this node go through at least one private connection
      // Simplified: if none of the viewer's direct friends have a PUBLIC connection to this node
      // and this node has a public profile → show "?"
      const neighbours = adjacency.get(nodeId) || new Set();
      for (const nId of neighbours) {
        if (!myFriendIds.has(nId) && nId !== viewerId) continue;
        // nId is a direct friend of viewer (or viewer themselves)
        const connectionPrivateFromNId = isPrivateFor(nId, nodeId);
        if (!connectionPrivateFromNId) return false; // at least one public path
      }
      return true; // all paths through private connections
    }

    // 11. Build nodes
    const nodes = users.map(u => {
      const degree = u.id === viewerId ? 0 : (degrees.get(u.id) ?? null);
      const isMe   = u.id === viewerId;

      // "?" rule check
      const hiddenByPrivateLink = !isMe && isHiddenByPrivateLink(u.id, degree);

      // Coordinate resolution
      let lat, lon, isApproximate;
      if (isMe) {
        lat = u.latitude; lon = u.longitude; isApproximate = false;
      } else if (hiddenByPrivateLink) {
        // Force approximate for "?" nodes
        const a = approxCoordsForUser(u.country, u.latitude, u.longitude);
        lat = a.lat; lon = a.lon; isApproximate = true;
      } else {
        const coords = resolveCoords(u, degree);
        lat = coords.lat; lon = coords.lon; isApproximate = coords.isApproximate;
      }

      // Private profile means this person appears as "?" to anyone who is NOT
      // a direct connection (degree 1) — even if they are in the graph.
      const isPrivateToViewer = !isMe && !myFriendIds.has(u.id) && !u.is_public;
      const effectivelyHidden = hiddenByPrivateLink || isPrivateToViewer;

      // Nickname — "?" for hidden nodes, propagated/own nick for visible
      const resolvedNickname = effectivelyHidden ? '?' : resolveNickname(u.id, degree);

      // Full name — ONLY self or direct friends. Never for public profiles.
      const canSeeFullName = isMe || myFriendIds.has(u.id);

      // Notes — ONLY direct friends, AND only if posted within the last 24 hours
      const noteAge = u.daily_note_updated_at
        ? (Date.now() - new Date(u.daily_note_updated_at).getTime())
        : Infinity;
      const noteIsFresh = noteAge < 86400000;
      const canSeeNote = !isMe && myFriendIds.has(u.id) && noteIsFresh;

      // Mood — ONLY direct friends (or self), fresh within 24h
      const moodAge = u.daily_mood_updated_at
        ? (Date.now() - new Date(u.daily_mood_updated_at).getTime())
        : Infinity;
      const moodIsFresh = moodAge < 86400000;
      const canSeeMood = (isMe || myFriendIds.has(u.id)) && moodIsFresh && !!u.daily_mood;

      // City — hide exact city when location is private/hidden (show country only)
      const locationIsApprox = isApproximate || effectivelyHidden;
      const displayCity = effectivelyHidden
        ? null
        : (isApproximate ? null : u.city);

      return {
        id: u.id,
        degree,
        latitude: lat,
        longitude: lon,
        locationPrivacy: locationIsApprox,
        hiddenByPrivateLink: effectivelyHidden,
        city: displayCity,
        country: u.country,
        nickname: resolvedNickname,
        fullName: canSeeFullName ? u.full_name : null,
        isPublic: u.is_public,
        dailyNote: canSeeNote ? u.daily_note : null,
        hasNote: !isMe && myFriendIds.has(u.id) && !!u.daily_note && noteIsFresh,
        mood: canSeeMood ? u.daily_mood : null,
      };
    });

    // 12. Build edges
    const nodeIds = new Set(nodes.map(n => n.id));
    const edges   = [];

    for (const f of allFriendships) {
      const { user_id_1, user_id_2, private_for_user1, private_for_user2 } = f;
      if (!nodeIds.has(user_id_1) || !nodeIds.has(user_id_2)) continue;

      const deg1 = user_id_1 === viewerId ? 0 : (degrees.get(user_id_1) ?? 99);
      const deg2 = user_id_2 === viewerId ? 0 : (degrees.get(user_id_2) ?? 99);
      const edgeDegree = Math.max(deg1, deg2);
      if (edgeDegree > 4) continue;

      // Edge is private if either side marked it private
      const isPrivate = private_for_user1 || private_for_user2;

      // "?" edge: public profile + private connection → dashed grey
      const node1 = nodes.find(n => n.id === user_id_1);
      const node2 = nodes.find(n => n.id === user_id_2);
      const isHidden = node1?.hiddenByPrivateLink || node2?.hiddenByPrivateLink;

      edges.push({
        source: user_id_1,
        target: user_id_2,
        degree: edgeDegree,
        isPrivate: isPrivate || isHidden,
        isHidden,
      });
    }

    res.json({ nodes, edges, myId: viewerId });
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
      `SELECT id, nickname, full_name, city FROM users WHERE id = ANY($1::uuid[])`, [path]
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
