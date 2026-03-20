// src/db/migrate_v11.js — node src/db/migrate_v11.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Add invite status to group_members
-- status: 'pending' (invited, not yet accepted) | 'accepted' | 'declined'
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS status VARCHAR(10) DEFAULT 'accepted';
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(id);
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ DEFAULT NOW();

-- Back-fill existing rows as accepted
UPDATE group_members SET status = 'accepted' WHERE status IS NULL;

-- Index for invite lookups
CREATE INDEX IF NOT EXISTS idx_gm_status ON group_members(status);
CREATE INDEX IF NOT EXISTS idx_gm_invited ON group_members(user_id, status);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v11: group invite flow...');
    await client.query(migration);
    console.log('✅ Migration v11 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
