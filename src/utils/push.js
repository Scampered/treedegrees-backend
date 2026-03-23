// src/utils/push.js — Web Push sender
import webpush from 'web-push';
import pool from '../db/pool.js';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || ''
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || ''

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:tree3degrees@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE)
}

export { VAPID_PUBLIC }

export async function sendPush(userId, title, body, url = '/') {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return
  try {
    const { rows } = await pool.query(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1`, [userId]
    )
    for (const sub of rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title, body, url, icon: '/tree-icon.svg' })
        )
      } catch (e) {
        // Remove expired/invalid subscriptions
        if (e.statusCode === 410 || e.statusCode === 404) {
          await pool.query(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [sub.endpoint])
        }
      }
    }
  } catch {}
}

export async function savePushSubscription(userId, subscription) {
  const { endpoint, keys: { p256dh, auth } } = subscription
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1,$2,$3,$4) ON CONFLICT (endpoint) DO UPDATE SET user_id=$1`,
    [userId, endpoint, p256dh, auth]
  )
}
