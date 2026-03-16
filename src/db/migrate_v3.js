// src/db/migrate_v3.js
// Run once: node src/db/migrate_v3.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Add nickname to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS nickname VARCHAR(50);

-- Per-side friendship privacy:
-- private_for_user1 = user_id_1 has made this connection private
-- private_for_user2 = user_id_2 has made this connection private
ALTER TABLE friendships
  ADD COLUMN IF NOT EXISTS private_for_user1 BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS private_for_user2 BOOLEAN DEFAULT false;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v3: nickname + per-side friendship privacy...');
    await client.query(migration);
    console.log('✅ Migration v3 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
