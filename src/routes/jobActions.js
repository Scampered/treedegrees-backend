// src/routes/jobActions.js — functional job endpoints for all 7 jobs
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { updateMarketPrice } from '../utils/marketEvents.js';
import { sendPush } from '../utils/push.js';

const router = Router();

// ── Courier vehicle tiers ─────────────────────────────────────────────────────
const COURIER_TIERS = {
  van:        { emoji: '🚐', label: 'Van',          minDeliveries: 0,  speedMult: 1.0 },
  bus:        { emoji: '🚌', label: 'Bus',           minDeliveries: 5,  speedMult: 1.4 },
  airfreight: { emoji: '✈️',  label: 'Air Freight',  minDeliveries: 20, speedMult: 2.5 },
  rocket:     { emoji: '🚀', label: 'Rocket',        minDeliveries: 50, speedMult: 5.0 },
}

function courierTierForDeliveries(n) {
  if (n >= 50) return 'rocket'
  if (n >= 20) return 'airfreight'
  if (n >= 5)  return 'bus'
  return 'van'
}

// ── COURIER ───────────────────────────────────────────────────────────────────
// GET /api/job-actions/courier/queue — delivery requests for this courier
router.get('/courier/queue', requireAuth, async (req, res) => {
  try {
    const { rows: job } = await pool.query(`SELECT id FROM jobs WHERE user_id=$1 AND role='courier'`, [req.user.id])
    if (!job[0]) return res.status(403).json({ error: 'Not a courier' })

    const { rows } = await pool.query(
      `SELECT cr.id, cr.from_country, cr.to_country, cr.est_hours, cr.fee_seeds,
              cr.status, cr.created_at,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS sender_name
       FROM courier_requests cr
       JOIN users u ON u.id = cr.requester_id
       WHERE cr.courier_id = $1 AND cr.status = 'pending'
         AND cr.created_at > NOW() - INTERVAL '12 hours'
       ORDER BY cr.created_at DESC`,
      [req.user.id]
    )
    // Get vehicle
    const { rows: [vehicle] } = await pool.query(
      `SELECT tier, deliveries FROM courier_vehicles WHERE user_id=$1`, [req.user.id]
    )
    res.json({ queue: rows, vehicle: vehicle || { tier: 'van', deliveries: 0 }, tiers: COURIER_TIERS })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/courier/request — requester hires a courier
router.post('/courier/request', requireAuth, async (req, res) => {
  const { courierId } = req.body
  try {
    // Get requester's country
    const { rows: [me] } = await pool.query(`SELECT country FROM users WHERE id=$1`, [req.user.id])
    const { rows: [courier] } = await pool.query(
      `SELECT u.country, j.hourly_rate FROM users u JOIN jobs j ON j.user_id=u.id
       WHERE u.id=$1 AND j.role='courier' AND j.active=true`, [courierId]
    )
    if (!courier) return res.status(404).json({ error: 'Courier not found' })

    // Crude: hiring a courier = fuel consumption
    const { rows: [cv] } = await pool.query(`SELECT tier FROM courier_vehicles WHERE user_id=$1`, [courierId])
    const tier  = cv?.tier || 'van'
    const speed = COURIER_TIERS[tier].speedMult
    const estHours = Math.max(0.5, 12 / speed)

    const { rows: [req2] } = await pool.query(
      `INSERT INTO courier_requests (requester_id, courier_id, from_country, to_country, est_hours, fee_seeds)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user.id, courierId, me.country || 'Unknown', courier.country || 'Unknown', estHours, courier.hourly_rate]
    )

    // Notify courier
    sendPush(courierId, '🚐 New delivery request!', `Someone in ${me.country} needs a delivery.`, '/jobs').catch(() => {})
    // Crude rises — courier activity = fuel burn
    updateMarketPrice('crude', 3).catch(() => {})

    res.json({ ok: true, requestId: req2.id, estHours })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// PATCH /api/job-actions/courier/request/:id — accept or decline
router.patch('/courier/request/:id', requireAuth, async (req, res) => {
  const { action } = req.body // 'accept' | 'decline'
  try {
    const { rows: [cr] } = await pool.query(
      `UPDATE courier_requests SET status=$1, accepted_at=CASE WHEN $1='accepted' THEN NOW() ELSE NULL END
       WHERE id=$2 AND courier_id=$3 AND status='pending' RETURNING *`,
      [action === 'accept' ? 'accepted' : 'declined', req.params.id, req.user.id]
    )
    if (!cr) return res.status(404).json({ error: 'Request not found' })

    if (action === 'accept') {
      // Award courier fee from requester
      await pool.query(`UPDATE users SET seeds=seeds-$1 WHERE id=$2`, [cr.fee_seeds, cr.requester_id])
      await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [cr.fee_seeds, req.user.id])
      // Increment deliveries + possibly upgrade tier
      const { rows: [cv] } = await pool.query(
        `INSERT INTO courier_vehicles(user_id,tier,deliveries) VALUES($1,'van',1)
         ON CONFLICT(user_id) DO UPDATE SET deliveries=courier_vehicles.deliveries+1 RETURNING deliveries`,
        [req.user.id]
      )
      const newTier = courierTierForDeliveries(cv.deliveries)
      await pool.query(`UPDATE courier_vehicles SET tier=$1 WHERE user_id=$2`, [newTier, req.user.id])
      await pool.query(`UPDATE courier_requests SET status='delivered', delivered_at=NOW() WHERE id=$1`, [cr.id])
    }
    res.json({ ok: true })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// ── WRITER ────────────────────────────────────────────────────────────────────
// GET /api/job-actions/writer/commissions — writer sees their inbox
router.get('/writer/commissions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT wc.id, wc.prompt, wc.fee_seeds, wc.status, wc.created_at, wc.content,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS client_name
       FROM writer_commissions wc JOIN users u ON u.id = wc.client_id
       WHERE wc.writer_id=$1 ORDER BY wc.created_at DESC LIMIT 20`,
      [req.user.id]
    )
    res.json({ commissions: rows })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// GET /api/job-actions/writer/my-commissions — client sees their purchases
router.get('/writer/my-commissions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT wc.id, wc.prompt, wc.fee_seeds, wc.status, wc.created_at,
              CASE WHEN wc.status='accepted' THEN wc.content ELSE NULL END AS content,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS writer_name
       FROM writer_commissions wc JOIN users u ON u.id = wc.writer_id
       WHERE wc.client_id=$1 ORDER BY wc.created_at DESC LIMIT 20`,
      [req.user.id]
    )
    res.json({ commissions: rows })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/writer/commission — hire a writer
router.post('/writer/commission', requireAuth, async (req, res) => {
  const { writerId, prompt, feeSeeds } = req.body
  if (!prompt || prompt.length < 5) return res.status(400).json({ error: 'Prompt too short' })
  const fee = Math.max(5, Math.floor(Number(feeSeeds) || 10))
  try {
    const { rows: [writer] } = await pool.query(
      `SELECT j.id FROM jobs j WHERE j.user_id=$1 AND j.role='writer' AND j.active=true`, [writerId]
    )
    if (!writer) return res.status(404).json({ error: 'Writer not found' })
    const { rows: [me] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [req.user.id])
    if ((me?.seeds || 0) < fee) return res.status(400).json({ error: 'Not enough seeds' })

    await pool.query(`UPDATE users SET seeds=seeds-$1 WHERE id=$2`, [fee, req.user.id])
    const { rows: [comm] } = await pool.query(
      `INSERT INTO writer_commissions (client_id, writer_id, prompt, fee_seeds) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.user.id, writerId, prompt.slice(0, 300), fee]
    )
    sendPush(writerId, '✍️ New commission!', `Someone wants a "${prompt.slice(0, 50)}" letter.`, '/jobs').catch(() => {})
    res.json({ ok: true, commissionId: comm.id })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// PATCH /api/job-actions/writer/commission/:id/submit — writer submits content
router.patch('/writer/commission/:id/submit', requireAuth, async (req, res) => {
  const { content } = req.body
  if (!content || content.length < 50) return res.status(400).json({ error: 'Content too short (min 50 chars)' })
  try {
    const { rows: [comm] } = await pool.query(
      `UPDATE writer_commissions SET content=$1, status='submitted', submitted_at=NOW()
       WHERE id=$2 AND writer_id=$3 AND status='pending' RETURNING client_id, fee_seeds`,
      [content.slice(0, 3000), req.params.id, req.user.id]
    )
    if (!comm) return res.status(404).json({ error: 'Commission not found' })
    sendPush(comm.client_id, '✍️ Your letter is ready!', 'A writer submitted your commission. Accept or reject it.', '/jobs').catch(() => {})
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// PATCH /api/job-actions/writer/commission/:id/resolve — client accepts or rejects
router.patch('/writer/commission/:id/resolve', requireAuth, async (req, res) => {
  const { action } = req.body // 'accept' | 'reject'
  try {
    const { rows: [comm] } = await pool.query(
      `UPDATE writer_commissions SET status=$1, resolved_at=NOW()
       WHERE id=$2 AND client_id=$3 AND status='submitted' RETURNING writer_id, fee_seeds`,
      [action === 'accept' ? 'accepted' : 'rejected', req.params.id, req.user.id]
    )
    if (!comm) return res.status(404).json({ error: 'Commission not found or not submitted' })

    if (action === 'accept') {
      // Full fee to writer
      await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [comm.fee_seeds, comm.writer_id])
    } else {
      // Kill fee: 15% back to writer even on rejection
      const killFee = Math.max(1, Math.floor(comm.fee_seeds * 0.15))
      await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [killFee, comm.writer_id])
      // Refund rest to client
      const refund = comm.fee_seeds - killFee
      await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [refund, req.user.id])
    }
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// ── SEED BROKER ───────────────────────────────────────────────────────────────
const BROKER_FEE = 0.05 // 5% flat for brokers (vs tiered 8-20% for normal)

// GET /api/job-actions/broker/session — broker sees active session
router.get('/broker/session', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT bs.*, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS client_name,
              u2.seeds AS target_seeds
       FROM broker_sessions bs
       JOIN users u ON u.id = bs.client_id
       LEFT JOIN users u2 ON u2.id = bs.target_user_id
       WHERE bs.broker_id=$1 AND bs.status='active'`,
      [req.user.id]
    )
    // Broker's own connections for trading
    const { rows: connections } = await pool.query(
      `SELECT u.id, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS name, u.seeds
       FROM users u JOIN friendships f ON (f.user_id_1=u.id OR f.user_id_2=u.id)
       WHERE (f.user_id_1=$1 OR f.user_id_2=$1) AND u.id!=$1 AND f.status='accepted'
       LIMIT 20`, [req.user.id]
    )
    res.json({ sessions: rows, connections })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/broker/open — client opens a broker session
router.post('/broker/open', requireAuth, async (req, res) => {
  const { brokerId, seeds, durationHours } = req.body
  const amt  = Math.max(10, Math.floor(Number(seeds) || 0))
  const dur  = [1, 3, 12, 24, 72, 168].includes(Number(durationHours)) ? Number(durationHours) : 24
  try {
    // Check broker only has 1 active session
    const { rows: [existing] } = await pool.query(
      `SELECT id FROM broker_sessions WHERE broker_id=$1 AND status='active'`, [brokerId]
    )
    if (existing) return res.status(400).json({ error: 'Broker already has an active session' })
    const { rows: [me] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [req.user.id])
    if ((me?.seeds || 0) < amt) return res.status(400).json({ error: 'Not enough seeds' })

    await pool.query(`UPDATE users SET seeds=seeds-$1 WHERE id=$2`, [amt, req.user.id])
    const { rows: [session] } = await pool.query(
      `INSERT INTO broker_sessions (broker_id, client_id, escrow_seeds, duration_hours, closes_at)
       VALUES ($1,$2,$3,$4, NOW()+($4 || ' hours')::interval) RETURNING id`,
      [brokerId, req.user.id, amt, dur]
    )
    sendPush(brokerId, '🌱 New broker client!', `${amt} seeds for ${dur}h session.`, '/jobs').catch(() => {})
    res.json({ ok: true, sessionId: session.id })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/broker/invest — broker invests client escrow
router.post('/broker/invest', requireAuth, async (req, res) => {
  const { sessionId, targetId, targetType } = req.body
  try {
    const { rows: [session] } = await pool.query(
      `SELECT * FROM broker_sessions WHERE id=$1 AND broker_id=$2 AND status='active'`,
      [sessionId, req.user.id]
    )
    if (!session) return res.status(404).json({ error: 'Session not found' })
    if (session.escrow_seeds <= 0) return res.status(400).json({ error: 'No seeds to invest' })

    // Get target price
    let priceAtInvest = 0
    if (targetType === 'grove' && targetId) {
      const { rows: [t] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [targetId])
      priceAtInvest = t?.seeds || 0
    } else {
      const { rows: [ms] } = await pool.query(`SELECT price FROM market_state WHERE market=$1`, [targetType])
      priceAtInvest = parseFloat(ms?.price || 0)
    }

    await pool.query(
      `UPDATE broker_sessions SET target_type=$1, target_user_id=$2, price_at_invest=$3 WHERE id=$4`,
      [targetType || 'grove', targetId || null, priceAtInvest, sessionId]
    )
    res.json({ ok: true, priceAtInvest })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/broker/close — close session and distribute returns
router.post('/broker/close', requireAuth, async (req, res) => {
  const { sessionId } = req.body
  try {
    const { rows: [session] } = await pool.query(
      `SELECT * FROM broker_sessions WHERE id=$1 AND broker_id=$2 AND status='active'`,
      [sessionId, req.user.id]
    )
    if (!session) return res.status(404).json({ error: 'Session not found' })

    // Get current value of target
    let currentPrice = parseFloat(session.price_at_invest)
    if (session.target_type === 'grove' && session.target_user_id) {
      const { rows: [t] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [session.target_user_id])
      currentPrice = t?.seeds || currentPrice
    } else if (['canopy','crude'].includes(session.target_type)) {
      const { rows: [ms] } = await pool.query(`SELECT price FROM market_state WHERE market=$1`, [session.target_type])
      currentPrice = parseFloat(ms?.price || currentPrice)
    }

    const baseline  = Math.max(1, parseFloat(session.price_at_invest))
    const mult      = Math.min(10, Math.max(0, currentPrice / baseline))
    const principal = session.escrow_seeds
    // 100% active for broker sessions (no safe half)
    const activeVal = Math.floor(principal * mult)
    const fee       = Math.floor(activeVal * BROKER_FEE) // flat 5%
    const gross     = activeVal - fee
    const profit    = gross - principal
    const brokerCut = profit > 0 ? Math.floor(profit * 0.10) : 0 // broker 10% of profits
    const clientGet = gross - brokerCut

    await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [Math.max(0, clientGet), session.client_id])
    await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [brokerCut, req.user.id])
    await pool.query(`UPDATE broker_sessions SET status='closed' WHERE id=$1`, [sessionId])

    res.json({ ok: true, clientGet: Math.max(0, clientGet), brokerCut, profit, mult: mult.toFixed(2) })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// ── ACCOUNTANT ────────────────────────────────────────────────────────────────
// GET /api/job-actions/accountant/clients — accountant sees their clients + portfolios
router.get('/accountant/clients', requireAuth, async (req, res) => {
  try {
    const { rows: clients } = await pool.query(
      `SELECT ac.id AS session_id, ac.client_id, ac.fee_seeds, ac.last_report_at,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS client_name,
              u.seeds AS client_seeds
       FROM accountant_clients ac JOIN users u ON u.id=ac.client_id
       WHERE ac.accountant_id=$1 AND ac.status='active'`,
      [req.user.id]
    )
    // For each client, get their investments (anonymised target names → idx only)
    const result = []
    for (const c of clients) {
      const { rows: investments } = await pool.query(
        `SELECT si.id, si.amount, si.seeds_at_invest,
                u.seeds AS current_seeds,
                ROW_NUMBER() OVER (ORDER BY si.invested_at) AS idx
         FROM stock_investments si JOIN users u ON u.id=si.target_id
         WHERE si.investor_id=$1`, [c.client_id]
      )
      // Get any pending advice for this client
      const { rows: advice } = await pool.query(
        `SELECT * FROM accountant_advice WHERE session_id=$1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 5`,
        [c.session_id]
      )
      result.push({ ...c, investments, pendingAdvice: advice })
    }
    res.json({ clients: result })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/accountant/hire — client hires an accountant
router.post('/accountant/hire', requireAuth, async (req, res) => {
  const { accountantId } = req.body
  try {
    const { rows: [acc] } = await pool.query(
      `SELECT j.hourly_rate FROM jobs j WHERE j.user_id=$1 AND j.role='accountant' AND j.active=true`, [accountantId]
    )
    if (!acc) return res.status(404).json({ error: 'Accountant not found' })
    await pool.query(
      `INSERT INTO accountant_clients (accountant_id, client_id, fee_seeds) VALUES ($1,$2,$3)
       ON CONFLICT (accountant_id, client_id) DO UPDATE SET status='active'`,
      [accountantId, req.user.id, acc.hourly_rate]
    )
    sendPush(accountantId, '📊 New client!', 'Someone hired you as their accountant.', '/jobs').catch(() => {})
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/accountant/advice — accountant sends advice
router.post('/accountant/advice', requireAuth, async (req, res) => {
  const { sessionId, action, amount, note, investmentIdx } = req.body
  try {
    const { rows: [session] } = await pool.query(
      `SELECT * FROM accountant_clients WHERE id=$1 AND accountant_id=$2 AND status='active'`,
      [sessionId, req.user.id]
    )
    if (!session) return res.status(403).json({ error: 'Not your client' })
    // Charge fee
    const { rows: [client] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [session.client_id])
    if ((client?.seeds || 0) < session.fee_seeds) return res.status(400).json({ error: 'Client has insufficient seeds for fee' })

    await pool.query(`UPDATE users SET seeds=seeds-$1 WHERE id=$2`, [session.fee_seeds, session.client_id])
    await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [session.fee_seeds, req.user.id])
    await pool.query(`UPDATE accountant_clients SET last_report_at=NOW() WHERE id=$1`, [sessionId])
    await pool.query(
      `INSERT INTO accountant_advice (session_id, action, amount, note, investment_idx) VALUES ($1,$2,$3,$4,$5)`,
      [sessionId, action, amount || 0, (note || '').slice(0, 200), investmentIdx || 0]
    )
    sendPush(session.client_id, '📊 Accountant advice!', `Your accountant says: ${action.toUpperCase()}`, '/jobs').catch(() => {})
    res.json({ ok: true })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/job-actions/accountant/my-advice — client reads their advice
router.get('/accountant/my-advice', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT aa.*, ac.accountant_id,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS accountant_name,
              si.target_id, ut.seeds AS target_current_seeds, si.seeds_at_invest, si.amount
       FROM accountant_advice aa
       JOIN accountant_clients ac ON ac.id=aa.session_id
       JOIN users u ON u.id=ac.accountant_id
       LEFT JOIN stock_investments si ON si.investor_id=$1 AND ROW_NUMBER() OVER() = aa.investment_idx
       LEFT JOIN users ut ON ut.id=si.target_id
       WHERE ac.client_id=$1 ORDER BY aa.created_at DESC LIMIT 10`,
      [req.user.id]
    )
    await pool.query(
      `UPDATE accountant_advice SET read_at=NOW() WHERE session_id IN
       (SELECT id FROM accountant_clients WHERE client_id=$1) AND read_at IS NULL`,
      [req.user.id]
    )
    // Get investments with actual names for the client
    const { rows: investments } = await pool.query(
      `SELECT si.id, si.amount, si.seeds_at_invest, u.seeds AS current_seeds,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS name,
              ROW_NUMBER() OVER(ORDER BY si.invested_at) AS idx
       FROM stock_investments si JOIN users u ON u.id=si.target_id WHERE si.investor_id=$1`, [req.user.id]
    )
    res.json({ advice: rows, investments })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// ── STEWARD ───────────────────────────────────────────────────────────────────
// GET /api/job-actions/steward/dashboard — steward sees client streak statuses
router.get('/steward/dashboard', requireAuth, async (req, res) => {
  try {
    const { rows: clients } = await pool.query(
      `SELECT sc.id AS steward_client_id, sc.client_id, sc.fee_seeds, sc.last_paid_at, sc.retainer_days,
              u.seeds AS client_seeds
       FROM steward_clients sc JOIN users u ON u.id=sc.client_id
       WHERE sc.steward_id=$1 AND sc.status='active'`,
      [req.user.id]
    )
    const result = []
    for (const c of clients) {
      // Get all streaks for this client (anonymised — show streak fuel only)
      const { rows: streaks } = await pool.query(
        `SELECT streak_days, fuel, user1_sent_today, user2_sent_today, last_day_processed,
                CASE WHEN user_id_1=$1 THEN 1 ELSE 2 END AS client_is_user
         FROM letter_streaks WHERE user_id_1=$1 OR user_id_2=$1`,
        [c.client_id]
      )
      result.push({ ...c, streaks })
    }
    res.json({ clients: result })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/steward/hire — client hires a steward
router.post('/steward/hire', requireAuth, async (req, res) => {
  const { stewardId, retainerDays } = req.body
  const days = [3, 7, 14].includes(Number(retainerDays)) ? Number(retainerDays) : 7
  try {
    const { rows: [st] } = await pool.query(
      `SELECT j.hourly_rate FROM jobs j WHERE j.user_id=$1 AND j.role='steward' AND j.active=true`, [stewardId]
    )
    if (!st) return res.status(404).json({ error: 'Steward not found' })
    // Check steward cap (10 clients)
    const { rows: [cnt] } = await pool.query(
      `SELECT COUNT(*) AS n FROM steward_clients WHERE steward_id=$1 AND status='active'`, [stewardId]
    )
    if (parseInt(cnt.n) >= 10) return res.status(400).json({ error: 'Steward is at capacity (10 clients)' })
    // Charge first retainer
    const { rows: [me] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [req.user.id])
    if ((me?.seeds || 0) < st.hourly_rate) return res.status(400).json({ error: 'Not enough seeds' })

    await pool.query(`UPDATE users SET seeds=seeds-$1 WHERE id=$2`, [st.hourly_rate, req.user.id])
    await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [st.hourly_rate, stewardId])
    await pool.query(
      `INSERT INTO steward_clients (steward_id, client_id, fee_seeds, retainer_days) VALUES ($1,$2,$3,$4)
       ON CONFLICT (steward_id, client_id) DO UPDATE SET status='active', last_paid_at=NOW()`,
      [stewardId, req.user.id, st.hourly_rate, days]
    )
    sendPush(stewardId, '🔔 New client!', 'Someone hired you as their Steward.', '/jobs').catch(() => {})
    res.json({ ok: true })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/steward/nudge — steward sends a streak warning
router.post('/steward/nudge', requireAuth, async (req, res) => {
  const { clientId } = req.body
  try {
    const { rows: [rel] } = await pool.query(
      `SELECT id FROM steward_clients WHERE steward_id=$1 AND client_id=$2 AND status='active'`,
      [req.user.id, clientId]
    )
    if (!rel) return res.status(403).json({ error: 'Not your client' })
    // Crude rises — streak saver = fuel activity
    updateMarketPrice('crude', 8).catch(() => {})
    sendPush(clientId, '⌛ Streak at risk!', 'Your Steward warns: send a letter today or your streak breaks!', '/letters').catch(() => {})
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// ── FORECASTER ────────────────────────────────────────────────────────────────
// GET /api/job-actions/forecaster/posts — get a forecaster's posts + subscriber count
router.get('/forecaster/posts/:userId', requireAuth, async (req, res) => {
  try {
    const { rows: posts } = await pool.query(
      `SELECT fp.id, fp.content, fp.created_at,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS author
       FROM forecaster_posts fp JOIN users u ON u.id=fp.forecaster_id
       WHERE fp.forecaster_id=$1 ORDER BY fp.created_at DESC LIMIT 20`,
      [req.params.userId]
    )
    const { rows: [subCount] } = await pool.query(
      `SELECT COUNT(*) AS n FROM forecaster_subscribers WHERE forecaster_id=$1`, [req.params.userId]
    )
    const { rows: [isSub] } = await pool.query(
      `SELECT 1 FROM forecaster_subscribers WHERE forecaster_id=$1 AND subscriber_id=$2`,
      [req.params.userId, req.user.id]
    )
    res.json({ posts, subscriberCount: parseInt(subCount.n), isSubscribed: !!isSub })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// GET /api/job-actions/forecaster/feed — subscriber sees all forecasters they follow
router.get('/forecaster/feed', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT fp.id, fp.content, fp.created_at,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS author,
              u.id AS forecaster_id
       FROM forecaster_posts fp
       JOIN forecaster_subscribers fs ON fs.forecaster_id=fp.forecaster_id
       JOIN users u ON u.id=fp.forecaster_id
       WHERE fs.subscriber_id=$1 ORDER BY fp.created_at DESC LIMIT 30`,
      [req.user.id]
    )
    res.json({ posts: rows })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/forecaster/post — forecaster posts an update
router.post('/forecaster/post', requireAuth, async (req, res) => {
  const { content } = req.body
  if (!content || content.length < 10) return res.status(400).json({ error: 'Post too short' })
  try {
    const { rows: [job] } = await pool.query(
      `SELECT id FROM jobs WHERE user_id=$1 AND role='forecaster'`, [req.user.id]
    )
    if (!job) return res.status(403).json({ error: 'Not a forecaster' })

    await pool.query(
      `INSERT INTO forecaster_posts (forecaster_id, content) VALUES ($1,$2)`,
      [req.user.id, content.slice(0, 500)]
    )
    // Canopy rises when forecasters post (market activity signal)
    updateMarketPrice('canopy', 3).catch(() => {})

    // Push to all subscribers
    const { rows: subs } = await pool.query(
      `SELECT subscriber_id FROM forecaster_subscribers WHERE forecaster_id=$1`, [req.user.id]
    )
    for (const s of subs) {
      sendPush(s.subscriber_id, '📡 Forecast update!', content.slice(0, 80), '/jobs').catch(() => {})
    }
    res.json({ ok: true, notified: subs.length })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/forecaster/subscribe — subscribe/unsubscribe
router.post('/forecaster/subscribe', requireAuth, async (req, res) => {
  const { forecasterId, action } = req.body
  try {
    if (action === 'subscribe') {
      await pool.query(
        `INSERT INTO forecaster_subscribers (forecaster_id, subscriber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [forecasterId, req.user.id]
      )
    } else {
      await pool.query(
        `DELETE FROM forecaster_subscribers WHERE forecaster_id=$1 AND subscriber_id=$2`,
        [forecasterId, req.user.id]
      )
    }
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// ── FARMER ────────────────────────────────────────────────────────────────────
const HARVEST_HOURS = 24

// GET /api/job-actions/farmer/plot — farmer sees their plot
router.get('/farmer/plot', requireAuth, async (req, res) => {
  try {
    const { rows: slots } = await pool.query(
      `SELECT fp.*, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS depositor_name
       FROM farmer_plots fp
       LEFT JOIN users u ON u.id=fp.depositor_id
       WHERE fp.farmer_id=$1 ORDER BY fp.slot_index`,
      [req.user.id]
    )
    // Auto-ready any that have matured
    const now = new Date()
    for (const s of slots) {
      if (s.status === 'planted' && s.harvest_at && new Date(s.harvest_at) <= now) {
        s.status = 'ready'
        await pool.query(`UPDATE farmer_plots SET status='ready' WHERE id=$1`, [s.id])
      }
    }
    res.json({ slots })
  } catch (e) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/farmer/plant — farmer plants a seed in a slot
router.post('/farmer/plant', requireAuth, async (req, res) => {
  const { slotIndex, seeds } = req.body
  const amt = Math.max(1, Math.floor(Number(seeds) || 0))
  try {
    // Check slot is empty
    const { rows: [slot] } = await pool.query(
      `SELECT * FROM farmer_plots WHERE farmer_id=$1 AND slot_index=$2`, [req.user.id, slotIndex]
    )
    if (!slot) return res.status(404).json({ error: 'Slot not found' })
    if (slot.status !== 'empty') return res.status(400).json({ error: 'Slot already occupied' })
    // Deduct farmer's own seeds
    const { rows: [me] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [req.user.id])
    if ((me?.seeds || 0) < amt) return res.status(400).json({ error: 'Not enough seeds' })

    await pool.query(`UPDATE users SET seeds=seeds-$1 WHERE id=$2`, [amt, req.user.id])
    await pool.query(
      `UPDATE farmer_plots SET status='planted', seeds_deposited=$1, depositor_id=NULL,
       planted_at=NOW(), harvest_at=NOW()+($2 || ' hours')::interval
       WHERE id=$3`,
      [amt, HARVEST_HOURS, slot.id]
    )
    res.json({ ok: true, harvestAt: new Date(Date.now() + HARVEST_HOURS * 3600000) })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/farmer/deposit — client deposits seeds into a farmer's slot
router.post('/farmer/deposit', requireAuth, async (req, res) => {
  const { farmerId, slotIndex, seeds } = req.body
  const amt = Math.max(1, Math.floor(Number(seeds) || 0))
  try {
    const { rows: [job] } = await pool.query(
      `SELECT j.hourly_rate FROM jobs j WHERE j.user_id=$1 AND j.role='farmer' AND j.active=true`, [farmerId]
    )
    if (!job) return res.status(404).json({ error: 'Farmer not found' })
    const { rows: [slot] } = await pool.query(
      `SELECT * FROM farmer_plots WHERE farmer_id=$1 AND slot_index=$2 AND status='empty'`,
      [farmerId, slotIndex]
    )
    if (!slot) return res.status(400).json({ error: 'Slot unavailable' })
    const { rows: [me] } = await pool.query(`SELECT seeds FROM users WHERE id=$1`, [req.user.id])
    const totalCost = amt + Math.floor(amt * 0.1) // 10% planting fee to farmer
    if ((me?.seeds || 0) < totalCost) return res.status(400).json({ error: 'Not enough seeds' })

    await pool.query(`UPDATE users SET seeds=seeds-$1 WHERE id=$2`, [totalCost, req.user.id])
    await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [Math.floor(amt * 0.1), farmerId])
    await pool.query(
      `UPDATE farmer_plots SET status='planted', seeds_deposited=$1, depositor_id=$2,
       fee_per_seed=$3, planted_at=NOW(), harvest_at=NOW()+($4 || ' hours')::interval
       WHERE id=$5`,
      [amt, req.user.id, job.hourly_rate, HARVEST_HOURS, slot.id]
    )
    sendPush(farmerId, '🌾 New deposit!', `${amt} seeds deposited in slot ${slotIndex + 1}.`, '/jobs').catch(() => {})
    res.json({ ok: true })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/job-actions/farmer/harvest — harvest a ready slot
router.post('/farmer/harvest', requireAuth, async (req, res) => {
  const { slotId } = req.body
  try {
    const { rows: [slot] } = await pool.query(
      `SELECT * FROM farmer_plots WHERE id=$1 AND farmer_id=$2 AND status='ready'`,
      [slotId, req.user.id]
    )
    if (!slot) return res.status(404).json({ error: 'Slot not ready or not found' })

    // Randomised harvest: weighted outcomes
    const roll = Math.random()
    let mult, outcome
    if (roll < 0.08)       { mult = 0;    outcome = 'rotten'  } // 8% rotten
    else if (roll < 0.22)  { mult = 0.5;  outcome = 'poor'    } // 14% poor
    else if (roll < 0.55)  { mult = 1.1;  outcome = 'normal'  } // 33% normal
    else if (roll < 0.80)  { mult = 1.4;  outcome = 'good'    } // 25% good
    else if (roll < 0.95)  { mult = 1.8;  outcome = 'great'   } // 15% great
    else                   { mult = 2.5;  outcome = 'bumper'  } // 5% bumper

    const result = Math.floor(slot.seeds_deposited * mult)

    // Award to depositor (or farmer if own seeds)
    const recipientId = slot.depositor_id || req.user.id
    if (result > 0) {
      await pool.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [result, recipientId])
    }
    await pool.query(
      `UPDATE farmer_plots SET status='harvested', harvest_result=$1, seeds_deposited=0,
       depositor_id=NULL, planted_at=NULL, harvest_at=NULL WHERE id=$2`,
      [result, slot.id]
    )
    // Reset to empty after short delay (immediate for now)
    await pool.query(`UPDATE farmer_plots SET status='empty', harvest_result=0 WHERE id=$1`, [slot.id])

    if (slot.depositor_id) {
      sendPush(slot.depositor_id, '🌾 Harvest ready!', `Your seeds grew into ${result} 🌱! (${outcome})`, '/jobs').catch(() => {})
    }

    res.json({ ok: true, result, outcome, mult, depositorId: slot.depositor_id })
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

export default router;
