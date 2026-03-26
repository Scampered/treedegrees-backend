import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const client = await pool.connect();
  try {
    // Drop unique constraint on broker_sessions so multiple closed sessions can exist
    await client.query(`ALTER TABLE broker_sessions DROP CONSTRAINT IF EXISTS broker_sessions_broker_id_client_id_status_key`);
    // Add unique only on active sessions (partial index)
    await client.query(`DROP INDEX IF EXISTS idx_broker_one_active_per_pair`);
    await client.query(`CREATE UNIQUE INDEX idx_broker_one_active_per_pair ON broker_sessions(broker_id, client_id) WHERE status='active'`);
    // Add refunded status to courier_requests
    await client.query(`ALTER TABLE courier_requests DROP CONSTRAINT IF EXISTS courier_requests_status_check`);
    await client.query(`ALTER TABLE courier_requests ADD CONSTRAINT courier_requests_status_check CHECK (status IN ('pending','accepted','declined','delivered','expired','refunded'))`);
    // Add refunded status to writer_commissions
    await client.query(`ALTER TABLE writer_commissions DROP CONSTRAINT IF EXISTS writer_commissions_status_check`);
    await client.query(`ALTER TABLE writer_commissions ADD CONSTRAINT writer_commissions_status_check CHECK (status IN ('pending','submitted','accepted','rejected','refunded'))`);
    // Add settled to broker_sessions status
    await client.query(`ALTER TABLE broker_sessions DROP CONSTRAINT IF EXISTS broker_sessions_status_check`);
    await client.query(`ALTER TABLE broker_sessions ADD CONSTRAINT broker_sessions_status_check CHECK (status IN ('active','closed','recalled','settled'))`);
    // Add vehicle_tier value for steward nudge letters
    await client.query(`ALTER TABLE letters DROP CONSTRAINT IF EXISTS letters_vehicle_tier_check`).catch(() => {});
    console.log('✅ v25: broker unique index fixed, status enums updated');
  } catch(e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
run();
