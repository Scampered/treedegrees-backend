import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE courier_requests ADD COLUMN IF NOT EXISTS recipient_label TEXT DEFAULT 'Not specified';
      ALTER TABLE farmer_plots DROP CONSTRAINT IF EXISTS farmer_plots_status_check;
      ALTER TABLE farmer_plots ADD CONSTRAINT farmer_plots_status_check
        CHECK (status IN ('empty','deposited','planted','ready','harvested','rotten'));
    `);
    // Auto-create plots for existing farmers who don't have them
    await client.query(`
      INSERT INTO farmer_plots (farmer_id, slot_index, seeds_deposited, status)
      SELECT j.user_id, g.slot, 0, 'empty'
      FROM jobs j CROSS JOIN generate_series(0,4) g(slot)
      WHERE j.role='farmer'
      ON CONFLICT DO NOTHING
    `);
    console.log('✅ v24: recipient_label on courier_requests, farmer plots fixed');
  } catch(e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
run();
