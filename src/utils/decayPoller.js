// decayPoller.js — daily seeds decay for inactive users
// Runs once a day at ~midnight UTC
// Inactive = no letter sent, no note posted, no memory posted today

import pool from '../db/pool.js'

const DECAY_AMOUNTS = {
  no_letter:  -8,   // didn't send a letter today
  no_note:    -5,   // didn't post a daily note today
  no_memory:  -3,   // didn't post a memory today (less critical, weekly activity)
}

// Run decay check — called once per day
async function runDecay() {
  console.log('[decay] Running daily inactivity decay...')
  try {
    // Get all active users (joined > 7 days ago, not deleted)
    const { rows: users } = await pool.query(
      `SELECT id FROM users
       WHERE deleted_at IS NULL
         AND created_at < NOW() - INTERVAL '7 days'`
    )

    let decayed = 0
    for (const u of users) {
      // Check letter sent in last 24h
      const { rows:[letterCheck] } = await pool.query(
        `SELECT id FROM letters WHERE sender_id=$1 AND sent_at > NOW()-INTERVAL '24 hours' LIMIT 1`,
        [u.id]
      )
      // Check note posted today (calendar day UTC)
      const { rows:[noteCheck] } = await pool.query(
        `SELECT id FROM users WHERE id=$1
         AND daily_note_updated_at::date = CURRENT_DATE`,
        [u.id]
      )
      // Check memory posted in last 48h (memories are 1/day so 48h gives a buffer)
      const { rows:[memCheck] } = await pool.query(
        `SELECT id FROM moments WHERE uploader_id=$1 AND created_at > NOW()-INTERVAL '48 hours' LIMIT 1`,
        [u.id]
      )

      let totalDecay = 0
      if (!letterCheck) totalDecay += DECAY_AMOUNTS.no_letter
      if (!noteCheck)   totalDecay += DECAY_AMOUNTS.no_note
      // Memory decay only if they've never posted (encourages first post)
      // or haven't posted in 3 days
      const { rows:[recentMem] } = await pool.query(
        `SELECT id FROM moments WHERE uploader_id=$1 AND created_at > NOW()-INTERVAL '3 days' LIMIT 1`,
        [u.id]
      )
      if (!recentMem) totalDecay += DECAY_AMOUNTS.no_memory

      // Only decay if there's something to deduct and user has seeds above 50
      if (totalDecay < 0) {
        const { rows:[seedRow] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [u.id])
        const currentSeeds = seedRow?.seeds || 0
        if (currentSeeds > 50) {
          // Cap decay so balance never goes below 50
          const actualDecay = Math.max(totalDecay, 50 - currentSeeds)
          await pool.query(
            `UPDATE users SET seeds = GREATEST(0, COALESCE(seeds,0) + $1) WHERE id=$2`,
            [actualDecay, u.id]
          )
          await pool.query(
            `INSERT INTO seeds_log (user_id, amount, reason, label) VALUES ($1,$2,$3,$4)`,
            [u.id, actualDecay, 'inactivity_decay', '💤 Inactivity penalty']
          ).catch(()=>{})
          decayed++
        }
      }
    }
    console.log(`[decay] Processed ${users.length} users, ${decayed} decayed`)
  } catch(e) {
    console.error('[decay] Error:', e.message)
  }
}

// Schedule: run once at startup (skipped if already ran today) then every 24h
let lastRun = null

export function startDecayPoller() {
  const run = async () => {
    const today = new Date().toDateString()
    if (lastRun === today) return
    lastRun = today
    await runDecay()
  }

  // First run after 5 minute startup delay, then every 24h
  setTimeout(run, 5 * 60 * 1000)
  setInterval(run, 24 * 60 * 60 * 1000)
  console.log('[decay] Poller scheduled (first run in 5 min)')
}
