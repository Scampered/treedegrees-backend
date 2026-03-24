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
              -- Check if requester is a connection (1st degree)
              EXISTS(
                SELECT 1 FROM friendships f
                WHERE f.status='accepted'
                  AND ((f.user_id=$1 AND f.friend_id=j.user_id)
                    OR (f.friend_id=$1 AND f.user_id=j.user_id))
              ) AS is_connection
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
  if (!JOB_META[role]) return res.status(400).json({ error: 'Invalid role' });
  try {
    // Check not already employed
    const { rows: [existing] } = await pool.query(
      `SELECT id FROM jobs WHERE user_id=$1`, [req.user.id]
    );
    if (existing) return res.status(400).json({ error: 'Already registered for a job. Unregister first.' });

    const rate = Math.max(JOB_META[role].baseRate, Math.floor(Number(hourlyRate) || JOB_META[role].baseRate));
    const { rows: [job] } = await pool.query(
      `INSERT INTO jobs (user_id, role, hourly_rate, bio)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, role, rate, (bio || '').slice(0, 200)]
    );
    res.json({ ok: true, job: { ...job, meta: JOB_META[role] } });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Server error' }); }
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
  try {
    await pool.query(`DELETE FROM jobs WHERE user_id=$1`, [req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
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
