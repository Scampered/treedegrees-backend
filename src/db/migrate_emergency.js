// Run this on Render shell or locally with DATABASE_URL set
// Adds missing columns that recent code expects
import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

async function run() {
  const c = await pool.connect()
  try {
    await c.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS note_moment_cdn_url TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS note_moment_id UUID;
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS moment_id UUID;
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS moment_cdn_url TEXT;
      CREATE TABLE IF NOT EXISTS seeds_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount INT NOT NULL,
        reason TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `)
    console.log('✓ All missing columns and tables added')
  } catch(e) {
    console.error('Error:', e.message)
  } finally {
    c.release()
    await pool.end()
  }
}
run()
