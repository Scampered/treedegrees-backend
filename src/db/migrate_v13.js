// src/db/migrate_v13.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
CREATE TABLE IF NOT EXISTS trump_card_games (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID REFERENCES groups(id) ON DELETE CASCADE,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  status       VARCHAR(20) DEFAULT 'waiting',
  game_state   JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS trump_card_players (
  game_id    UUID NOT NULL REFERENCES trump_card_games(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seat_index INT,
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (game_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tcg_group ON trump_card_games(group_id);
CREATE INDEX IF NOT EXISTS idx_tcg_status ON trump_card_games(status);
CREATE INDEX IF NOT EXISTS idx_tcp_user ON trump_card_players(user_id);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v13: Trump Card game tables...');
    await client.query(migration);
    console.log('✅ Migration v13 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
