import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
async function run() {
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS moment_likes (
        moment_id UUID NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
        user_id   UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (moment_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS moment_comments (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        moment_id  UUID NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
        text       TEXT NOT NULL CHECK(length(text)<=120),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_moment_likes_moment ON moment_likes(moment_id);
      CREATE INDEX IF NOT EXISTS idx_moment_comments_moment ON moment_comments(moment_id);
    `);
    console.log('v32: moment_likes + moment_comments tables created');
  } catch(e) { console.error(e.message); process.exit(1); }
  finally { c.release(); await pool.end(); }
}
run();
