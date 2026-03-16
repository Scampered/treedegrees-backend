// src/db/migrate_v5.js — node src/db/migrate_v5.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
CREATE TABLE IF NOT EXISTS letters (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content          TEXT NOT NULL CHECK (char_length(content) <= 500),
  vehicle_tier     VARCHAR(20) NOT NULL DEFAULT 'car',
  sent_at          TIMESTAMPTZ DEFAULT NOW(),
  arrives_at       TIMESTAMPTZ NOT NULL,
  opened_at        TIMESTAMPTZ,
  streak_at_send   INT DEFAULT 0,
  CONSTRAINT no_self_letter CHECK (sender_id != recipient_id)
);

CREATE TABLE IF NOT EXISTS letter_streaks (
  user_id_1        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id_2        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  streak_days      INT DEFAULT 0,
  fuel             INT DEFAULT 0 CHECK (fuel BETWEEN 0 AND 3),
  last_day_processed DATE DEFAULT CURRENT_DATE,
  user1_sent_today BOOLEAN DEFAULT false,
  user2_sent_today BOOLEAN DEFAULT false,
  PRIMARY KEY (user_id_1, user_id_2),
  CONSTRAINT sorted_pair CHECK (user_id_1 < user_id_2)
);

CREATE INDEX IF NOT EXISTS idx_letters_sender    ON letters(sender_id);
CREATE INDEX IF NOT EXISTS idx_letters_recipient ON letters(recipient_id);
CREATE INDEX IF NOT EXISTS idx_letters_arrives   ON letters(arrives_at);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v5: letters + streaks...');
    await client.query(migration);
    console.log('✅ Migration v5 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
