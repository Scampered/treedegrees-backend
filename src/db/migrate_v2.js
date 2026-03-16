// src/db/migrate_v2.js
// Run once to add location_privacy column: node src/db/migrate_v2.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS location_privacy VARCHAR(10) DEFAULT 'exact'
    CHECK (location_privacy IN ('exact', 'private', 'hidden'));
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌳 Running migration v2: location_privacy column...');
    await client.query(migration);
    console.log('✅ Migration v2 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
