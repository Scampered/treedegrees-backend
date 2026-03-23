// migrate_v18 — add distance_km to letters for distance-based seed rewards
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migration v18: distance_km on letters...');
    await client.query(`
      ALTER TABLE letters ADD COLUMN IF NOT EXISTS distance_km INT DEFAULT 0;
    `);
    console.log('✅ Migration v18 complete');
  } catch (err) { console.error('❌', err.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
