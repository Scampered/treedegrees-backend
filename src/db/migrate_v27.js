import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        VARCHAR(40) NOT NULL,
        -- types: letter_arrived, letter_sent, streak_warning, streak_saved,
        --        grove_invest, grove_withdraw, seeds_earned,
        --        job_hired, job_advice, job_commission, job_nudge,
        --        connection_request, connection_accepted,
        --        note_posted, forecaster_post
        title       TEXT NOT NULL,
        body        TEXT DEFAULT '',
        link        TEXT DEFAULT '/dashboard',
        read        BOOLEAN DEFAULT false,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id, read) WHERE read = false;
    `);
    console.log('✅ v27: notifications table created');
  } catch(e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
run();
