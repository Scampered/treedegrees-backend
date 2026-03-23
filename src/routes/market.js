// src/routes/market.js — The Canopy (economy) + Crude (oil) markets
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { awardSeeds } from './grove.js';

const router = Router();

const WITHDRAW_FEE_RATE = (principal) => {
  if (principal < 50)  return 0.08;
  if (principal < 150) return 0.12;
  if (principal < 300) return 0.16;
  return 0.20;
};
const MAX_MULTIPLIER = 10;

// ── Internal: update market price ─────────────────────────────────────────────
export async function updateMarketPrice(market, delta, client) {
  const db = client || pool;
  const { rows: [state] } = await db.query(
    `UPDATE market_state SET price = GREATEST(1, price + $1), last_updated = NOW()
     WHERE market = $2 RETURNING price`,
    [delta, market]
  );
  if (!state) return;
  // Record history point
  await pool.query(
    `INSERT INTO market_history (market, price) VALUES ($1, $2)`,
    [market, state.price]
  );
  // Trim to 288 points (2 points/hour × 6 days)
  await pool.query(
    `DELETE FROM market_history WHERE market=$1 AND id NOT IN (
       SELECT id FROM market_history WHERE market=$1 ORDER BY sampled_at DESC LIMIT 288
     )`, [market]
  );
  return state.price;
}

// ── Internal: compute crude price effect on economy ──────────────────────────
export async function applyCrudeEconomyEffect(client) {
  const db = client || pool;
  const { rows: [crude] }  = await db.query(`SELECT price FROM market_state WHERE market='crude'`);
  const { rows: [canopy] } = await db.query(`SELECT price FROM market_state WHERE market='canopy'`);
  if (!crude || !canopy) return;

  // When crude > 70 (high oil), economy takes a drag proportional to excess
  const CRUDE_NORMAL = 50;
  const excess = Math.max(0, crude.price - CRUDE_NORMAL);
  if (excess > 5) {
    const drag = Math.floor(excess * 0.3); // 0.3 economy points lost per 1 oil point above 50
    await updateMarketPrice('canopy', -drag, client);
    console.log(`[Market] Crude drag: −${drag} to canopy (crude=${crude.price})`);
  }
}

// ── Internal: get crude delivery multiplier (for letters/couriers) ────────────
export async function getCrudeDeliveryMultiplier() {
  try {
    const { rows: [s] } = await pool.query(`SELECT price FROM market_state WHERE market='crude'`);
    const price = s?.price || 50;
    // Normal price = 50. At 100 = 2× delivery time. At 25 = 0.75× delivery time.
    return Math.max(0.5, Math.min(2.5, price / 50));
  } catch { return 1; }
}

// ── GET /api/market/state — current prices + 7d avg ───────────────────────────
router.get('/state', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM market_state`);
    const state = {}
    for (const r of rows) state[r.market] = { price: parseFloat(r.price), avg7d: parseFloat(r.price_7d_avg), lastUpdated: r.last_updated }
    res.json(state)
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/market/history/:market?window=1h|6h|12h|1d|1w ───────────────────
router.get('/history/:market', requireAuth, async (req, res) => {
  try {
    const { market } = req.params;
    if (!['canopy','crude'].includes(market)) return res.status(400).json({ error: 'Invalid market' });
    const win = req.query.window || '1d';
    const windowMs = win==='1h'?3600000 : win==='6h'?6*3600000 : win==='12h'?12*3600000 : win==='1w'?7*24*3600000 : 24*3600000;
    const since = new Date(Date.now() - windowMs).toISOString();
    const { rows } = await pool.query(
      `SELECT price, sampled_at FROM market_history WHERE market=$1 AND sampled_at >= $2 ORDER BY sampled_at ASC`,
      [market, since]
    );
    const { rows: [state] } = await pool.query(`SELECT price FROM market_state WHERE market=$1`, [market]);
    const now = new Date().toISOString();
    let data = rows.map(r => ({ seeds: parseFloat(r.price), ts: r.sampled_at }));
    if (data.length === 0) {
      data = [{ seeds: parseFloat(state?.price||1000), ts: since }, { seeds: parseFloat(state?.price||1000), ts: now }];
    } else {
      data.push({ seeds: parseFloat(state?.price||data[data.length-1].seeds), ts: now });
    }
    res.json({ data, window: win, currentPrice: parseFloat(state?.price || 0) });
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/market/my-positions ──────────────────────────────────────────────
router.get('/my-positions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT mi.*, ms.price AS current_price
       FROM market_investments mi JOIN market_state ms ON ms.market = mi.market
       WHERE mi.investor_id = $1`,
      [req.user.id]
    );
    res.json(rows.map(r => ({
      market: r.market,
      amount: r.amount,
      priceAtInvest: parseFloat(r.price_at_invest),
      currentPrice: parseFloat(r.current_price),
      investedAt: r.invested_at,
    })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/market/invest ───────────────────────────────────────────────────
router.post('/invest', requireAuth, async (req, res) => {
  const { market, amount } = req.body;
  const amt = Math.floor(Number(amount));
  if (!['canopy','crude'].includes(market)) return res.status(400).json({ error: 'Invalid market' });
  if (!amt || amt < 10) return res.status(400).json({ error: 'Minimum investment is 10 seeds' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows:[investor] } = await client.query(`SELECT seeds FROM users WHERE id=$1 FOR UPDATE`, [req.user.id]);
    if (!investor || investor.seeds < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Not enough seeds (you have ${investor?.seeds ?? 0})` });
    }
    const { rows:[state] } = await client.query(`SELECT price FROM market_state WHERE market=$1`, [market]);
    const { rows:[existing] } = await client.query(
      `SELECT id, amount FROM market_investments WHERE investor_id=$1 AND market=$2 FOR UPDATE`,
      [req.user.id, market]
    );

    await client.query(`UPDATE users SET seeds = seeds - $1 WHERE id=$2`, [amt, req.user.id]);

    if (existing) {
      const newAmt = existing.amount + amt;
      // Weighted average price
      const newPrice = ((existing.amount * parseFloat(state.price)) + (amt * parseFloat(state.price))) / newAmt;
      await client.query(
        `UPDATE market_investments SET amount=$1, price_at_invest=$2 WHERE id=$3`,
        [newAmt, newPrice, existing.id]
      );
    } else {
      await client.query(
        `INSERT INTO market_investments (investor_id, market, amount, price_at_invest) VALUES ($1,$2,$3,$4)`,
        [req.user.id, market, amt, state.price]
      );
    }

    // Investment activity lifts the canopy slightly
    if (market === 'canopy') {
      await updateMarketPrice('canopy', Math.floor(amt * 0.01), client);
    }
    // Investing in crude nudges price up slightly (demand signal)
    if (market === 'crude') {
      await updateMarketPrice('crude', Math.floor(amt * 0.005), client);
      await applyCrudeEconomyEffect(client);
    }

    await client.query('COMMIT');
    res.json({ ok: true, invested: amt });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── POST /api/market/withdraw ─────────────────────────────────────────────────
router.post('/withdraw', requireAuth, async (req, res) => {
  const { market, withdrawAmount } = req.body;
  if (!['canopy','crude'].includes(market)) return res.status(400).json({ error: 'Invalid market' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows:[inv] } = await client.query(
      `SELECT id, amount, price_at_invest FROM market_investments WHERE investor_id=$1 AND market=$2 FOR UPDATE`,
      [req.user.id, market]
    );
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No position found' }); }
    const { rows:[state] } = await client.query(`SELECT price FROM market_state WHERE market=$1 FOR UPDATE`, [market]);

    const totalPrincipal = inv.amount;
    const reqAmt = withdrawAmount ? Math.floor(Number(withdrawAmount)) : totalPrincipal;
    if (reqAmt < 1 || reqAmt > totalPrincipal) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Withdraw between 1 and ${totalPrincipal}` });
    }

    const isPartial  = reqAmt < totalPrincipal;
    const fraction   = reqAmt / totalPrincipal;
    const principal  = Math.floor(totalPrincipal * fraction);
    const baseline   = Math.max(1, parseFloat(inv.price_at_invest));
    const currentP   = parseFloat(state.price);
    const rawMult    = currentP / baseline;
    const multiplier = Math.min(MAX_MULTIPLIER, Math.max(0, rawMult));

    const activeHalf  = Math.floor(principal / 2);
    const safeHalf    = principal - activeHalf;
    const activeValue = Math.floor(activeHalf * multiplier);
    const feeRate     = WITHDRAW_FEE_RATE(principal);
    const fee         = Math.floor(activeValue * feeRate);
    const payout      = safeHalf + activeValue - fee;

    await awardSeeds(req.user.id, payout, 'market_withdraw', client);

    if (isPartial) {
      await client.query(`UPDATE market_investments SET amount=$1 WHERE id=$2`, [totalPrincipal - principal, inv.id]);
    } else {
      await client.query(`DELETE FROM market_investments WHERE id=$1`, [inv.id]);
    }

    // Withdrawal drags the market slightly (confidence signal)
    const drag = Math.floor(principal * 0.005);
    await updateMarketPrice(market, -drag, client);
    if (market === 'crude') await applyCrudeEconomyEffect(client);

    await client.query('COMMIT');
    res.json({ ok: true, returned: payout, principal, fee, multiplier: Math.round(multiplier*100)/100, partial: isPartial });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

export default router;
