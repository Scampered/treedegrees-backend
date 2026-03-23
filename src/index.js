// src/index.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import friendsRoutes from './routes/friends.js';
import graphRoutes from './routes/graph.js';
import usersRoutes from './routes/users.js';
import nicknamesRoutes from './routes/nicknames.js';
import lettersRoutes from './routes/letters.js';
import adminRoutes from './routes/admin.js';
import groupsRoutes from './routes/groups.js';
import gamesRoutes from './routes/games.js';
import groveRoutes from './routes/grove.js';
import marketRoutes from './routes/market.js';
import pushRoutes from './routes/push.js';
import { requireAuth } from './middleware/auth.js';
import pool from './db/pool.js';
import { verifyToken } from './utils/auth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://treedegrees.vercel.app',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

app.use(helmet());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true, legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  message: { error: 'Rate limit exceeded' },
});

app.use(express.json({ limit: '16kb' }));

// ── User popups — authenticated, returns unseen messages ─────────────────────
app.get('/api/popups', apiLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.json([]);
    const payload = verifyToken(header.slice(7));
    const { rows } = await pool.query(
      `SELECT p.* FROM admin_popups p
       WHERE (p.target = 'all' OR p.target = $1)
         AND (p.expires_at IS NULL OR p.expires_at > NOW())
         AND p.id NOT IN (
           SELECT popup_id FROM popup_dismissals WHERE user_id = $1
         )
       ORDER BY p.created_at DESC`,
      [payload.id]
    );
    res.json(rows.map(p => ({
      id: p.id,
      header: p.header,
      subheader: p.subheader,
      buttonText: p.button_text,
    })));
  } catch { res.json([]); }
});

// ── Dismiss popup ─────────────────────────────────────────────────────────────
app.post('/api/popups/:id/dismiss', apiLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.json({});
    const payload = verifyToken(header.slice(7));
    await pool.query(
      `INSERT INTO popup_dismissals (popup_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.params.id, payload.id]
    );
    res.json({ dismissed: true });
  } catch { res.json({}); }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'TreeDegrees API' }));

// ── Public maintenance check (no auth needed) ─────────────────────────────────
app.get('/api/maintenance', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT page_key, is_down, message FROM page_maintenance'
    );
    const map = {};
    rows.forEach(r => { map[r.page_key] = { isDown: r.is_down, message: r.message }; });
    res.json(map);
  } catch {
    res.json({});
  }
});

// ── Admin "am I admin?" check — MUST be before adminRoutes so it doesn't
//    get caught by requireAdmin. Any logged-in user can call this. ─────────────
app.get('/api/admin/me', apiLimiter, async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.json({ isAdmin: false });
    const payload = verifyToken(header.slice(7));
    const { rows } = await pool.query(
      'SELECT is_admin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [payload.id]
    );
    res.json({ isAdmin: rows[0]?.is_admin || false });
  } catch {
    res.json({ isAdmin: false });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',      authLimiter, authRoutes);
app.use('/api/friends',   apiLimiter,  friendsRoutes);
app.use('/api/graph',     apiLimiter,  graphRoutes);
app.use('/api/users',     apiLimiter,  usersRoutes);
app.use('/api/nicknames', apiLimiter,  nicknamesRoutes);
app.use('/api/letters',   apiLimiter,  lettersRoutes);
app.use('/api/admin',     apiLimiter,  adminRoutes);
app.use('/api/groups',    apiLimiter,  groupsRoutes);
app.use('/api/games',     apiLimiter,  gamesRoutes);
app.use('/api/market',    apiLimiter,  marketRoutes);
app.use('/api/push',      apiLimiter,  pushRoutes);
app.use('/api/grove',     apiLimiter,  groveRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🌳 TreeDegrees API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Allowed origins: ${allowedOrigins.join(', ')}`);
});
