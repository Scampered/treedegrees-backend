// src/routes/grove.js — Seeds currency, stock scores, investments
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const WITHDRAW_FEE = 0.20; // 20% fee on withdrawal
const MAX_MULTIPLIER = 10;  // cap growth multiplier at 10×

// ── Award seeds for activity (called internally by other routes) ──────────────
export async function awardSeeds(userId, amount, reason, client) {
  const db = client || pool;
  // Use RETURNING to get the new value in one round-trip, inside whatever transaction is active
  const { rows: [updated] } = await db.query(
    `UPDATE users SET seeds = GREATEST(0, COALESCE(seeds, 0) + $1) WHERE id = $2 RETURNING seeds`,
    [amount, userId]
  );
  if (!updated) return;

  // Record history snapshot with the actual new value.
  // Use pool directly so history always commits even if caller rolls back.
  // We already have the new value so no second SELECT needed.
  try {
    await pool.query(
      `INSERT INTO stock_history (user_id, seeds) VALUES ($1, $2)`,
      [userId, updated.seeds]
    );
    // Async trim — fire and forget
    pool.query(
      `DELETE FROM stock_history WHERE user_id=$1 AND id NOT IN (
         SELECT id FROM stock_history WHERE user_id=$1 ORDER BY sampled_at DESC LIMIT 48
       )`, [userId]
    ).catch(() => {});
  } catch (_) { /* never block the award */ }
}

// ── Sample current score into history ────────────────────────────────────────
// Called periodically (or lazily on GET) — stores a snapshot every 3 hours max
async function maybeSampleHistory(userId) {
  // Lazy sampler: only fires on /me GET, records baseline every 30min max.
  // awardSeeds() records a point on every activity, so this mainly catches inactivity.
  const { rows: [last] } = await pool.query(
    `SELECT sampled_at FROM stock_history WHERE user_id=$1 ORDER BY sampled_at DESC LIMIT 1`,
    [userId]
  );
  const nowMs = Date.now();
  const lastMs = last ? new Date(last.sampled_at).getTime() : 0;
  if (nowMs - lastMs < 30 * 60 * 1000) return; // less than 30min ago — skip

  const { rows: [u] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [userId]);
  if (!u) return;
  await pool.query(
    `INSERT INTO stock_history (user_id, seeds) VALUES ($1, $2)`, [userId, u.seeds]
  );
  await pool.query(
    `DELETE FROM stock_history WHERE user_id=$1 AND id NOT IN (
       SELECT id FROM stock_history WHERE user_id=$1 ORDER BY sampled_at DESC LIMIT 48
     )`, [userId]
  );
}

// ── GET /api/grove/me — own stock card + history ──────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    try { await maybeSampleHistory(req.user.id); } catch (_) {}

    const { rows: [user] } = await pool.query(
      `SELECT seeds, COALESCE(nickname, split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`,
      [req.user.id]
    );

    // History: last 9 points (0, 3, 6, ... 24 hours)
    const { rows: history } = await pool.query(
      `SELECT seeds, sampled_at FROM stock_history WHERE user_id=$1 ORDER BY sampled_at ASC LIMIT 9`,
      [req.user.id]
    );

    // Total invested IN me by others
    const { rows: [inv] } = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total_invested,
              COUNT(*) AS investor_count
       FROM stock_investments WHERE target_id=$1`,
      [req.user.id]
    );

    // Synthesise 2 baseline points if no history yet so chart renders
    const histPoints = history.map(h => ({ seeds: h.seeds, ts: h.sampled_at }));
    if (histPoints.length < 2) {
      const s = user.seeds || 0;
      histPoints.unshift({ seeds: s, ts: new Date(Date.now() - 3*3600*1000).toISOString() });
    }
    res.json({
      seeds: user.seeds,
      name: user.name,
      history: histPoints,
      totalInvested: parseInt(inv.total_invested),
      investorCount: parseInt(inv.investor_count),
    });
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/grove/connections — stock cards for all direct connections ───────
router.get('/connections', requireAuth, async (req, res) => {
  try {
    // Get friend IDs first, then join — avoids CASE WHEN ambiguity
    const { rows } = await pool.query(
      `SELECT u.id, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS name,
              COALESCE(u.seeds, 0) AS seeds, u.country,
              COALESCE(si_me.amount, 0) AS my_investment,
              COALESCE(si_total.total, 0) AS total_invested,
              COALESCE(si_total.cnt, 0) AS investor_count
       FROM (
         SELECT CASE WHEN user_id_1=$1 THEN user_id_2 ELSE user_id_1 END AS friend_id
         FROM friendships
         WHERE (user_id_1=$1 OR user_id_2=$1) AND status='accepted'
       ) friends
       JOIN users u ON u.id = friends.friend_id
       LEFT JOIN stock_investments si_me
         ON si_me.investor_id=$1 AND si_me.target_id=u.id
       LEFT JOIN (
         SELECT target_id, SUM(amount) AS total, COUNT(*) AS cnt
         FROM stock_investments GROUP BY target_id
       ) si_total ON si_total.target_id = u.id
       ORDER BY COALESCE(u.seeds,0) DESC`,
      [req.user.id]
    );

    // Pull history for all connections (batched in one query)
    const histMap = {};
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      const { rows: allHist } = await pool.query(
        `SELECT user_id, seeds, sampled_at
         FROM stock_history
         WHERE user_id = ANY($1::uuid[])
         ORDER BY user_id, sampled_at ASC`,
        [ids]
      );
      // Group by user_id, keep last 9 per user
      for (const h of allHist) {
        if (!histMap[h.user_id]) histMap[h.user_id] = [];
        histMap[h.user_id].push({ seeds: h.seeds, ts: h.sampled_at });
      }
      // Trim to last 9 each
      for (const id of ids) {
        if (histMap[id] && histMap[id].length > 9)
          histMap[id] = histMap[id].slice(-9);
      }

      // If someone has no history yet, show a flat baseline so chart renders
      for (const r of rows) {
        if (!histMap[r.id] || histMap[r.id].length < 1) {
          const s = parseInt(r.seeds) || 0;
          histMap[r.id] = [
            { seeds: s, ts: new Date(Date.now() - 60*60*1000).toISOString() },
            { seeds: s, ts: new Date().toISOString() },
          ];
        } else if (histMap[r.id].length < 2) {
          // Only one point — duplicate it so sparkline has something to render
          histMap[r.id] = [histMap[r.id][0], histMap[r.id][0]];
        }
      }
    }

    res.json(rows.map(r => ({
      id: r.id, name: r.name, seeds: r.seeds,
      country: r.country,
      myInvestment: parseInt(r.my_investment),
      totalInvested: parseInt(r.total_invested),
      investorCount: parseInt(r.investor_count),
      history: histMap[r.id] || [],
    })));
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/grove/invest — invest seeds in a connection ─────────────────────
router.post('/invest', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { targetId, amount } = req.body;
    const amt = Math.floor(Number(amount));
    if (!targetId || amt < 10) return res.status(400).json({ error: 'Minimum investment is 10 seeds' });
    if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot invest in yourself' });

    // Must be a direct connection
    const [u1, u2] = [req.user.id, targetId].sort();
    const friend = await client.query(
      `SELECT 1 FROM friendships WHERE user_id_1=$1 AND user_id_2=$2 AND status='accepted'`, [u1, u2]
    );
    if (friend.rows.length === 0) return res.status(403).json({ error: 'Can only invest in direct connections' });

    // Check investor has enough seeds
    const { rows: [investor] } = await client.query(
      `SELECT seeds FROM users WHERE id=$1 FOR UPDATE`, [req.user.id]
    );
    if (investor.seeds < amt) return res.status(400).json({ error: `Not enough seeds (you have ${investor.seeds})` });

    // Check if already invested — top up
    const { rows: [existing] } = await client.query(
      `SELECT id, amount FROM stock_investments WHERE investor_id=$1 AND target_id=$2`,
      [req.user.id, targetId]
    );

    // Deduct seeds from investor
    await client.query(`UPDATE users SET seeds = seeds - $1 WHERE id=$2`, [amt, req.user.id]);

    // Record target's current seeds so we can calculate return on withdrawal
    const { rows: [tgtNow] } = await client.query(
      `SELECT seeds FROM users WHERE id=$1`, [targetId]
    );
    const targetSeedsNow = tgtNow?.seeds || 0;

    // Upsert investment
    if (existing) {
      // On top-up: weighted average seeds_at_invest
      const oldAmt = existing.amount || 0;
      const oldBaseline = existing.seeds_at_invest || targetSeedsNow;
      const weightedBaseline = Math.round((oldBaseline * oldAmt + targetSeedsNow * amt) / (oldAmt + amt));
      await client.query(
        `UPDATE stock_investments SET amount = amount + $1, seeds_at_invest = $2 WHERE id=$3`,
        [amt, weightedBaseline, existing.id]
      );
    } else {
      await client.query(
        `INSERT INTO stock_investments (investor_id, target_id, amount, seeds_at_invest) VALUES ($1,$2,$3,$4)`,
        [req.user.id, targetId, amt, targetSeedsNow]
      );
    }

    // The full investment goes to the target immediately (it's their stake)
    await client.query(`UPDATE users SET seeds = seeds + $1 WHERE id=$2`, [amt, targetId]);

    await client.query('COMMIT');

    // Record history snapshots for both parties now that seeds have changed
    try {
      const [invRow] = (await pool.query(`SELECT seeds FROM users WHERE id=$1`, [req.user.id])).rows;
      const [tgtRow] = (await pool.query(`SELECT seeds FROM users WHERE id=$1`, [targetId])).rows;
      if (invRow) await pool.query(`INSERT INTO stock_history (user_id, seeds) VALUES ($1,$2)`, [req.user.id, invRow.seeds]);
      if (tgtRow) await pool.query(`INSERT INTO stock_history (user_id, seeds) VALUES ($1,$2)`, [targetId, tgtRow.seeds]);
    } catch (_) {}

    res.json({ ok: true, invested: amt, newBalance: investor.seeds - amt });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── POST /api/grove/withdraw — withdraw investment ────────────────────────────
router.post('/withdraw', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { targetId } = req.body;

    const { rows: [inv] } = await client.query(
      `SELECT id, amount, seeds_at_invest FROM stock_investments
       WHERE investor_id=$1 AND target_id=$2 FOR UPDATE`,
      [req.user.id, targetId]
    );
    if (!inv) return res.status(404).json({ error: 'No investment found' });

    // Get target's current seeds
    const { rows: [tgtCurrent] } = await client.query(
      `SELECT seeds FROM users WHERE id=$1`, [targetId]
    );
    const currentSeeds  = tgtCurrent?.seeds || 0;
    const principal     = inv.amount; // what you originally invested

    // Baseline: target's score when you invested. Floor at 10 to prevent div/0.
    const baseline      = Math.max(10, inv.seeds_at_invest || currentSeeds);

    // Raw multiplier (how much their score changed), capped at 10×, floor at 0
    const rawMultiplier = currentSeeds / baseline;
    const multiplier    = Math.min(MAX_MULTIPLIER, Math.max(0, rawMultiplier));

    // Only 50% of your investment tracks the multiplier (active stake).
    // The other 50% is the safe/inactive half — always returned at face value.
    const activeHalf    = principal / 2;
    const safeHalf      = principal - activeHalf;
    const activeValue   = activeHalf * multiplier;
    const totalValue    = Math.floor(safeHalf + activeValue);

    // 20% fee on total value — goes to the person you invested in
    const fee           = Math.floor(totalValue * WITHDRAW_FEE);
    const payout        = totalValue - fee;

    // Return payout to investor
    await client.query(`UPDATE users SET seeds = seeds + $1 WHERE id=$2`, [payout, req.user.id]);
    // Target keeps the fee (reward for having been worth investing in)
    await client.query(`UPDATE users SET seeds = seeds + $1 WHERE id=$2`, [fee, targetId]);
    // Remove investment record
    await client.query(`DELETE FROM stock_investments WHERE id=$1`, [inv.id]);

    await client.query('COMMIT');

    // Record history for both
    try {
      const [ir] = (await pool.query(`SELECT seeds FROM users WHERE id=$1`, [req.user.id])).rows;
      const [tr] = (await pool.query(`SELECT seeds FROM users WHERE id=$1`, [targetId])).rows;
      if (ir) await pool.query(`INSERT INTO stock_history (user_id, seeds) VALUES ($1,$2)`, [req.user.id, ir.seeds]);
      if (tr) await pool.query(`INSERT INTO stock_history (user_id, seeds) VALUES ($1,$2)`, [targetId, tr.seeds]);
    } catch (_) {}

    res.json({ ok: true, returned: payout, principal, fee, multiplier: Math.round(multiplier * 100) / 100, totalValue });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── GET /api/grove/leaderboard — top 10 in your network ─────────────────────
router.get('/leaderboard', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS name,
              COALESCE(u.seeds, 0) AS seeds,
              u.country
       FROM users u
       WHERE (u.id = $1 OR u.id IN (
         SELECT CASE WHEN user_id_1=$1 THEN user_id_2 ELSE user_id_1 END
         FROM friendships WHERE (user_id_1=$1 OR user_id_2=$1) AND status='accepted'
       ))
       AND (u.deleted_at IS NULL OR u.deleted_at > NOW())
       ORDER BY COALESCE(u.seeds,0) DESC LIMIT 10`,
      [req.user.id]
    );
    res.json(rows.map((r, i) => ({
      rank: i + 1, id: r.id, name: r.name, seeds: r.seeds,
      country: r.country, isMe: r.id === req.user.id,
    })));
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
});


// ── GET /api/grove/history/:userId?window=12h|1d|1w ─────────────────────────
// Returns stock_history points filtered to the requested time window
router.get('/history/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const win = req.query.window || '1d'; // 12h | 1d | 1w

    const windowMs = win === '12h' ? 12*3600*1000
                   : win === '1w'  ? 7*24*3600*1000
                   :                 24*3600*1000; // default 1d

    // Only direct connections or self can see history
    if (userId !== req.user.id) {
      const [u1,u2] = [req.user.id, userId].sort();
      const { rows } = await pool.query(
        `SELECT 1 FROM friendships WHERE user_id_1=$1 AND user_id_2=$2 AND status='accepted'`, [u1,u2]
      );
      if (rows.length === 0) return res.status(403).json({ error: 'Not a direct connection' });
    }

    const since = new Date(Date.now() - windowMs).toISOString();
    const { rows: points } = await pool.query(
      `SELECT seeds, sampled_at FROM stock_history
       WHERE user_id=$1 AND sampled_at >= $2
       ORDER BY sampled_at ASC`,
      [userId, since]
    );

    // Current value
    const { rows:[u] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [userId]);

    // If no points in window, synthesise start and current
    const now = new Date().toISOString();
    let data = points.map(p => ({ seeds: p.seeds, ts: p.sampled_at }));
    if (data.length === 0) {
      data = [
        { seeds: u?.seeds || 0, ts: since },
        { seeds: u?.seeds || 0, ts: now },
      ];
    } else {
      // Always append current value as the most recent point
      data.push({ seeds: u?.seeds || 0, ts: now });
    }

    res.json({ data, window: win, currentSeeds: u?.seeds || 0 });
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
});

export default router;
