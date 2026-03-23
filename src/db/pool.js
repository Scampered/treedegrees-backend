// src/db/pool.js
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 18,                       // Supabase free tier allows 20 — keep 2 spare
  idleTimeoutMillis: 10000,      // release idle connections faster
  connectionTimeoutMillis: 3000, // fail fast rather than queue up
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err.message);
});

export default pool;
