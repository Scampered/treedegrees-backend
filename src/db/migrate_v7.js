// src/db/migrate_v7.js — node src/db/migrate_v7.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Admin flag on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

-- Page maintenance flags
CREATE TABLE IF NOT EXISTS page_maintenance (
  page_key   VARCHAR(50) PRIMARY KEY,
  is_down    BOOLEAN DEFAULT false,
  message    TEXT DEFAULT 'This page is currently under maintenance. Please check back soon.',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the pages
INSERT INTO page_maintenance (page_key, is_down) VALUES
  ('map',      false),
  ('friends',  false),
  ('feed',     false),
  ('letters',  false),
  ('settings', false)
ON CONFLICT (page_key) DO NOTHING;

-- Admin action log
CREATE TABLE IF NOT EXISTS admin_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  target_id   UUID,
  details     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v7: admin system...');
    await client.query(migration);
    console.log('✅ Migration v7 complete');
    console.log('');
    console.log('👑 To make yourself admin, run this SQL in Supabase SQL Editor:');
    console.log(`   UPDATE users SET is_admin = true WHERE email = 'YOUR_EMAIL_HERE';`);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
