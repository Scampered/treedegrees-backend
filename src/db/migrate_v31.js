import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl:{ rejectUnauthorized:false }});
async function run() {
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS moments (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        r2_key      TEXT NOT NULL,
        cdn_url     TEXT NOT NULL,
        caption     TEXT DEFAULT '',
        note_emoji  VARCHAR(8),
        expires_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS moment_tags (
        moment_id UUID NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
        user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (moment_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS letter_moments (
        letter_id  UUID NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
        moment_id  UUID NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
        PRIMARY KEY (letter_id, moment_id)
      );
      CREATE INDEX IF NOT EXISTS idx_moments_uploader ON moments(uploader_id);
      CREATE INDEX IF NOT EXISTS idx_moments_expires ON moments(expires_at);
      CREATE INDEX IF NOT EXISTS idx_moment_tags_user ON moment_tags(user_id);
    `);
    console.log('v31: moments tables created');
  } catch(e) { console.error(e.message); process.exit(1); }
  finally { c.release(); await pool.end(); }
}
run();
