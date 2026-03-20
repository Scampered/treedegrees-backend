// src/db/migrate_v13b.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const migration = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS game_points INT DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_points ON users(game_points DESC);
`;
async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v13b: game_points column...');
    await client.query(migration);
    console.log('✅ Migration v13b complete');
  } catch (err) { console.error('❌', err.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
