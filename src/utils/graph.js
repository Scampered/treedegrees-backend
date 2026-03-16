// src/utils/graph.js
// Breadth-First Search to compute degrees of separation in the social graph

/**
 * Given an adjacency list (Map<userId, Set<userId>>),
 * compute shortest-path degrees from `sourceId` to all reachable nodes.
 *
 * Returns Map<userId, degree> where degree is 1 (direct friend), 2, or 3.
 * Nodes beyond degree 3 are omitted for performance.
 */
export function computeDegrees(adjacency, sourceId, maxDegree = 3) {
  const degrees = new Map();
  const visited = new Set([sourceId]);
  const queue = [{ id: sourceId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift();

    if (depth > maxDegree) break;

    const neighbors = adjacency.get(id) || new Set();
    for (const neighborId of neighbors) {
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        const degree = depth + 1;
        degrees.set(neighborId, degree);
        if (degree < maxDegree) {
          queue.push({ id: neighborId, depth: degree });
        }
      }
    }
  }

  return degrees;
}

/**
 * Build adjacency list from flat friendship rows.
 * Each row: { user_id_1, user_id_2 } (accepted only)
 */
export function buildAdjacency(friendshipRows) {
  const adj = new Map();

  for (const { user_id_1, user_id_2 } of friendshipRows) {
    if (!adj.has(user_id_1)) adj.set(user_id_1, new Set());
    if (!adj.has(user_id_2)) adj.set(user_id_2, new Set());
    adj.get(user_id_1).add(user_id_2);
    adj.get(user_id_2).add(user_id_1);
  }

  return adj;
}

/**
 * Find the shortest path between two users using BFS.
 * Returns array of user IDs representing the path, or null if disconnected.
 */
export function findPath(adjacency, fromId, toId, maxDepth = 6) {
  if (fromId === toId) return [fromId];

  const visited = new Set([fromId]);
  const queue = [{ id: fromId, path: [fromId] }];

  while (queue.length > 0) {
    const { id, path } = queue.shift();
    if (path.length > maxDepth + 1) return null;

    const neighbors = adjacency.get(id) || new Set();
    for (const neighborId of neighbors) {
      if (neighborId === toId) return [...path, neighborId];
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        queue.push({ id: neighborId, path: [...path, neighborId] });
      }
    }
  }

  return null; // disconnected
}
