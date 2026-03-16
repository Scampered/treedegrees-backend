// src/utils/auth.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const SALT_ROUNDS = 12;

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d', // 30 days — stays logged in
  });
}

export function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

export function generateFriendCode(fullName, dateOfBirth, city) {
  const salt = process.env.FRIENDCODE_SALT;
  if (!salt) throw new Error('FRIENDCODE_SALT env var not set');
  const raw = `${fullName.toLowerCase().trim()}|${dateOfBirth}|${city.toLowerCase().trim()}|${salt}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash.substring(0, 16).toUpperCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isStrongPassword(pw) {
  return pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw);
}
