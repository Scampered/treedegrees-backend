// migrate_v18 — distance_km and seeds_awarded on letters
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v18...');
    await client.query(`
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS distance_km    INT     DEFAULT 0;
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS seeds_awarded  BOOLEAN DEFAULT false;
      CREATE INDEX IF NOT EXISTS idx_letters_seeds_awarded ON letters(seeds_awarded) WHERE seeds_awarded = false;
    `);
    console.log('✅ Migration v18 complete');
  } catch (err) { console.error('❌', err.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
