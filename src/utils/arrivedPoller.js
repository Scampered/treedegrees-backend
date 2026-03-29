// src/utils/arrivedPoller.js
import pool from '../db/pool.js';
import { notify } from './notify.js';

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
    console.log(`[arrivedPoller] processing ${rows.length} letter(s)`);

    for (const letter of rows) {
      const delivMs     = Math.max(30000, Math.min(letter.delivery_ms, MAX_MS));
      const ratio       = Math.sqrt(delivMs / MAX_MS);
      const seedsSender = 5  + Math.floor(ratio * 35);
      const seedsRecip  = 10 + Math.floor(ratio * 50);

      await pool.query(
        `UPDATE users SET seeds = GREATEST(0, COALESCE(seeds,0) + $1) WHERE id = $2`,
        [seedsSender, letter.sender_id]
      );
      notify(letter.sender_id, 'seeds_earned',
        `🌱 +${seedsSender} seeds`, 'Seeds for sending a letter.', '/grove').catch(() => {});

      await pool.query(
        `UPDATE users SET seeds = GREATEST(0, COALESCE(seeds,0) + $1) WHERE id = $2`,
        [seedsRecip, letter.recipient_id]
      );

      // Get sender name for notification
      const { rows: [sender] } = await pool.query(
        `SELECT COALESCE(nickname, split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`,
        [letter.sender_id]
      );
      notify(letter.recipient_id, 'letter_arrived',
        `✉️ Letter arrived!`, `A letter from ${sender?.name || 'someone'} has arrived.`, '/letters').catch(() => {});
      notify(letter.recipient_id, 'seeds_earned',
        `🌱 +${seedsRecip} seeds`, 'Seeds for receiving a letter.', '/grove').catch(() => {});
    }
  } catch (e) {
    console.error('[arrivedPoller]', e.message);
  }
}

export function startArrivedPoller() {
  console.log('[arrivedPoller] started');
  setTimeout(processArrived, 2000); // slight delay on startup
  setInterval(processArrived, 60 * 1000);
}
