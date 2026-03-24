// src/utils/arrivedPoller.js
// Awards seeds for arrived letters every 60s — server-side so neither
// sender nor recipient needs the app open for seeds to land.
import pool from '../db/pool.js';
import { awardSeeds } from '../routes/grove.js';
import { sendPush } from './push.js';

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

    console.log(`[poller] awarding seeds for ${rows.length} arrived letter(s)`);
    for (const letter of rows) {
      const delivMs       = Math.max(30000, Math.min(letter.delivery_ms, MAX_MS));
      const ratio         = Math.sqrt(delivMs / MAX_MS);
      const seedsSender   = 5  + Math.floor(ratio * 35);
      const seedsReceiver = 10 + Math.floor(ratio * 50);
      await awardSeeds(letter.sender_id,    seedsSender,   'send_letter');
      await awardSeeds(letter.recipient_id, seedsReceiver, 'receive_letter');
      sendPush(letter.recipient_id, '✉️ Letter arrived!', 'You received a letter!', '/letters').catch(() => {});
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
// clean 
