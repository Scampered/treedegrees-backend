// src/db/migrate_v6.js — node src/db/migrate_v6.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Add expiry to letters (7 days after arrival)
ALTER TABLE letters ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Back-fill expiry for existing letters (7 days after arrives_at)
UPDATE letters SET expires_at = arrives_at + INTERVAL '7 days' WHERE expires_at IS NULL;

-- Index for fast expiry queries
CREATE INDEX IF NOT EXISTS idx_letters_expires ON letters(expires_at);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v6: letter expiry...');
    await client.query(migration);
    console.log('✅ Migration v6 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
