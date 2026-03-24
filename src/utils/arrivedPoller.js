// src/utils/arrivedPoller.js
// Server-side poller: awards seeds for arrived letters automatically,
// regardless of whether sender or recipient has the app open.
import pool from '../db/pool.js';
import { awardSeeds } from '../routes/grove.js';
import { sendPush } from './push.js';

const MAX_MS = 72 * 3600 * 1000;

async function processArrived() {
  let rows;
  try {
    // First log what's pending before touching anything
    const pending = await pool.query(
      `SELECT id, sender_id, recipient_id, arrives_at, seeds_awarded, delivery_ms
       FROM letters
       WHERE arrives_at <= NOW()
         AND (seeds_awarded = false OR seeds_awarded IS NULL)
       LIMIT 20`
    );
    if (pending.rows.length > 0) {
      console.log(`[poller] found ${pending.rows.length} unawarded arrived letters:`);
      for (const r of pending.rows) {
        console.log(`  letter=${r.id} sender=${r.sender_id} recipient=${r.recipient_id} seeds_awarded=${r.seeds_awarded} delivery_ms=${r.delivery_ms}`);
      }
    }

    const result = await pool.query(
      `UPDATE letters
       SET seeds_awarded = true
       WHERE arrives_at <= NOW()
         AND (seeds_awarded = false OR seeds_awarded IS NULL)
       RETURNING id, sender_id, recipient_id,
                 COALESCE(delivery_ms, 0) AS delivery_ms`
    );
    rows = result.rows;
  } catch (e) {
    console.error('[poller] query error:', e.message);
    return;
  }

  if (rows.length === 0) return;
  console.log(`[poller] updating ${rows.length} letters`);

  for (const letter of rows) {
    try {
      const delivMs       = Math.max(30000, Math.min(letter.delivery_ms, MAX_MS));
      const ratio         = Math.sqrt(delivMs / MAX_MS);
      const seedsSender   = 5  + Math.floor(ratio * 35);
      const seedsReceiver = 10 + Math.floor(ratio * 50);

      console.log(`[poller] awarding sender=${letter.sender_id} +${seedsSender}`);
      await awardSeeds(letter.sender_id, seedsSender, 'send_letter');
      console.log(`[poller] sender awarded OK`);

      console.log(`[poller] awarding recipient=${letter.recipient_id} +${seedsReceiver}`);
      await awardSeeds(letter.recipient_id, seedsReceiver, 'receive_letter');
      console.log(`[poller] recipient awarded OK`);

      sendPush(letter.recipient_id, '✉️ Letter arrived!', 'You received a letter!', '/letters').catch(() => {});
    } catch (e) {
      console.error(`[poller] award error for letter=${letter.id}:`, e.message, e.stack);
    }
  }
}

export function startArrivedPoller() {
  console.log('[poller] started — checking every 60s');
  processArrived(); // run immediately on startup
  setInterval(processArrived, 60 * 1000);
}
