// src/utils/notify.js — create in-app notifications
import pool from '../db/pool.js';

export async function notify(userId, type, title, body = '', link = '/dashboard') {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, body.slice(0, 300), link]
    );
  } catch (e) {
    console.error('[notify]', e.message);
  }
}

// Notify multiple users at once
export async function notifyMany(userIds, type, title, body = '', link = '/dashboard') {
  for (const uid of userIds) {
    await notify(uid, type, title, body, link);
  }
}
