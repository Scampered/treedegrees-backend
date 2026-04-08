// migrate_v33: seeds_log, letter moment attachment, note moment attachment
import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
async function run() {
  const c = await pool.connect();
  try {
    await c.query(`
      -- Transaction log for grove banking view
      CREATE TABLE IF NOT EXISTS seeds_log (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount     INT NOT NULL,   -- positive = credit, negative = debit
        reason     TEXT NOT NULL,  -- e.g. 'post_memory', 'send_letter', 'like_received'
        label      TEXT NOT NULL,  -- human-readable e.g. '📸 Posted a memory'
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_seeds_log_user ON seeds_log(user_id, created_at DESC);

      -- Attach moment to letter
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS moment_id UUID REFERENCES moments(id) ON DELETE SET NULL;
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS moment_cdn_url TEXT;

      -- Attach moment to daily note (stored on users table)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS note_moment_id UUID REFERENCES moments(id) ON DELETE SET NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS note_moment_cdn_url TEXT;
    `);
    console.log('v33: seeds_log, letter/note moment attachments done');
  } catch(e) { console.error(e.message); process.exit(1); }
  finally { c.release(); await pool.end(); }
}
run();
