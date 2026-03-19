// src/routes/auth.js
import { Router } from 'express';
import crypto from 'crypto';
import pool from '../db/pool.js';
import {
  hashPassword, verifyPassword, signToken,
  generateFriendCode, isValidEmail, isStrongPassword,
} from '../utils/auth.js';
import { containsProfanity, profanityError } from '../utils/profanity.js';
import { requireAuth } from '../middleware/auth.js';
import { sendVerificationEmail, sendEmailChangeEmail } from '../utils/email.js';

const router = Router();

function makeVerifyToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { fullName, nickname, email, password, dateOfBirth, city, country, latitude, longitude } = req.body;

    if (!fullName || !email || !password || !dateOfBirth || !city || !country)
      return res.status(400).json({ error: 'All required fields must be provided' });
    if (!isValidEmail(email))
      return res.status(400).json({ error: 'Invalid email address' });
    if (!isStrongPassword(password))
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, and a number' });
    if (containsProfanity(fullName))
      return res.status(400).json({ error: profanityError('Full name') });
    if (nickname && containsProfanity(nickname))
      return res.status(400).json({ error: profanityError('Nickname') });

    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email.toLowerCase()]
    );
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'An account with this email already exists' });

    const passwordHash = await hashPassword(password);
    const friendCode   = generateFriendCode(fullName, dateOfBirth, city);
    const resolvedNick = (nickname || fullName.split(' ')[0]).trim();

    const codeCheck = await pool.query('SELECT id FROM users WHERE friend_code = $1', [friendCode]);
    if (codeCheck.rows.length > 0)
      return res.status(409).json({ error: 'Friend code collision. Please contact support.' });

    // Create verify token (24h expiry)
    const verifyToken   = makeVerifyToken();
    const verifyExpires = new Date(Date.now() + 24 * 3600 * 1000);

    const result = await pool.query(
      `INSERT INTO users
        (full_name, nickname, email, password_hash, date_of_birth, city, country,
         latitude, longitude, friend_code, email_verified, email_verify_token, email_verify_expires)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12)
       RETURNING id, full_name, nickname, email, city, country, friend_code`,
      [
        fullName.trim(), resolvedNick, email.toLowerCase().trim(),
        passwordHash, dateOfBirth, city.trim(), country.trim(),
        latitude || null, longitude || null, friendCode,
        verifyToken, verifyExpires,
      ]
    );

    const user  = result.rows[0];
    const token = signToken({ id: user.id, email: user.email });

    // Send verification email (non-blocking — don't fail signup if email fails)
    sendVerificationEmail(user.email, user.nickname, verifyToken).catch(err =>
      console.error('Verification email failed:', err.message)
    );

    res.status(201).json({
      token,
      user: {
        id: user.id, fullName: user.full_name, nickname: user.nickname,
        email: user.email, city: user.city, country: user.country,
        friendCode: user.friend_code, emailVerified: false,
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
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const result = await pool.query(
      `SELECT id, full_name, nickname, email, password_hash, city, country,
              latitude, longitude, friend_code, bio, is_public, connections_public,
              location_privacy, daily_note, daily_note_updated_at, email_verified
       FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user  = result.rows[0];
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
        emailVerified: user.email_verified,
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
              daily_note, daily_note_updated_at, email_verified, created_at
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
      emailVerified: u.email_verified, createdAt: u.created_at,
    });
  } catch (err) {
    console.error('Me error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/auth/verify-email?token=...&email=... ────────────────────────────
// Called when user clicks the link in their email
router.get('/verify-email', async (req, res) => {
  try {
    const { token, email } = req.query;
    if (!token || !email)
      return res.status(400).json({ error: 'Invalid verification link' });

    const { rows } = await pool.query(
      `SELECT id FROM users
       WHERE email = $1
         AND email_verify_token = $2
         AND email_verify_expires > NOW()
         AND deleted_at IS NULL`,
      [email.toLowerCase(), token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Verification link is invalid or has expired' });
    }

    await pool.query(
      `UPDATE users SET
        email_verified = true,
        email_verify_token = NULL,
        email_verify_expires = NULL
       WHERE id = $1`,
      [rows[0].id]
    );

    res.json({ verified: true, message: 'Email verified successfully' });
  } catch (err) {
    console.error('Verify email error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/resend-verification ────────────────────────────────────────
router.post('/resend-verification', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, nickname, email_verified FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (rows[0].email_verified) return res.json({ message: 'Already verified' });

    const verifyToken   = makeVerifyToken();
    const verifyExpires = new Date(Date.now() + 24 * 3600 * 1000);

    await pool.query(
      'UPDATE users SET email_verify_token=$1, email_verify_expires=$2 WHERE id=$3',
      [verifyToken, verifyExpires, req.user.id]
    );

    const sent = await sendVerificationEmail(rows[0].email, rows[0].nickname, verifyToken);
    if (!sent) return res.status(500).json({ error: 'Failed to send email. Check server email configuration.' });

    res.json({ message: 'Verification email sent' });
  } catch (err) {
    console.error('Resend error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/verify-email (legacy — mark verified from token in body) ───
router.post('/verify-email', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET email_verified = true WHERE id = $1',
      [req.user.id]
    );
    res.json({ message: 'Email verified' });
  } catch (err) {
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

// ── POST /api/auth/request-email-change ──────────────────────────────────────
// User submits new email + current password → sends confirmation to NEW email
router.post('/request-email-change', requireAuth, async (req, res) => {
  try {
    const { newEmail, password } = req.body;

    if (!newEmail || !password)
      return res.status(400).json({ error: 'New email and password are required' });
    if (!isValidEmail(newEmail))
      return res.status(400).json({ error: 'Invalid email address' });

    // Verify password
    const { rows: userRows } = await pool.query(
      'SELECT password_hash, nickname, email FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });

    const valid = await verifyPassword(password, userRows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Make sure new email isn't already taken
    const { rows: existing } = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL AND id != $2',
      [newEmail.toLowerCase().trim(), req.user.id]
    );
    if (existing.length > 0)
      return res.status(409).json({ error: 'This email is already in use' });

    // Store pending email + token on the user row
    const changeToken   = makeVerifyToken();
    const changeExpires = new Date(Date.now() + 24 * 3600 * 1000);

    await pool.query(
      `UPDATE users SET
        pending_email = $1,
        email_verify_token = $2,
        email_verify_expires = $3
       WHERE id = $4`,
      [newEmail.toLowerCase().trim(), changeToken, changeExpires, req.user.id]
    );

    // Send confirmation to the NEW email address
    await sendEmailChangeEmail(
      newEmail.toLowerCase().trim(),
      userRows[0].nickname,
      changeToken,
      newEmail
    );

    res.json({ message: 'Confirmation email sent to your new address. Click the link to confirm.' });
  } catch (err) {
    console.error('Request email change error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/auth/confirm-email-change?token=...&email=... ───────────────────
// User clicks link in new email → swap email in DB
router.get('/confirm-email-change', async (req, res) => {
  try {
    const { token, email } = req.query;
    if (!token || !email)
      return res.status(400).json({ error: 'Invalid link' });

    const { rows } = await pool.query(
      `SELECT id, pending_email FROM users
       WHERE email_verify_token = $1
         AND email_verify_expires > NOW()
         AND pending_email IS NOT NULL
         AND deleted_at IS NULL`,
      [token]
    );

    if (rows.length === 0)
      return res.status(400).json({ error: 'Link is invalid or has expired' });

    const { id, pending_email } = rows[0];

    await pool.query(
      `UPDATE users SET
        email = $1,
        pending_email = NULL,
        email_verify_token = NULL,
        email_verify_expires = NULL,
        email_verified = true
       WHERE id = $2`,
      [pending_email, id]
    );

    res.json({ confirmed: true, message: 'Email updated successfully' });
  } catch (err) {
    console.error('Confirm email change error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
