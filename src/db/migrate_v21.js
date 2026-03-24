// migrate_v21 — jobs system + location cooldown
import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const sql = `
-- Location change cooldown
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_changed_at TIMESTAMPTZ DEFAULT NULL;

-- Jobs registry: one row per employed user
CREATE TABLE IF NOT EXISTS jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  role         VARCHAR(30) NOT NULL CHECK (role IN ('courier','writer','seed_broker','accountant','steward','forecaster','farmer')),
  active       BOOLEAN DEFAULT true,
  hourly_rate  INT DEFAULT 0,        -- seeds/unit, role-specific meaning
  bio          TEXT DEFAULT '',
  rating_sum   INT DEFAULT 0,
  rating_count INT DEFAULT 0,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_role   ON jobs(role) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_jobs_user   ON jobs(user_id);

-- Ratings
CREATE TABLE IF NOT EXISTS job_ratings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  rater_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review     TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (job_id, rater_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_job ON job_ratings(job_id);

-- Job clients (steward, accountant, forecaster subscriptions, broker wallets)
CREATE TABLE IF NOT EXISTS job_clients (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  client_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','pending','ended')),
  escrow_seeds INT DEFAULT 0,   -- for broker: seeds held in escrow
  terms        JSONB DEFAULT '{}',
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (job_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_job_clients_job    ON job_clients(job_id);
CREATE INDEX IF NOT EXISTS idx_job_clients_client ON job_clients(client_id);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v21: jobs system...');
    await client.query(sql);
    console.log('✅ v21 complete');
  } catch (e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
