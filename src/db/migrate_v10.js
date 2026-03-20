// src/db/migrate_v10.js — node src/db/migrate_v10.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Groups table
CREATE TABLE IF NOT EXISTS groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(60) NOT NULL,
  description TEXT,
  color       VARCHAR(7) NOT NULL DEFAULT '#4dba4d',
  admin_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Group members (admin is also a member)
CREATE TABLE IF NOT EXISTS group_members (
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_gm_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_gm_user  ON group_members(user_id);

-- Group letters (broadcast messages)
CREATE TABLE IF NOT EXISTS group_letters (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL CHECK (char_length(content) <= 500),
  sent_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- Delivery tracking per recipient
CREATE TABLE IF NOT EXISTS group_letter_deliveries (
  letter_id    UUID NOT NULL REFERENCES group_letters(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  arrives_at   TIMESTAMPTZ NOT NULL,
  opened_at    TIMESTAMPTZ,
  PRIMARY KEY (letter_id, recipient_id)
);

-- Friend request notifications tracking
CREATE TABLE IF NOT EXISTS friend_request_notified (
  friendship_id UUID PRIMARY KEY,
  notified_at   TIMESTAMPTZ DEFAULT NOW()
);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v10: groups + friend request tracking...');
    await client.query(migration);
    console.log('✅ Migration v10 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
