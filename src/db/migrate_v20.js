// migrate_v20 — push_subscriptions table for background notifications
import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v20: push_subscriptions...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint    TEXT NOT NULL UNIQUE,
        p256dh      TEXT NOT NULL,
        auth        TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
    `);
    console.log('✅ v20 complete');
  } catch (e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
