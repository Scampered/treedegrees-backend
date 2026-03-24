// src/routes/jobs.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const JOB_META = {
  courier:     { icon: '🚚', label: 'Courier',     tagline: 'Deliver letters fast',          unit: 'per delivery', baseRate: 20 },
  writer:      { icon: '✍️',  label: 'Writer',      tagline: 'Write on commission',           unit: 'per 100 chars', baseRate: 5  },
  seed_broker: { icon: '🌱', label: 'Seed Broker', tagline: 'Invest seeds for clients',      unit: '% of profits',  baseRate: 10 },
  accountant:  { icon: '📊', label: 'Accountant',  tagline: 'Portfolio reports & advice',    unit: 'per report',    baseRate: 40 },
  steward:     { icon: '🔔', label: 'Steward',     tagline: 'Protect streaks for clients',   unit: 'per week',      baseRate: 30 },
  forecaster:  { icon: '📡', label: 'Forecaster',  tagline: 'Market & social analysis posts', unit: 'per week sub',  baseRate: 15 },
  farmer:      { icon: '🌾', label: 'Farmer',      tagline: 'Multi-invest with lower fees',  unit: 'one-time plot',  baseRate: 100 },
};

// ── GET /api/jobs/listings — all active workers grouped by role ───────────────
router.get('/listings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT j.id, j.user_id, j.role, j.hourly_rate, j.bio,
              j.rating_sum, j.rating_count, j.registered_at,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS name,
              u.city, u.country,
              EXISTS(
                SELECT 1 FROM friendships f
                WHERE f.status='accepted'
                  AND ((f.user_id_1=$1 AND f.user_id_2=j.user_id)
                    OR (f.user_id_2=$1 AND f.user_id_1=j.user_id))
              ) AS is_connection,
              -- Has the viewer hired this worker?
              (
                EXISTS(SELECT 1 FROM courier_requests    WHERE courier_id=j.user_id   AND requester_id=$1) OR
                EXISTS(SELECT 1 FROM writer_commissions  WHERE writer_id=j.user_id    AND client_id=$1) OR
                EXISTS(SELECT 1 FROM broker_sessions     WHERE broker_id=j.user_id    AND client_id=$1) OR
                EXISTS(SELECT 1 FROM accountant_clients  WHERE accountant_id=j.user_id AND client_id=$1) OR
                EXISTS(SELECT 1 FROM steward_clients     WHERE steward_id=j.user_id   AND client_id=$1) OR
                EXISTS(SELECT 1 FROM forecaster_subscribers WHERE forecaster_id=j.user_id AND subscriber_id=$1)
              ) AS has_hired,
              -- Has the viewer already rated?
              EXISTS(
                SELECT 1 FROM job_ratings WHERE job_id=j.id AND rater_id=$1
              ) AS has_rated
       FROM jobs j JOIN users u ON u.id = j.user_id
       WHERE j.active = true
       ORDER BY
         CASE WHEN j.rating_count > 0 THEN j.rating_sum::float / j.rating_count ELSE 0 END DESC,
         j.registered_at ASC`,
      [req.user.id]
    );
    // Group by role
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.role]) grouped[row.role] = [];
      const avg = row.rating_count > 0 ? (row.rating_sum / row.rating_count).toFixed(1) : null;
      grouped[row.role].push({ ...row, avgRating: avg ? parseFloat(avg) : null });
    }
    res.json({ listings: grouped, meta: JOB_META });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/jobs/my — current user's job ─────────────────────────────────────
router.get('/my', requireAuth, async (req, res) => {
  try {
    const { rows: [job] } = await pool.query(
      `SELECT j.*, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS name
       FROM jobs j JOIN users u ON u.id = j.user_id
       WHERE j.user_id = $1`,
      [req.user.id]
    );
    res.json({ job: job || null, meta: JOB_META });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/jobs/register — register for a job ─────────────────────────────
router.post('/register', requireAuth, async (req, res) => {
  const { role, bio, hourlyRate } = req.body;
  console.log('[register] role:', role, 'hourlyRate:', hourlyRate, 'validRoles:', Object.keys(JOB_META));
  if (!JOB_META[role]) return res.status(400).json({ error: `Invalid role: '${role}'. Valid: ${Object.keys(JOB_META).join(',')}` });
  try {
    // Check not already employed
    const { rows: [existing] } = await pool.query(
      `SELECT id FROM jobs WHERE user_id=$1`, [req.user.id]
    );
    console.log('[register] existing job:', existing);
    if (existing) return res.status(400).json({ error: 'Already registered for a job. Unregister first.' });

    const rate = Math.max(JOB_META[role].baseRate, Math.floor(Number(hourlyRate) || JOB_META[role].baseRate));
    console.log('[register] inserting...', req.user.id, role, rate);
    const { rows: [job] } = await pool.query(
      `INSERT INTO jobs (user_id, role, hourly_rate, bio)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, role, rate, (bio || '').slice(0, 200)]
    );
    console.log('[register] inserted job:', job?.id);
    res.json({ ok: true, job: { ...job, meta: JOB_META[role] } });
  } catch (e) { console.error('[register] DB error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// ── PATCH /api/jobs/my — update bio/rate ─────────────────────────────────────
router.patch('/my', requireAuth, async (req, res) => {
  const { bio, hourlyRate } = req.body;
  try {
    await pool.query(
      `UPDATE jobs SET bio=$1, hourly_rate=$2, updated_at=NOW() WHERE user_id=$3`,
      [(bio || '').slice(0, 200), Math.floor(Number(hourlyRate) || 0), req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── DELETE /api/jobs/my — unregister ─────────────────────────────────────────
router.delete('/my', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Get current job role
    const { rows: [job] } = await client.query(`SELECT role FROM jobs WHERE user_id=$1`, [req.user.id]);
    if (!job) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No job found' }); }

    // Refund pending courier requests (seeds already taken)
    if (job.role === 'courier') {
      const { rows: pending } = await client.query(
        `SELECT requester_id, fee_seeds FROM courier_requests WHERE courier_id=$1 AND status='accepted'`, [req.user.id]
      );
      for (const r of pending) {
        await client.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [r.fee_seeds, r.requester_id]);
      }
      await client.query(`UPDATE courier_requests SET status='declined' WHERE courier_id=$1 AND status IN ('pending','accepted')`, [req.user.id]);
    }
    // Refund pending writer commissions
    if (job.role === 'writer') {
      const { rows: pending } = await client.query(
        `SELECT client_id, fee_seeds FROM writer_commissions WHERE writer_id=$1 AND status='pending'`, [req.user.id]
      );
      for (const r of pending) {
        await client.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [r.fee_seeds, r.client_id]);
      }
      await client.query(`UPDATE writer_commissions SET status='rejected' WHERE writer_id=$1 AND status='pending'`, [req.user.id]);
    }
    // Refund active broker sessions — return escrow to client
    if (job.role === 'seed_broker') {
      const { rows: sessions } = await client.query(
        `SELECT client_id, escrow_seeds FROM broker_sessions WHERE broker_id=$1 AND status='active'`, [req.user.id]
      );
      for (const s of sessions) {
        await client.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [s.escrow_seeds, s.client_id]);
      }
      await client.query(`UPDATE broker_sessions SET status='recalled', escrow_seeds=0 WHERE broker_id=$1 AND status='active'`, [req.user.id]);
    }
    // Refund steward retainers in progress (pro-rate remaining days)
    if (job.role === 'steward') {
      await client.query(`UPDATE steward_clients SET status='ended' WHERE steward_id=$1`, [req.user.id]);
    }
    // Refund accountant active clients
    if (job.role === 'accountant') {
      await client.query(`UPDATE accountant_clients SET status='ended' WHERE accountant_id=$1`, [req.user.id]);
    }
    // Refund farmer deposited-but-unplanted slots
    if (job.role === 'farmer') {
      const { rows: deposits } = await client.query(
        `SELECT depositor_id, seeds_deposited FROM farmer_plots WHERE farmer_id=$1 AND status='deposited'`, [req.user.id]
      );
      for (const d of deposits) {
        if (d.depositor_id) await client.query(`UPDATE users SET seeds=seeds+$1 WHERE id=$2`, [d.seeds_deposited, d.depositor_id]);
      }
      await client.query(`UPDATE farmer_plots SET status='empty', seeds_deposited=0, depositor_id=NULL WHERE farmer_id=$1 AND status='deposited'`, [req.user.id]);
    }

    // Delete job (ratings are deleted via CASCADE from job_ratings)
    await client.query(`DELETE FROM jobs WHERE user_id=$1`, [req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[resign]', e.message);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── POST /api/jobs/:jobId/rate — leave a rating ───────────────────────────────
router.post('/:jobId/rate', requireAuth, async (req, res) => {
  const { rating, review } = req.body;
  const r = Math.floor(Number(rating));
  if (r < 1 || r > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
  try {
    const { rows: [job] } = await pool.query(`SELECT id, user_id FROM jobs WHERE id=$1`, [req.params.jobId]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.user_id === req.user.id) return res.status(400).json({ error: 'Cannot rate yourself' });

    await pool.query(
      `INSERT INTO job_ratings (job_id, rater_id, rating, review) VALUES ($1,$2,$3,$4)
       ON CONFLICT (job_id, rater_id) DO UPDATE SET rating=$3, review=$4`,
      [job.id, req.user.id, r, (review || '').slice(0, 300)]
    );
    // Recompute rating totals
    await pool.query(
      `UPDATE jobs SET
         rating_sum   = (SELECT SUM(rating) FROM job_ratings WHERE job_id=$1),
         rating_count = (SELECT COUNT(*)    FROM job_ratings WHERE job_id=$1)
       WHERE id=$1`,
      [job.id]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }); }
});

export default router;
