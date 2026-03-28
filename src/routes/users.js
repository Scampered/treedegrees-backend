import { awardSeeds } from './grove.js';
// src/routes/users.js
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { containsProfanity, profanityError } from '../utils/profanity.js';

const router = Router();

const COUNTRY_CAPITALS = {
  'bahrain': [26.2235, 50.5876], 'saudi arabia': [24.6877, 46.7219],
  'united arab emirates': [24.4539, 54.3773], 'kuwait': [29.3759, 47.9774],
  'qatar': [25.2854, 51.5310], 'oman': [23.5880, 58.3829],
  'united states': [38.9072, -77.0369], 'united kingdom': [51.5074, -0.1278],
  'germany': [52.5200, 13.4050], 'france': [48.8566, 2.3522],
  'japan': [35.6762, 139.6503], 'china': [39.9042, 116.4074],
  'india': [28.6139, 77.2090], 'australia': [-35.2809, 149.1300],
  'canada': [45.4215, -75.6972], 'brazil': [-15.7942, -47.8822],
  'south africa': [-25.7479, 28.2293], 'nigeria': [9.0765, 7.3986],
  'egypt': [30.0444, 31.2357], 'turkey': [39.9334, 32.8597],
  'russia': [55.7558, 37.6173], 'pakistan': [33.7294, 73.0931],
  'indonesia': [-6.2088, 106.8456], 'malaysia': [3.1390, 101.6869],
  'singapore': [1.3521, 103.8198],
};

function getCapitalCoords(country) {
  return COUNTRY_CAPITALS[(country || '').toLowerCase().trim()] || null;
}

// ── PATCH /api/users/profile ──────────────────────────────────────────────────
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { bio, nickname, fullName, city, country, latitude, longitude, isPublic, connectionsPublic, locationPrivacy } = req.body;

    // Profanity check
    if (fullName && containsProfanity(fullName))
      return res.status(400).json({ error: profanityError('Full name') });
    if (nickname && containsProfanity(nickname))
      return res.status(400).json({ error: profanityError('Nickname') });
    if (bio && containsProfanity(bio))
      return res.status(400).json({ error: profanityError('Bio') });

    // Location cooldown: 48 hours between city/country changes
    const changingLocation = city !== undefined || country !== undefined;
    if (changingLocation) {
      const { rows: [cur] } = await pool.query(
        `SELECT city, country, location_changed_at FROM users WHERE id=$1`, [req.user.id]
      );
      const sameCity    = !city    || city    === cur?.city;
      const sameCountry = !country || country === cur?.country;
      if (!sameCity || !sameCountry) {
        if (cur?.location_changed_at) {
          const hoursSince = (Date.now() - new Date(cur.location_changed_at)) / 3600000;
          if (hoursSince < 48) {
            const hoursLeft = Math.ceil(48 - hoursSince);
            return res.status(429).json({ error: `Location can only be changed every 48 hours. ${hoursLeft}h remaining. Note: your map position will be locked until then.` });
          }
        }
      }
    }

    const validPrivacy = ['exact', 'private', 'hidden'];
    const privacyValue = validPrivacy.includes(locationPrivacy) ? locationPrivacy : null;

    const { rows } = await pool.query(
      `UPDATE users SET
        bio = COALESCE($1, bio),
        nickname = COALESCE($2, nickname),
        full_name = COALESCE($11, full_name),
        city = COALESCE($3, city),
        country = COALESCE($4, country),
        latitude = COALESCE($5, latitude),
        longitude = COALESCE($6, longitude),
        is_public = COALESCE($7, is_public),
        connections_public = COALESCE($8, connections_public),
        location_privacy = COALESCE($9, location_privacy),
        location_changed_at = CASE
          WHEN $3 IS NOT NULL OR $4 IS NOT NULL THEN NOW()
          ELSE location_changed_at END
       WHERE id = $10 AND deleted_at IS NULL
       RETURNING id, full_name, nickname, bio, city, country, latitude, longitude,
                 is_public, connections_public, location_privacy, location_changed_at`,
      [bio, nickname || null, city, country, latitude, longitude, isPublic, connectionsPublic, privacyValue, req.user.id, fullName || null]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    res.json({
      id: u.id, fullName: u.full_name, nickname: u.nickname, bio: u.bio,
      city: u.city, country: u.country,
      latitude: u.latitude, longitude: u.longitude,
      isPublic: u.is_public, connectionsPublic: u.connections_public,
      locationPrivacy: u.location_privacy,
    });
  } catch (err) {
    console.error('Update profile error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/users/daily-note ────────────────────────────────────────────────
router.post('/daily-note', requireAuth, async (req, res) => {
  try {
    const { note, emoji } = req.body;
    if (!note || note.trim().length === 0) return res.status(400).json({ error: 'Note cannot be empty' });
    if (note.length > 280) return res.status(400).json({ error: 'Note must be 280 characters or less' });
    // Validate note emoji if provided
    const noteEmoji = emoji && emoji.trim() && emoji.trim().length <= 8 ? emoji.trim() : null;

    const { rows } = await pool.query('SELECT daily_note_updated_at FROM users WHERE id = $1', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const lastUpdate = rows[0].daily_note_updated_at;
    if (lastUpdate) {
      const hoursSince = (Date.now() - new Date(lastUpdate).getTime()) / 36e5;
      if (hoursSince < 24) {
        const hoursLeft = (24 - hoursSince).toFixed(1);
        return res.status(429).json({ error: `You can post again in ${hoursLeft} hours`, hoursLeft: parseFloat(hoursLeft) });
      }
    }

    const updated = await pool.query(
      `UPDATE users SET daily_note=$1, daily_note_updated_at=NOW(),
        daily_note_emoji=$2::text, daily_note_emoji_updated_at=CASE WHEN $2::text IS NOT NULL THEN NOW() ELSE daily_note_emoji_updated_at END
       WHERE id=$3 RETURNING daily_note, daily_note_updated_at, daily_note_emoji`,
      [note.trim(), noteEmoji || null, req.user.id]
    );
    await awardSeeds(req.user.id, 20, 'daily_note');
    res.json({
      dailyNote: updated.rows[0].daily_note,
      dailyNoteUpdatedAt: updated.rows[0].daily_note_updated_at,
      noteEmoji: updated.rows[0].daily_note_emoji,
    });
  } catch (err) {
    console.error('Daily note error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/users/daily-mood ────────────────────────────────────────────────
router.post('/daily-mood', requireAuth, async (req, res) => {
  const COOLDOWN_MS = 4 * 3600 * 1000; // 4 hours
  try {
    const { mood } = req.body;
    if (!mood || typeof mood !== 'string') return res.status(400).json({ error: 'Mood required' });
    const trimmed = mood.trim();
    if (!trimmed || trimmed.length > 8) return res.status(400).json({ error: 'Invalid mood' });

    const { rows } = await pool.query(
      'SELECT daily_mood, daily_mood_updated_at FROM users WHERE id = $1', [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const last = rows[0].daily_mood_updated_at;
    const ageMs = last ? Date.now() - new Date(last).getTime() : Infinity;
    const isFirstSet = !last || ageMs >= COOLDOWN_MS; // cooldown expired OR never set

    // Enforce cooldown server-side — reject if called again within 4h
    if (!isFirstSet) {
      const hoursLeft = ((COOLDOWN_MS - ageMs) / 3600000).toFixed(1);
      return res.status(429).json({
        error: `Mood can only be updated every 4 hours. Try again in ${hoursLeft}h.`,
        hoursLeft: parseFloat(hoursLeft),
      });
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE users SET daily_mood = $1, daily_mood_updated_at = NOW()
       WHERE id = $2 RETURNING daily_mood, daily_mood_updated_at`,
      [trimmed, req.user.id]
    );

    await awardSeeds(req.user.id, 10, 'set_mood');

    res.json({ mood: updated.daily_mood, moodUpdatedAt: updated.daily_mood_updated_at });
  } catch (err) {
    console.error('Mood error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/users/daily-mood — clear mood ─────────────────────────────────
router.delete('/daily-mood', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET daily_mood = NULL, daily_mood_updated_at = NULL WHERE id = $1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/users/:id/like-note — like/react to a connection's note ─────────
router.post('/:id/like-note', requireAuth, async (req, res) => {
  const { emoji } = req.body
  const targetId = req.params.id
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot like your own note' })
  // Validate emoji — must be 1-2 chars (emoji) not plain text
  const emojiRegex = /^(\p{Emoji}|\p{Emoji_Presentation}){1,2}$/u
  if (!emoji || !emojiRegex.test(emoji.trim())) {
    return res.status(400).json({ error: 'Invalid emoji' })
  }
  try {
    // Check if this is a NEW reaction (not a change)
    const { rows: existing } = await pool.query(
      `SELECT id FROM note_likes WHERE liker_id=$1 AND target_id=$2`, [req.user.id, targetId]
    )
    const isNew = existing.length === 0

    await pool.query(
      `INSERT INTO note_likes (liker_id, target_id, emoji) VALUES ($1,$2,$3)
       ON CONFLICT (liker_id, target_id) DO UPDATE SET emoji=$3`,
      [req.user.id, targetId, emoji.trim()]
    )
    const { rows:[me] } = await pool.query(
      `SELECT COALESCE(nickname, split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [req.user.id]
    )
    const { notify } = await import('../utils/notify.js')

    // Award 5 seeds to note owner only on first-ever reaction from this liker
    if (isNew) {
      await awardSeeds(targetId, 5, 'note_reaction')
      notify(targetId, 'note_posted', `${emoji} ${me.name} reacted to your note (+5 🌱)`, '', '/feed').catch(() => {})
    } else {
      notify(targetId, 'note_posted', `${emoji} ${me.name} changed their reaction`, '', '/feed').catch(() => {})
    }
    res.json({ ok: true, isNew })
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Server error' }) }
})

// ── DELETE /api/users/:id/like-note — remove reaction ────────────────────────
router.delete('/:id/like-note', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM note_likes WHERE liker_id=$1 AND target_id=$2`, [req.user.id, req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: 'Server error' }) }
})

// ── GET /api/users/my-note-likes — who liked your current note ────────────────
router.get('/my-note-likes', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT nl.liker_id, nl.emoji, nl.created_at,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS liker_name
       FROM note_likes nl JOIN users u ON u.id=nl.liker_id
       WHERE nl.target_id=$1
       ORDER BY nl.created_at DESC`,
      [req.user.id]
    )
    res.json(rows)
  } catch(e) { res.status(500).json({ error: 'Server error' }) }
})

// ── GET /api/users/feed ───────────────────────────────────────────────────────
// FIX: Direct friends (1st degree) can ALWAYS see each other's notes,
// regardless of is_public. is_public only gates visibility to 2nd/3rd degree.
// Also now returns nickname for display, and extends window to 72h so notes
// don't disappear after a night's sleep.
router.get('/feed', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        u.id,
        COALESCE(u.nickname, split_part(u.full_name, ' ', 1)) AS display_name,
        u.city, u.country,
        u.daily_note, u.daily_note_updated_at, u.daily_note_emoji,
        u.daily_mood, u.daily_mood_updated_at
       FROM friendships f
       JOIN users u ON (
         CASE WHEN f.user_id_1 = $1 THEN f.user_id_2 ELSE f.user_id_1 END = u.id
       )
       WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1)
         AND f.status = 'accepted'
         AND u.deleted_at IS NULL
         AND (
           (u.daily_note IS NOT NULL AND u.daily_note != '' AND u.daily_note_updated_at > NOW() - INTERVAL '24 hours')
           OR (u.daily_mood IS NOT NULL AND u.daily_mood_updated_at > NOW() - INTERVAL '24 hours')
         )
       ORDER BY GREATEST(u.daily_note_updated_at, u.daily_mood_updated_at) DESC`,
      [req.user.id]
    );
    // Get reactions for all these users
    const userIds = rows.map(u => u.id)
    let likesMap = {}
    if (userIds.length > 0) {
      const { rows: likes } = await pool.query(
        `SELECT nl.target_id, nl.emoji, nl.liker_id,
                COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS liker_name
         FROM note_likes nl JOIN users u ON u.id=nl.liker_id
         WHERE nl.target_id = ANY($1::uuid[])`,
        [userIds]
      )
      for (const l of likes) {
        if (!likesMap[l.target_id]) likesMap[l.target_id] = []
        likesMap[l.target_id].push({ emoji: l.emoji, likerName: l.liker_name, likerId: l.liker_id })
      }
    }
    // Get my reaction to each
    let myLikes = {}
    if (userIds.length > 0) {
      const { rows: myR } = await pool.query(
        `SELECT target_id, emoji FROM note_likes WHERE liker_id=$1 AND target_id=ANY($2::uuid[])`,
        [req.user.id, userIds]
      )
      for (const r of myR) myLikes[r.target_id] = r.emoji
    }
    res.json(rows.map(u => ({
      id: u.id,
      userId: u.id,
      displayName: u.display_name,
      city: u.city,
      country: u.country,
      note: u.daily_note,
      notePostedAt: u.daily_note_updated_at,
      noteEmoji: u.daily_note_emoji,
      mood: u.daily_mood_updated_at && (Date.now() - new Date(u.daily_mood_updated_at).getTime()) < 86400000 ? u.daily_mood : null,
      // likes (who reacted) is private — only shown to the note owner via /my-note-likes
      // Feed only returns reaction count + myReaction so viewer knows what they sent
      likeCount: (likesMap[u.id] || []).length,
      myReaction: myLikes[u.id] || null,
    })));
  } catch (err) {
    console.error('Feed error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export { getCapitalCoords };
export default router;
