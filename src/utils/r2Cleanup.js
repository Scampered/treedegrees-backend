// r2Cleanup.js — deletes R2 objects for expired moments not referenced anywhere
import pool from '../db/pool.js'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'

function getR2() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })
}

async function runR2Cleanup() {
  console.log('[r2cleanup] Starting orphan R2 cleanup...')
  try {
    const { rows: expired } = await pool.query(`
      SELECT m.id, m.r2_key
      FROM moments m
      WHERE m.expires_at < NOW()
        AND m.r2_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM letter_moments lm WHERE lm.moment_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.note_moment_id = m.id)
      LIMIT 100
    `)

    if (expired.length === 0) { console.log('[r2cleanup] Nothing to clean'); return }

    const r2 = getR2()
    let deleted = 0

    for (const moment of expired) {
      try {
        await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: moment.r2_key }))
        await pool.query(`DELETE FROM moments WHERE id=$1`, [moment.id])
        deleted++
      } catch (e) { console.error(`[r2cleanup] Failed ${moment.r2_key}:`, e.message) }
    }
    console.log(`[r2cleanup] Deleted ${deleted} orphaned objects`)
  } catch (e) { console.error('[r2cleanup] Error:', e.message) }
}

let lastRun = null
export function startR2CleanupPoller() {
  const run = async () => {
    const today = new Date().toDateString()
    if (lastRun === today) return
    lastRun = today
    await runR2Cleanup()
  }
  setTimeout(run, 10 * 60 * 1000)
  setInterval(run, 24 * 60 * 60 * 1000)
  console.log('[r2cleanup] Poller scheduled (daily)')
}
