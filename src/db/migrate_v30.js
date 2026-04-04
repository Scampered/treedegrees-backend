import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_seeds_awarded BOOLEAN DEFAULT false;
    `);
    console.log('v30: referral columns added');
  } catch(e) { console.error(e.message); process.exit(1); }
  finally { client.release(); await pool.end(); }
}
run();
