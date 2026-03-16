// src/db/migrate_v4.js — run once: node src/db/migrate_v4.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Personal nicknames one user assigns to another
CREATE TABLE IF NOT EXISTS connection_nicknames (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname    VARCHAR(50) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_creator_target UNIQUE (creator_id, target_id),
  CONSTRAINT no_self_nickname CHECK (creator_id != target_id)
);

CREATE INDEX IF NOT EXISTS idx_cn_creator ON connection_nicknames(creator_id);
CREATE INDEX IF NOT EXISTS idx_cn_target  ON connection_nicknames(target_id);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v4: connection_nicknames table...');
    await client.query(migration);
    console.log('✅ Migration v4 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
