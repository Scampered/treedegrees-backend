// src/utils/marketEvents.js
// Market event hooks — debounced to prevent connection pool exhaustion.
// Events are queued and flushed every 5 seconds in a single batch query.
import pool from '../db/pool.js';

let queue = { canopy: 0, crude: 0 };
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const { canopy, crude } = queue;
    queue = { canopy: 0, crude: 0 };
    if (canopy !== 0) await batchUpdate('canopy', canopy).catch(() => {});
    if (crude  !== 0) await batchUpdate('crude',  crude ).catch(() => {});
  }, 5000); // flush every 5 seconds
}

async function batchUpdate(market, delta) {
  const { rows: [state] } = await pool.query(
    `UPDATE market_state SET price = GREATEST(1, price + $1), last_updated = NOW()
     WHERE market = $2 RETURNING price`,
    [delta, market]
  );
  if (!state) return;
  await pool.query(
    `INSERT INTO market_history (market, price) VALUES ($1, $2)`,
    [market, state.price]
  );
  // Trim history async
  pool.query(
    `DELETE FROM market_history WHERE market=$1 AND id NOT IN (
       SELECT id FROM market_history WHERE market=$1 ORDER BY sampled_at DESC LIMIT 288
     )`, [market]
  ).catch(() => {});

  // Apply crude→canopy drag inline if crude changed
  if (market === 'crude') {
    const { rows: [crude] }  = await pool.query(`SELECT price FROM market_state WHERE market='crude'`);
    const excess = Math.max(0, (crude?.price || 50) - 50);
    if (excess > 5) {
      const drag = Math.max(1, Math.floor(excess * 0.3));
      queue.canopy -= drag; // add to next canopy flush
      scheduleFlush();
    }
  }
}

// Public interface — accumulate deltas, flush in batch
function queueDelta(market, delta) {
  queue[market] = (queue[market] || 0) + delta;
  scheduleFlush();
}

export function onLetterSent(distanceKm) {
  const fuelUsed = Math.max(1, Math.round(distanceKm / 5000));
  queueDelta('crude',  +fuelUsed);
  queueDelta('canopy', +2);
}

export function onLetterArrived() {
  queueDelta('canopy', +1);
}

export function onStreakBroken() {
  queueDelta('canopy', -3);
}

export function onStreakMilestone() {
  queueDelta('canopy', +2);
}

export function onNotePosted() {
  queueDelta('canopy', +1);
}

export function onGroveInvestment(amount) {
  const bump = Math.max(1, Math.floor(amount * 0.05));
  queueDelta('canopy', +bump);
}

export function onGroveWithdrawal(amount) {
  const drag = Math.max(1, Math.floor(amount * 0.02));
  queueDelta('canopy', -drag);
}

export async function applyWeekendBonus() {
  const day = new Date().getDay();
  if (day === 0 || day === 6) {
    await batchUpdate('canopy', +10).catch(() => {});
    console.log('[Market] Weekend bonus applied');
  }
}

export async function applyDailyDecay() {
  const { rows } = await pool.query(`SELECT market, price FROM market_state`);
  for (const r of rows) {
    const price    = parseFloat(r.price);
    const baseline = r.market === 'canopy' ? 1000 : 50;
    const drift    = Math.round((baseline - price) * 0.02);
    if (Math.abs(drift) >= 1) {
      await batchUpdate(r.market, drift).catch(() => {});
    }
  }
}

// Export batchUpdate for market.js to use directly (invest/withdraw)
export { batchUpdate as updateMarketPrice };
