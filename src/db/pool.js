// src/db/pool.js
import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const { Pool } = pg

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 4,                          // Supabase free tier: max ~15 total, keep well under
  idleTimeoutMillis: 10000,        // release idle connections quickly
  connectionTimeoutMillis: 4000,   // fail fast rather than queue forever
  statement_timeout: 10000,        // global 10s query timeout — prevents hung queries
})

pool.on('error', (err) => {
  console.error('[pool] Unexpected client error:', err.message)
})

pool.on('connect', () => {
  if (pool.totalCount >= 3)
    console.warn(`[pool] Connections climbing: ${pool.totalCount}/${pool.options.max}`)
})

export default pool
