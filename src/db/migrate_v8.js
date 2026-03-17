// src/db/migrate_v8.js — node src/db/migrate_v8.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Email verification flag
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;

-- Admin popup messages table
CREATE TABLE IF NOT EXISTS admin_popups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target      VARCHAR(40) NOT NULL DEFAULT 'all',
  -- target: 'all' | specific user UUID
  header      VARCHAR(120) NOT NULL,
  subheader   TEXT,
  button_text VARCHAR(50) DEFAULT 'Okay',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ
);

-- Track which users have dismissed which popups
CREATE TABLE IF NOT EXISTS popup_dismissals (
  popup_id UUID REFERENCES admin_popups(id) ON DELETE CASCADE,
  user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (popup_id, user_id)
);

-- Mark existing users as verified so they don't get locked out
UPDATE users SET email_verified = true WHERE deleted_at IS NULL;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v8: email_verified + admin popups...');
    await client.query(migration);
    console.log('✅ Migration v8 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
