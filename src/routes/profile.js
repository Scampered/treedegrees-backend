import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();

async function getProfileData(userId, isOwn) {
  const { rows: [u] } = await pool.query(
    `SELECT u.id, COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS nickname,
            u.full_name, u.bio, u.city, u.country, u.latitude, u.longitude,
            u.daily_note, u.daily_note_updated_at, u.daily_note_emoji,
            u.daily_mood, u.daily_mood_updated_at,
            u.is_public, u.created_at, COALESCE(u.seeds,0) AS seeds, u.friend_code,
            j.role AS job_role,
            (SELECT COUNT(*) FROM letters WHERE sender_id=u.id) AS letters_sent,
            (SELECT COUNT(*) FROM letters WHERE recipient_id=u.id) AS letters_received,
            (SELECT COUNT(*) FROM friendships WHERE (user_id_1=u.id OR user_id_2=u.id) AND status='accepted') AS connection_count
     FROM users u LEFT JOIN jobs j ON j.user_id=u.id
     WHERE u.id=$1 AND u.deleted_at IS NULL`, [userId]
  );
  if (!u) return null;
  const noteFresh = u.daily_note_updated_at && (Date.now()-new Date(u.daily_note_updated_at))<86400000;
  const moodFresh = u.daily_mood_updated_at && (Date.now()-new Date(u.daily_mood_updated_at))<86400000;
  return {
    id:u.id, nickname:u.nickname, fullName:u.full_name, bio:u.bio,
    city:u.city, country:u.country, latitude:u.latitude, longitude:u.longitude,
    isPublic:u.is_public, createdAt:u.created_at,
    seeds: isOwn ? parseInt(u.seeds) : undefined,
    friendCode: isOwn ? u.friend_code : undefined,
    jobRole:u.job_role,
    lettersSent:parseInt(u.letters_sent||0), lettersReceived:parseInt(u.letters_received||0),
    connectionCount:parseInt(u.connection_count||0),
    dailyNote: noteFresh ? u.daily_note : null,
    notePostedAt:u.daily_note_updated_at, noteEmoji:u.daily_note_emoji,
    mood: moodFresh ? u.daily_mood : null,
  };
}

router.get('/me', requireAuth, async (req, res) => {
  try {
    const p = await getProfileData(req.user.id, true);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) {
    const p = await getProfileData(req.user.id, true);
    return res.json(p);
  }
  try {
    const [uid1,uid2] = [req.user.id,targetId].sort();
    const { rows:[f] } = await pool.query(
      `SELECT id FROM friendships WHERE user_id_1=$1 AND user_id_2=$2 AND status='accepted'`, [uid1,uid2]
    );
    if (!f) return res.status(403).json({ error: 'Only direct connections can view this profile' });
    const p = await getProfileData(targetId, false);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const [s1,s2] = [req.user.id,targetId].sort();
    const { rows:[streak] } = await pool.query(
      `SELECT streak_days, fuel FROM letter_streaks WHERE user_id_1=$1 AND user_id_2=$2`, [s1,s2]
    );
    res.json({ ...p, streak: streak||null });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

export default router;
