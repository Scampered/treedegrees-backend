// src/utils/jobPollers.js — timed delivery for courier, farmer 1h refund, steward rebill, broker auto-close
import pool from '../db/pool.js';
import { sendPush } from './push.js';
import { notify } from './notify.js';

// Safe query — uses pool.query (auto-returns connection) never pool.connect()
const q = (text, params) => pool.query(text, params);

// ── Courier: mark accepted requests as delivered after est_hours ──────────────
async function pollCourierDeliveries() {
  try {
    const { rows } = await q(
      `SELECT id, requester_id, courier_id, fee_seeds, est_hours, accepted_at, recipient_label, from_country, to_country
       FROM courier_requests
       WHERE status = 'accepted'
         AND accepted_at IS NOT NULL
         AND accepted_at + (est_hours * INTERVAL '1 hour') <= NOW()`
    );
    for (const r of rows) {
      await q(`UPDATE courier_requests SET status='delivered', delivered_at=NOW() WHERE id=$1`, [r.id]);
      sendPush(r.requester_id, '📬 Letter delivered!',
        `Your courier delivery from ${r.from_country} → ${r.to_country} is complete.`, '/jobs').catch(() => {});
      notify(r.requester_id, 'job_hired', '📬 Delivery complete',
        `Your courier delivery is done.`, '/jobs').catch(() => {});
      sendPush(r.courier_id, '✅ Delivery complete',
        `Delivered: ${r.from_country} → ${r.to_country}`, '/jobs').catch(() => {});
    }
    if (rows.length > 0) console.log(`[courierPoller] delivered ${rows.length}`);
  } catch(e) { console.error('[courierPoller]', e.message); }
}

// ── Farmer: refund deposits not planted within 1 hour ────────────────────────
async function pollFarmerRefunds() {
  try {
    const { rows } = await q(
      `SELECT fp.id, fp.depositor_id, fp.seeds_deposited, fp.farmer_id,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS farmer_name
       FROM farmer_plots fp
       LEFT JOIN users u ON u.id=fp.farmer_id
       WHERE fp.status = 'deposited'
         AND fp.planted_at IS NOT NULL
         AND fp.planted_at + INTERVAL '1 hour' <= NOW()
         AND fp.depositor_id IS NOT NULL`
    );
    for (const r of rows) {
      await q(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [r.seeds_deposited, r.depositor_id]);
      await q(`UPDATE farmer_plots SET status='empty', seeds_deposited=0, depositor_id=NULL, planted_at=NULL WHERE id=$1`, [r.id]);
      notify(r.depositor_id, 'job_hired', '🌾 Deposit refunded',
        `Your ${r.seeds_deposited} 🌱 were refunded — farmer didn't plant in time.`, '/jobs').catch(() => {});
    }
    if (rows.length > 0) console.log(`[farmerPoller] refunded ${rows.length}`);
  } catch(e) { console.error('[farmerPoller]', e.message); }
}

// ── Steward: expire or auto-renew contracts ───────────────────────────────────
async function pollStewardContracts() {
  try {
    const { rows: expired } = await q(
      `SELECT sc.id, sc.steward_id, sc.client_id, sc.fee_seeds, sc.retainer_days,
              uc.seeds AS client_seeds
       FROM steward_clients sc
       JOIN users uc ON uc.id=sc.client_id
       WHERE sc.status='active' AND sc.expires_at IS NOT NULL AND sc.expires_at <= NOW()`
    );
    for (const sc of expired) {
      if (sc.client_seeds >= sc.fee_seeds) {
        const newExpiry = new Date(Date.now() + sc.retainer_days * 24 * 3600000);
        await q(`UPDATE users SET seeds=seeds-$1 WHERE id=$2`, [sc.fee_seeds, sc.client_id]);
        await q(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [sc.fee_seeds, sc.steward_id]);
        await q(`UPDATE steward_clients SET last_paid_at=NOW(), expires_at=$1 WHERE id=$2`, [newExpiry, sc.id]);
        notify(sc.client_id, 'job_hired', '🔔 Steward renewed',
          `Your ${sc.retainer_days}-day contract auto-renewed for 🌱${sc.fee_seeds}.`, '/jobs').catch(() => {});
      } else {
        await q(`UPDATE steward_clients SET status='expired' WHERE id=$1`, [sc.id]);
        notify(sc.client_id, 'job_hired', '🔔 Contract ended',
          `Your steward contract expired — not enough seeds to renew.`, '/jobs').catch(() => {});
        sendPush(sc.client_id, '🔔 Steward contract ended',
          `Your ${sc.retainer_days}-day contract has ended.`, '/jobs').catch(() => {});
      }
    }
    if (expired.length > 0) console.log(`[stewardPoller] processed ${expired.length}`);
  } catch(e) { console.error('[stewardPoller]', e.message); }
}

// ── Broker: auto-close expired sessions ──────────────────────────────────────
async function pollBrokerSessions() {
  try {
    const { rows: sessions } = await q(
      `SELECT bs.*, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS broker_name
       FROM broker_sessions bs JOIN users u ON u.id=bs.broker_id
       WHERE bs.status='active' AND bs.closes_at IS NOT NULL AND bs.closes_at <= NOW()`
    );
    for (const session of sessions) {
      const { rows: allocs } = await q(
        `SELECT * FROM broker_allocations WHERE session_id=$1 AND NOT settled`, [session.id]
      );
      const BROKER_FEE = 0.05;
      let totalClientGet = 0, totalBrokerCut = 0;
      for (const alloc of allocs) {
        let currentPrice = parseFloat(alloc.price_at_invest);
        if (alloc.target_type === 'grove' && alloc.target_user_id) {
          const { rows: [t] } = await q(`SELECT seeds FROM users WHERE id=$1`, [alloc.target_user_id]);
          currentPrice = t?.seeds || currentPrice;
        } else if (['canopy','crude'].includes(alloc.target_type)) {
          const { rows: [ms] } = await q(`SELECT price FROM market_state WHERE market=$1`, [alloc.target_type]);
          currentPrice = parseFloat(ms?.price || currentPrice);
        }
        const mult = Math.min(10, Math.max(0, currentPrice / Math.max(1, parseFloat(alloc.price_at_invest))));
        const activeVal = Math.floor(alloc.amount * mult);
        const fee = Math.floor(activeVal * BROKER_FEE);
        const profit = (activeVal - fee) - alloc.amount;
        const cut = profit > 0 ? Math.floor(profit * 0.10) : 0;
        const clientGet = Math.max(0, activeVal - fee - cut);
        totalClientGet += clientGet;
        totalBrokerCut += cut;
        await q(`UPDATE broker_allocations SET settled=true, settled_at=NOW(), return_amount=$1 WHERE id=$2`, [clientGet, alloc.id]);
      }
      const unallocated = session.escrow_seeds - allocs.reduce((s, a) => s + a.amount, 0);
      if (unallocated > 0) totalClientGet += unallocated;
      await q(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [totalClientGet, session.client_id]);
      await q(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [totalBrokerCut, session.broker_id]);
      await q(`UPDATE broker_sessions SET status='settled', escrow_seeds=0 WHERE id=$1`, [session.id]);
      notify(session.client_id, 'job_hired', '🌱 Broker session closed',
        `You received 🌱${totalClientGet}.`, '/jobs').catch(() => {});
      notify(session.broker_id, 'job_hired', '🌱 Session auto-closed',
        `Client got 🌱${totalClientGet}, you earned 🌱${totalBrokerCut}.`, '/jobs').catch(() => {});
    }
    if (sessions.length > 0) console.log(`[brokerPoller] closed ${sessions.length}`);
  } catch(e) { console.error('[brokerPoller]', e.message); }
}

// ── Start all pollers — stagger start times to avoid DB bursts ───────────────
export function startJobPollers() {
  // Stagger initial runs so they don't all hit DB at once on startup
  setTimeout(pollCourierDeliveries, 5000);
  setTimeout(pollFarmerRefunds, 15000);
  setTimeout(pollStewardContracts, 25000);
  setTimeout(pollBrokerSessions, 35000);

  setInterval(pollCourierDeliveries, 5 * 60 * 1000);
  setInterval(pollFarmerRefunds,     10 * 60 * 1000);
  setInterval(pollStewardContracts,  15 * 60 * 1000);
  setInterval(pollBrokerSessions,     5 * 60 * 1000);

  console.log('✅ Job pollers started (staggered)');
}
