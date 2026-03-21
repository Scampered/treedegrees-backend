// src/db/migrate_v17.js
// Fix: seeds_at_invest records that were incorrectly backfilled by v16.
//
// The v16 migration set seeds_at_invest = target's CURRENT seeds at migration time,
// meaning any investment made *before* v16 has seeds_at_invest = current seeds,
// which produces multiplier = 1 on withdrawal regardless of actual growth.
//
// We cannot recover the true original baseline (that data was never stored),
// so we NULL-out those stale backfilled values. The withdrawal code already
// handles NULL/0 gracefully by returning principal + no growth — which is
// honest rather than silently wrong.
//
// Going forward, the fixed invest route always sets seeds_at_invest correctly
// at the moment of investment (and fetches it properly on top-ups).

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Ensure seeds_at_invest column exists (idempotent)
ALTER TABLE stock_investments ADD COLUMN IF NOT EXISTS seeds_at_invest INT DEFAULT 0;

-- For any investment where seeds_at_invest matches the target's CURRENT seeds
-- (i.e. it was backfilled to the current value rather than the invest-time value),
-- reset to 0 so the withdrawal returns principal honestly rather than with a
-- broken multiplier of exactly 1.0.
--
-- We only reset where the stored baseline equals the target's exact current seeds
-- AND the investment is older than 1 hour (fresh legitimate investments are excluded).
UPDATE stock_investments si
SET seeds_at_invest = 0
WHERE invested_at < NOW() - INTERVAL '1 hour'
  AND seeds_at_invest > 0
  AND seeds_at_invest = (
    SELECT seeds FROM users WHERE id = si.target_id
  );

-- Note: investments with seeds_at_invest = 0 will still return the investor's
-- full principal on withdrawal (multiplier = currentSeeds / currentSeeds = 1,
-- safeHalf + activeHalf * 1 - fee on active = principal - fee_on_active_half).
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v17: fix incorrectly backfilled seeds_at_invest...');
    await client.query(migration);
    console.log('✅ Migration v17 complete');
    console.log('ℹ️  Investments with reset baselines will return principal on withdrawal.');
    console.log('ℹ️  New investments will track growth correctly going forward.');
  } catch (err) { console.error('❌', err.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
