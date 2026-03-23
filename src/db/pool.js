// src/db/pool.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

// Supabase free tier Session mode: hard cap ~15 connections total.
// Keep pool small so we never hit it — routes must be fast and non-blocking.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,                        // conservative — never fight Supabase's cap
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 3000,
});

pool.on('error', (err) => {
  console.error('DB pool error:', err.message);
});

export default pool;
