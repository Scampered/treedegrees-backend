import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Steward: nudge tracking
      ALTER TABLE steward_clients ADD COLUMN IF NOT EXISTS last_nudge_at TIMESTAMPTZ;
      ALTER TABLE steward_clients ADD COLUMN IF NOT EXISTS nudges_today INT DEFAULT 0;
      ALTER TABLE steward_clients ADD COLUMN IF NOT EXISTS nudge_reset_date DATE;
      ALTER TABLE steward_clients ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

      -- Broker: per-allocation tracking (multiple investments in one session)
      CREATE TABLE IF NOT EXISTS broker_allocations (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id     UUID NOT NULL REFERENCES broker_sessions(id) ON DELETE CASCADE,
        target_type    VARCHAR(20) NOT NULL,
        target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        amount         INT NOT NULL,
        price_at_invest NUMERIC(12,4) DEFAULT 0,
        settled        BOOLEAN DEFAULT false,
        settled_at     TIMESTAMPTZ,
        return_amount  INT DEFAULT 0,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_broker_alloc_session ON broker_allocations(session_id);

      -- Service responses: read tracking
      CREATE TABLE IF NOT EXISTS service_response_reads (
        user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id)
      );

      -- Writer commissions: keep writer_id even after job deletion
      ALTER TABLE writer_commissions ALTER COLUMN writer_id DROP NOT NULL;
    `);
    console.log('✅ v26 complete');
  } catch(e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
run();
