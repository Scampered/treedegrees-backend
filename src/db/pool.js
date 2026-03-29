// src/db/pool.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 4,                          // conservative for Supabase free tier
  min: 1,                          // keep one warm connection
  idleTimeoutMillis: 20000,        // drop idle connections after 20s
  connectionTimeoutMillis: 8000,   // wait up to 8s for a connection
  allowExitOnIdle: false,          // keep process alive even if idle
});

pool.on('error', (err) => {
  // Log but don't crash — pollers will retry on next tick
  console.error('DB pool error:', err.message);
});

// Keepalive ping every 4 minutes to prevent Supabase from killing idle connections
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error('[pool keepalive] failed:', e.message);
  }
}, 4 * 60 * 1000);

// Retry wrapper — retries a DB operation up to `attempts` times with backoff
export async function withRetry(fn, attempts = 3, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const isTimeout = e.message?.includes('timeout') || e.message?.includes('terminated');
      if (i < attempts - 1 && isTimeout) {
        console.warn(`[db retry] attempt ${i + 1} failed: ${e.message} — retrying in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      } else {
        throw e;
      }
    }
  }
}

export default pool;
