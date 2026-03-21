// src/db/migrate_v16.js — add seeds_at_invest to track target score at time of investment
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
ALTER TABLE stock_investments ADD COLUMN IF NOT EXISTS seeds_at_invest INT DEFAULT 0;

-- Backfill: set seeds_at_invest = current target seeds for existing investments
-- (not perfect but needed so existing investments don't produce wrong returns)
UPDATE stock_investments si
SET seeds_at_invest = COALESCE((SELECT seeds FROM users WHERE id = si.target_id), 0)
WHERE seeds_at_invest = 0;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v16: seeds_at_invest...');
    await client.query(migration);
    console.log('✅ Migration v16 complete');
  } catch (err) { console.error('❌', err.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
