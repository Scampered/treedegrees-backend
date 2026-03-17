// src/routes/auth.js
import { Router } from 'express';
import pool from '../db/pool.js';
import {
  hashPassword, verifyPassword, signToken,
  generateFriendCode, isValidEmail, isStrongPassword,
} from '../utils/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { containsProfanity, profanityError } from '../utils/profanity.js';

const router = Router();

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { fullName, nickname, email, password, dateOfBirth, city, country, latitude, longitude } = req.body;

    if (!fullName || !email || !password || !dateOfBirth || !city || !country) {
      return res.status(400).json({ error: 'All required fields must be provided' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters with uppercase, lowercase, and a number',
      });
    }

    // Profanity check on name and nickname
    if (containsProfanity(fullName)) {
      return res.status(400).json({ error: profanityError('Full name') });
    }
    if (nickname && containsProfanity(nickname)) {
      return res.status(400).json({ error: profanityError('Nickname') });
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await hashPassword(password);
    const friendCode = generateFriendCode(fullName, dateOfBirth, city);

    const codeCheck = await pool.query('SELECT id FROM users WHERE friend_code = $1', [friendCode]);
    if (codeCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Friend code collision detected. Please contact support.' });
    }

    // Nickname falls back to first name if not provided
    const resolvedNickname = (nickname || fullName.split(' ')[0]).trim();

    const result = await pool.query(
      `INSERT INTO users
        (full_name, nickname, email, password_hash, date_of_birth, city, country, latitude, longitude, friend_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, full_name, nickname, email, city, country, friend_code, created_at`,
      [
        fullName.trim(), resolvedNickname,
        email.toLowerCase().trim(), passwordHash,
        dateOfBirth, city.trim(), country.trim(),
        latitude || null, longitude || null, friendCode,
      ]
    );

    const user = result.rows[0];
    const token = signToken({ id: user.id, email: user.email });

    res.status(201).json({
      token,
      user: {
        id: user.id, fullName: user.full_name, nickname: user.nickname,
        email: user.email, city: user.city, country: user.country,
        friendCode: user.friend_code,
      },
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const result = await pool.query(
      `SELECT id, full_name, nickname, email, password_hash, city, country, latitude, longitude,
              friend_code, bio, is_public, connections_public, location_privacy,
              daily_note, daily_note_updated_at
       FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ id: user.id, email: user.email });

    res.json({
      token,
      user: {
        id: user.id, fullName: user.full_name, nickname: user.nickname,
        email: user.email, city: user.city, country: user.country,
        latitude: user.latitude, longitude: user.longitude,
        friendCode: user.friend_code, bio: user.bio,
        isPublic: user.is_public, connectionsPublic: user.connections_public,
        locationPrivacy: user.location_privacy,
        dailyNote: user.daily_note, dailyNoteUpdatedAt: user.daily_note_updated_at,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, nickname, email, city, country, latitude, longitude,
              friend_code, bio, is_public, connections_public, location_privacy,
              daily_note, daily_note_updated_at, created_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const u = result.rows[0];
    res.json({
      id: u.id, fullName: u.full_name, nickname: u.nickname,
      email: u.email, city: u.city, country: u.country,
      latitude: u.latitude, longitude: u.longitude,
      friendCode: u.friend_code, bio: u.bio,
      isPublic: u.is_public, connectionsPublic: u.connections_public,
      locationPrivacy: u.location_privacy,
      dailyNote: u.daily_note, dailyNoteUpdatedAt: u.daily_note_updated_at,
      createdAt: u.created_at,
    });
  } catch (err) {
    console.error('Me error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/auth/account ──────────────────────────────────────────────────
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    const user = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const valid = await verifyPassword(password, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    await pool.query(
      `UPDATE users SET
        deleted_at = NOW(),
        email = 'deleted_' || id || '@treedegrees.deleted',
        full_name = '[Deleted User]', nickname = '[Deleted]',
        password_hash = '', bio = NULL, daily_note = NULL,
        date_of_birth = '1900-01-01'
       WHERE id = $1`,
      [req.user.id]
    );
    res.json({ message: 'Account deleted successfully' });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
