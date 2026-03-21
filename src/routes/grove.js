// src/routes/grove.js — Seeds currency, stock scores, investments
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const WITHDRAW_FEE = 0.20; // 20% fee on the active portion on withdrawal
const MAX_MULTIPLIER = 10;  // cap growth multiplier at 10×

// ── Award seeds for activity (called internally by other routes) ──────────────
export async function awardSeeds(userId, amount, reason, client) {
  const db = client || pool;
  const { rows: [updated] } = await db.query(
    `UPDATE users SET seeds = GREATEST(0, COALESCE(seeds, 0) + $1) WHERE id = $2 RETURNING seeds`,
    [amount, userId]
  );
  if (!updated) return;

  try {
    await pool.query(
      `INSERT INTO stock_history (user_id, seeds) VALUES ($1, $2)`,
      [userId, updated.seeds]
    );
    pool.query(
      `DELETE FROM stock_history WHERE user_id=$1 AND id NOT IN (
         SELECT id FROM stock_history WHERE user_id=$1 ORDER BY sampled_at DESC LIMIT 48
       )`, [userId]
    ).catch(() => {});
  } catch (_) { /* never block the award */ }
}

// ── Sample current score into history ────────────────────────────────────────
async function maybeSampleHistory(userId) {
  const { rows: [last] } = await pool.query(
    `SELECT sampled_at FROM stock_history WHERE user_id=$1 ORDER BY sampled_at DESC LIMIT 1`,
    [userId]
  );
  const nowMs = Date.now();
  const lastMs = last ? new Date(last.sampled_at).getTime() : 0;
  if (nowMs - lastMs < 30 * 60 * 1000) return;

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

// ── GET /api/grove/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    try { await maybeSampleHistory(req.user.id); } catch (_) {}

    const { rows: [user] } = await pool.query(
      `SELECT seeds, COALESCE(nickname, split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`,
      [req.user.id]
    );

    const { rows: history } = await pool.query(
      `SELECT seeds, sampled_at FROM stock_history WHERE user_id=$1 ORDER BY sampled_at ASC LIMIT 9`,
      [req.user.id]
    );

    const { rows: [inv] } = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total_invested,
              COUNT(*) AS investor_count
       FROM stock_investments WHERE target_id=$1`,
      [req.user.id]
    );

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

// ── GET /api/grove/connections ────────────────────────────────────────────────
router.get('/connections', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS name,
              COALESCE(u.seeds, 0) AS seeds, u.country,
              COALESCE(si_me.amount, 0) AS my_investment,
              COALESCE(si_me.seeds_at_invest, 0) AS my_seeds_at_invest,
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
      for (const h of allHist) {
        if (!histMap[h.user_id]) histMap[h.user_id] = [];
        histMap[h.user_id].push({ seeds: h.seeds, ts: h.sampled_at });
      }
      for (const id of ids) {
        if (histMap[id] && histMap[id].length > 9)
          histMap[id] = histMap[id].slice(-9);
      }

      for (const r of rows) {
        if (!histMap[r.id] || histMap[r.id].length < 1) {
          const s = parseInt(r.seeds) || 0;
          histMap[r.id] = [
            { seeds: s, ts: new Date(Date.now() - 60*60*1000).toISOString() },
            { seeds: s, ts: new Date().toISOString() },
          ];
        } else if (histMap[r.id].length < 2) {
          histMap[r.id] = [histMap[r.id][0], histMap[r.id][0]];
        }
      }
    }

    res.json(rows.map(r => ({
      id: r.id, name: r.name, seeds: r.seeds,
      country: r.country,
      myInvestment: parseInt(r.my_investment),
      mySeedsAtInvest: parseInt(r.my_seeds_at_invest) || 0,
      totalInvested: parseInt(r.total_invested),
      investorCount: parseInt(r.investor_count),
      history: histMap[r.id] || [],
    })));
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/grove/invest ────────────────────────────────────────────────────
router.post('/invest', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { targetId, amount } = req.body;
    const amt = Math.floor(Number(amount));
    if (!targetId || amt < 10) return res.status(400).json({ error: 'Minimum investment is 10 seeds' });
    if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot invest in yourself' });

    const [u1, u2] = [req.user.id, targetId].sort();
    const friend = await client.query(
      `SELECT 1 FROM friendships WHERE user_id_1=$1 AND user_id_2=$2 AND status='accepted'`, [u1, u2]
    );
    if (friend.rows.length === 0) return res.status(403).json({ error: 'Can only invest in direct connections' });

    const { rows: [investor] } = await client.query(
      `SELECT seeds FROM users WHERE id=$1 FOR UPDATE`, [req.user.id]
    );
    if (investor.seeds < amt) return res.status(400).json({ error: `Not enough seeds (you have ${investor.seeds})` });

    // Fetch full existing row including seeds_at_invest for correct top-up baseline
    const { rows: [existing] } = await client.query(
      `SELECT id, amount, seeds_at_invest FROM stock_investments WHERE investor_id=$1 AND target_id=$2`,
      [req.user.id, targetId]
    );

    // Deduct seeds from investor
    await client.query(`UPDATE users SET seeds = seeds - $1 WHERE id=$2`, [amt, req.user.id]);

    // Read target seeds BEFORE they receive this investment — this is the baseline for new money
    const { rows: [tgtNow] } = await client.query(
      `SELECT seeds FROM users WHERE id=$1`, [targetId]
    );
    const targetSeedsNow = tgtNow?.seeds || 0;

    if (existing) {
      // Top-up: weighted average of the original baseline and current seeds
      const oldAmt      = existing.amount || 0;
      const oldBaseline = existing.seeds_at_invest || targetSeedsNow;
      const weightedBaseline = Math.round(
        (oldBaseline * oldAmt + targetSeedsNow * amt) / (oldAmt + amt)
      );
      await client.query(
        `UPDATE stock_investments SET amount = amount + $1, seeds_at_invest = $2 WHERE id=$3`,
        [amt, weightedBaseline, existing.id]
      );
    } else {
      // First investment: record target's seeds right now as the baseline
      await client.query(
        `INSERT INTO stock_investments (investor_id, target_id, amount, seeds_at_invest) VALUES ($1,$2,$3,$4)`,
        [req.user.id, targetId, amt, targetSeedsNow]
      );
    }

    // Full investment amount goes to target immediately
    await client.query(`UPDATE users SET seeds = seeds + $1 WHERE id=$2`, [amt, targetId]);

    await client.query('COMMIT');

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

// ── POST /api/grove/withdraw ──────────────────────────────────────────────────
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

    const { rows: [tgtCurrent] } = await client.query(
      `SELECT seeds FROM users WHERE id=$1`, [targetId]
    );
    const currentSeeds = tgtCurrent?.seeds || 0;
    const principal    = inv.amount;

    // Baseline: target's seeds when you invested. Floor at 10 to prevent div/0.
    const baseline   = Math.max(10, inv.seeds_at_invest || currentSeeds);

    // Multiplier: how much their score has grown since you invested, capped at 10×
    const rawMultiplier = currentSeeds / baseline;
    const multiplier    = Math.min(MAX_MULTIPLIER, Math.max(0, rawMultiplier));

    // Safe half always comes back at face value, no fee
    // Active half grows with the multiplier, 20% fee on this portion only
    const activeHalf  = Math.floor(principal / 2);
    const safeHalf    = principal - activeHalf;
    const activeValue = Math.floor(activeHalf * multiplier);
    const fee         = Math.floor(activeValue * WITHDRAW_FEE);
    const payout      = safeHalf + activeValue - fee;

    // Return payout to investor
    await client.query(
      `UPDATE users SET seeds = seeds + $1 WHERE id=$2`,
      [payout, req.user.id]
    );

    // FIX: deduct the original principal from target (they held it while invested),
    // then give back just the fee as their reward for growing.
    // GREATEST(0,...) prevents going negative if something is off.
    await client.query(
      `UPDATE users SET seeds = GREATEST(0, seeds - $1) WHERE id=$2`,
      [principal, targetId]
    );
    await client.query(
      `UPDATE users SET seeds = seeds + $1 WHERE id=$2`,
      [fee, targetId]
    );

    // Remove investment record
    await client.query(`DELETE FROM stock_investments WHERE id=$1`, [inv.id]);

    await client.query('COMMIT');

    try {
      const [ir] = (await pool.query(`SELECT seeds FROM users WHERE id=$1`, [req.user.id])).rows;
      const [tr] = (await pool.query(`SELECT seeds FROM users WHERE id=$1`, [targetId])).rows;
      if (ir) await pool.query(`INSERT INTO stock_history (user_id, seeds) VALUES ($1,$2)`, [req.user.id, ir.seeds]);
      if (tr) await pool.query(`INSERT INTO stock_history (user_id, seeds) VALUES ($1,$2)`, [targetId, tr.seeds]);
    } catch (_) {}

    res.json({
      ok: true,
      returned: payout,
      principal,
      fee,
      multiplier: Math.round(multiplier * 100) / 100,
      activeValue,
      safeHalf,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── GET /api/grove/leaderboard ────────────────────────────────────────────────
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

// ── GET /api/grove/history/:userId ───────────────────────────────────────────
router.get('/history/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const win = req.query.window || '1d';

    const windowMs = win === '12h' ? 12*3600*1000
                   : win === '1w'  ? 7*24*3600*1000
                   :                 24*3600*1000;

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

    const { rows:[u] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [userId]);

    const now = new Date().toISOString();
    let data = points.map(p => ({ seeds: p.seeds, ts: p.sampled_at }));
    if (data.length === 0) {
      data = [
        { seeds: u?.seeds || 0, ts: since },
        { seeds: u?.seeds || 0, ts: now },
      ];
    } else {
      data.push({ seeds: u?.seeds || 0, ts: now });
    }

    res.json({ data, window: win, currentSeeds: u?.seeds || 0 });
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
});

export default router;
