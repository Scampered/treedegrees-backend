import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
    `);
    console.log('✅ v23: reset_token columns added');
  } catch (e) { console.error('❌', e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
migrate();
