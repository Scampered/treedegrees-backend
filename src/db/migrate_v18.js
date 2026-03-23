// migrate_v18 — distance_km, seeds_awarded, delivery_ms on letters
import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v18...');
    await client.query(`
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS distance_km   INT     DEFAULT 0;
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS seeds_awarded BOOLEAN DEFAULT false;
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS delivery_ms   BIGINT  DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_letters_seeds_awarded ON letters(seeds_awarded) WHERE seeds_awarded = false OR seeds_awarded IS NULL;
    `);
    // Backfill seeds_awarded=false for any NULLs
    await client.query(`UPDATE letters SET seeds_awarded = false WHERE seeds_awarded IS NULL`);
    console.log('✅ v18 complete');
  } catch (e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
