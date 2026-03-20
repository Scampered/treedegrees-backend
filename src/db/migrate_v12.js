// src/db/migrate_v12.js — node src/db/migrate_v12.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Mute settings for groups (per user per group)
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS muted BOOLEAN DEFAULT false;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v12: group mute...');
    await client.query(migration);
    console.log('✅ Migration v12 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
