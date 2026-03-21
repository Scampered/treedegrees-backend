import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const migration = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS seeds INT DEFAULT 0;
UPDATE users SET seeds = 0;
CREATE TABLE IF NOT EXISTS stock_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seeds      INT NOT NULL DEFAULT 0,
  sampled_at TIMESTAMPTZ DEFAULT NOW()
);
-- Remove score column if it exists from an old version
DO $$ BEGIN
  ALTER TABLE stock_history DROP COLUMN IF EXISTS score;
EXCEPTION WHEN others THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_sh_user_time ON stock_history(user_id, sampled_at DESC);
CREATE TABLE IF NOT EXISTS stock_investments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       INT NOT NULL CHECK(amount > 0),
  invested_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(investor_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_si_investor ON stock_investments(investor_id);
CREATE INDEX IF NOT EXISTS idx_si_target   ON stock_investments(target_id);
`;
async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v15: seeds + stock tables (reset)...');
    await client.query(migration);
    console.log('✅ v15 complete');
  } catch (err) { console.error('❌', err.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
