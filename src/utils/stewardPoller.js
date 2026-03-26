// src/utils/stewardPoller.js — expires steward contracts and refunds clients
import pool from '../db/pool.js';
import { sendPush } from './push.js';

async function expireStewardContracts() {
  const client = await pool.connect();
  try {
    // Find expired active contracts
    const { rows: expired } = await client.query(
      `SELECT sc.id, sc.steward_id, sc.client_id, sc.fee_seeds, sc.retainer_days,
              COALESCE(us.nickname, split_part(us.full_name,' ',1)) AS steward_name
       FROM steward_clients sc
       JOIN users us ON us.id=sc.steward_id
       WHERE sc.status='active' AND sc.expires_at IS NOT NULL AND sc.expires_at <= NOW()`
    );
    for (const sc of expired) {
      await client.query(`UPDATE steward_clients SET status='expired' WHERE id=$1`, [sc.id]);
      // Notify client their contract expired
      sendPush(sc.client_id, '🔔 Steward contract ended',
        `Your ${sc.retainer_days}-day steward contract has ended.`, '/jobs').catch(() => {});
      sendPush(sc.steward_id, '🔔 Contract ended',
        'A steward client contract has expired.', '/jobs').catch(() => {});
    }
    if (expired.length > 0) console.log(`[stewardPoller] expired ${expired.length} contracts`);
  } catch (e) {
    console.error('[stewardPoller]', e.message);
  } finally { client.release(); }
}

// Run every 15 minutes
export function startStewardPoller() {
  expireStewardContracts();
  setInterval(expireStewardContracts, 15 * 60 * 1000);
}
