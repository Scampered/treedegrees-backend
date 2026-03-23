// migrate_v19 — The Canopy (economy index) + Crude (oil market)
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const sql = `
-- ── Market snapshots (price history for both markets) ──────────────────────
CREATE TABLE IF NOT EXISTS market_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market       VARCHAR(20) NOT NULL CHECK (market IN ('canopy','crude')),
  price        NUMERIC(12,4) NOT NULL,
  sampled_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_market_history_market ON market_history(market, sampled_at DESC);

-- ── Market state (current values + rolling metrics) ────────────────────────
CREATE TABLE IF NOT EXISTS market_state (
  market             VARCHAR(20) PRIMARY KEY,
  price              NUMERIC(12,4) NOT NULL DEFAULT 1000,
  price_7d_avg       NUMERIC(12,4) DEFAULT 1000,
  last_updated       TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO market_state (market, price) VALUES ('canopy', 1000), ('crude', 50)
  ON CONFLICT DO NOTHING;

-- ── Market investments (same mechanic as Grove) ────────────────────────────
CREATE TABLE IF NOT EXISTS market_investments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market           VARCHAR(20) NOT NULL CHECK (market IN ('canopy','crude')),
  amount           INT NOT NULL CHECK (amount > 0),
  price_at_invest  NUMERIC(12,4) NOT NULL,
  invested_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (investor_id, market)
);
CREATE INDEX IF NOT EXISTS idx_market_inv_investor ON market_investments(investor_id);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v19: Canopy + Crude markets...');
    await client.query(sql);
    console.log('✅ Migration v19 complete');
  } catch (err) { console.error('❌', err.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
