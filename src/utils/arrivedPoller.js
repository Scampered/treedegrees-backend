// src/utils/arrivedPoller.js
import pool from '../db/pool.js';

const MAX_MS = 72 * 3600 * 1000;

async function processArrived() {
  try {
    const { rows } = await pool.query(
      `UPDATE letters
       SET seeds_awarded = true
       WHERE arrives_at <= NOW()
         AND seeds_awarded = false
       RETURNING id, sender_id, recipient_id,
                 COALESCE(delivery_ms, 0) AS delivery_ms`
    );
    if (rows.length === 0) return;

    console.log(`[poller] awarding seeds for ${rows.length} letter(s)`);
    for (const letter of rows) {
      const delivMs       = Math.max(30000, Math.min(letter.delivery_ms, MAX_MS));
      const ratio         = Math.sqrt(delivMs / MAX_MS);
      const seedsSender   = 5  + Math.floor(ratio * 35);
      const seedsReceiver = 10 + Math.floor(ratio * 50);

      // Award directly — no import from grove.js to avoid circular deps
      await pool.query(
        `UPDATE users SET seeds = GREATEST(0, COALESCE(seeds,0) + $1) WHERE id = $2`,
        [seedsSender, letter.sender_id]
      );
      await pool.query(
        `UPDATE users SET seeds = GREATEST(0, COALESCE(seeds,0) + $1) WHERE id = $2`,
        [seedsReceiver, letter.recipient_id]
      );
    }
  } catch (e) {
    console.error('[poller] error:', e.message);
  }
}

export function startArrivedPoller() {
  console.log('[poller] started');
  processArrived();
  setInterval(processArrived, 60 * 1000);
}
// fix 
