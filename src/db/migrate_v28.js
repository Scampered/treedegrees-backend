import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS note_likes (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        liker_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji       VARCHAR(8) NOT NULL DEFAULT '🌿',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(liker_id, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_note_likes_target ON note_likes(target_id);
      CREATE INDEX IF NOT EXISTS idx_note_likes_liker  ON note_likes(liker_id);
    `);
    console.log('✅ v28: note_likes table created');
  } catch(e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
run();
