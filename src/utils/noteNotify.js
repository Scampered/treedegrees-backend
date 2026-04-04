import pool from '../db/pool.js';
import { sendPush } from './push.js';
import { notify } from './notify.js';

export async function notifyConnectionsOfNote(userId, noteText, noteEmoji) {
  try {
    const { rows: connections } = await pool.query(
      `SELECT CASE WHEN user_id_1=$1 THEN user_id_2 ELSE user_id_1 END AS friend_id
       FROM friendships WHERE (user_id_1=$1 OR user_id_2=$1) AND status='accepted'`,
      [userId]
    );
    if (!connections.length) return;
    const { rows: [me] } = await pool.query(
      `SELECT COALESCE(nickname, split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [userId]
    );
    const name = me?.name || 'Someone';
    const preview = noteText ? `"${noteText.slice(0, 60)}${noteText.length > 60 ? '…' : ''}"` : '';
    const title = `${noteEmoji || '📝'} ${name} posted a note`;
    for (const { friend_id } of connections) {
      sendPush(friend_id, title, preview, '/feed').catch(() => {});
      notify(friend_id, 'note_posted', title, preview, '/feed').catch(() => {});
    }
  } catch(e) { console.error('[noteNotify]', e.message); }
}
