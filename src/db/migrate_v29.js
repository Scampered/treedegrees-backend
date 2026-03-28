import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_note_emoji VARCHAR(8) DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_note_emoji_updated_at TIMESTAMPTZ DEFAULT NULL;
    `);
    console.log('✅ v29: daily_note_emoji column added');
  } catch(e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
run();
