// migrate_v22b — add 'deposited' status to farmer_plots
import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE farmer_plots DROP CONSTRAINT IF EXISTS farmer_plots_status_check`);
    await client.query(`ALTER TABLE farmer_plots ADD CONSTRAINT farmer_plots_status_check CHECK (status IN ('empty','deposited','planted','ready','harvested','rotten'))`);
    console.log('✅ v22b: deposited status added to farmer_plots');
  } catch (e) { console.error('❌', e.message); }
  finally { client.release(); await pool.end(); }
}
migrate();
