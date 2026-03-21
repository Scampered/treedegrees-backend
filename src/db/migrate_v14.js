// src/db/migrate_v14.js — mood emoji
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const migration = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_mood VARCHAR(10) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_mood_updated_at TIMESTAMPTZ DEFAULT NULL;
`;
async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v14: mood emoji...');
    await client.query(migration);
    console.log('✅ Migration v14 complete');
  } catch (err) { console.error('❌', err.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
