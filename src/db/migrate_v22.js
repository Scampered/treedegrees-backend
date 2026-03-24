// migrate_v22 — job action tables for all 7 jobs
import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const sql = `
-- ── COURIER ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS courier_vehicles (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier           VARCHAR(20) DEFAULT 'van',   -- van, bus, airfreight, rocket
  deliveries     INT DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS courier_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  courier_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_country   TEXT NOT NULL,
  to_country     TEXT NOT NULL,
  est_hours      NUMERIC(6,1) NOT NULL,
  fee_seeds      INT NOT NULL DEFAULT 20,
  status         VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','delivered','expired')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  accepted_at    TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_courier_req_courier ON courier_requests(courier_id, status);
CREATE INDEX IF NOT EXISTS idx_courier_req_requester ON courier_requests(requester_id);

-- ── WRITER ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS writer_commissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  writer_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt         TEXT NOT NULL,
  content        TEXT DEFAULT '',
  fee_seeds      INT NOT NULL DEFAULT 10,
  status         VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','submitted','accepted','rejected')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  submitted_at   TIMESTAMPTZ,
  resolved_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_writer_comm_writer ON writer_commissions(writer_id, status);
CREATE INDEX IF NOT EXISTS idx_writer_comm_client ON writer_commissions(client_id);

-- ── SEED BROKER ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broker_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  escrow_seeds     INT NOT NULL DEFAULT 0,
  duration_hours   INT NOT NULL DEFAULT 24,
  target_type      VARCHAR(20) DEFAULT 'grove' CHECK (target_type IN ('grove','canopy','crude')),
  target_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  price_at_invest  NUMERIC(12,4) DEFAULT 0,
  status           VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','closed','recalled')),
  started_at       TIMESTAMPTZ DEFAULT NOW(),
  closes_at        TIMESTAMPTZ,
  UNIQUE(broker_id, client_id, status)
);
CREATE INDEX IF NOT EXISTS idx_broker_sessions_broker ON broker_sessions(broker_id);
CREATE INDEX IF NOT EXISTS idx_broker_sessions_client ON broker_sessions(client_id);

-- ── ACCOUNTANT ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accountant_clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  accountant_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fee_seeds       INT NOT NULL DEFAULT 40,
  status          VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','ended')),
  last_report_at  TIMESTAMPTZ,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(accountant_id, client_id)
);

CREATE TABLE IF NOT EXISTS accountant_advice (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES accountant_clients(id) ON DELETE CASCADE,
  action          VARCHAR(20) NOT NULL CHECK (action IN ('buy','sell','hold')),
  amount          INT DEFAULT 0,
  note            TEXT DEFAULT '',
  investment_idx  INT DEFAULT 0,  -- index in client's investment list (not name)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  read_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_accountant_advice_session ON accountant_advice(session_id);

-- ── STEWARD ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS steward_clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steward_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fee_seeds       INT NOT NULL DEFAULT 30,
  retainer_days   INT NOT NULL DEFAULT 7,
  last_paid_at    TIMESTAMPTZ DEFAULT NOW(),
  status          VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','ended')),
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(steward_id, client_id)
);

-- ── FORECASTER ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS forecaster_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  forecaster_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_forecaster_posts ON forecaster_posts(forecaster_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forecaster_subscribers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  forecaster_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscriber_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscribed_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(forecaster_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS idx_forecaster_subs ON forecaster_subscribers(forecaster_id);

-- ── FARMER ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS farmer_plots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_index      INT NOT NULL CHECK (slot_index BETWEEN 0 AND 4),
  depositor_id    UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL = farmer's own seeds
  seeds_deposited INT NOT NULL DEFAULT 0,
  fee_per_seed    INT NOT NULL DEFAULT 20,
  planted_at      TIMESTAMPTZ,
  harvest_at      TIMESTAMPTZ,
  status          VARCHAR(20) DEFAULT 'empty' CHECK (status IN ('empty','planted','ready','harvested','rotten')),
  harvest_result  INT DEFAULT 0,
  UNIQUE(farmer_id, slot_index)
);
CREATE INDEX IF NOT EXISTS idx_farmer_plots ON farmer_plots(farmer_id);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v22: job action tables...');
    await client.query(sql);
    // Seed courier vehicle rows for existing couriers
    await client.query(`
      INSERT INTO courier_vehicles (user_id)
      SELECT user_id FROM jobs WHERE role='courier'
      ON CONFLICT DO NOTHING
    `);
    // Seed farmer plot slots for existing farmers
    await client.query(`
      INSERT INTO farmer_plots (farmer_id, slot_index, seeds_deposited, status)
      SELECT j.user_id, g.slot, 0, 'empty'
      FROM jobs j CROSS JOIN generate_series(0,4) g(slot)
      WHERE j.role='farmer'
      ON CONFLICT DO NOTHING
    `);
    console.log('✅ v22 complete');
  } catch (e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
