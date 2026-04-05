// src/routes/moments.js — Cloudflare R2 photo moments
import { Router } from 'express';
import { getRoute } from '../utils/routeFetcher.js';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { notify } from '../utils/notify.js';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const router = Router();

// R2 client — configured via env vars
function getR2() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// POST /api/moments — upload a moment
// Body: { imageBase64, mimeType, caption, emoji, tagIds: [], letterId? }
router.post('/', requireAuth, async (req, res) => {
  const { imageBase64, mimeType, caption, emoji, tagIds = [], letterId } = req.body;
  if (!imageBase64 || !mimeType) return res.status(400).json({ error: 'Image required' });
  if (!['image/jpeg','image/png','image/webp'].includes(mimeType))
    return res.status(400).json({ error: 'Only JPEG, PNG, WebP allowed' });

  // 1 post per calendar day (server timezone = UTC)
  const { rows:[todayCheck] } = await pool.query(
    `SELECT id FROM moments WHERE uploader_id=$1 AND created_at::date=CURRENT_DATE LIMIT 1`,
    [req.user.id]
  )
  if (todayCheck) return res.status(429).json({ error: 'You have already posted a memory today. Come back tomorrow!' })

  // Decode base64
  const buffer = Buffer.from(imageBase64, 'base64');
  if (buffer.length > 5 * 1024 * 1024) // 5MB max (already compressed client-side)
    return res.status(400).json({ error: 'Image too large (max 5MB)' });

  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const r2Key = `moments/${req.user.id}/${Date.now()}.${ext}`;

  try {
    // Upload to R2
    const r2 = getR2();
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: buffer,
      ContentType: mimeType,
      CacheControl: 'public, max-age=604800', // 7 days cache
    }));

    const cdnUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;

    // Insert moment
    const { rows:[moment] } = await pool.query(
      `INSERT INTO moments (uploader_id, r2_key, cdn_url, caption, note_emoji)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, cdn_url, expires_at`,
      [req.user.id, r2Key, cdnUrl, (caption||'').slice(0,200), emoji||null]
    );

    // Award 50 seeds — we already confirmed above this is first post today
    await pool.query(`UPDATE users SET seeds=COALESCE(seeds,0)+50 WHERE id=$1`, [req.user.id])
    notify(req.user.id, 'seeds_earned', '\u{1F331} +50 seeds', 'Seeds for posting a memory today!', '/grove').catch(()=>{})

    // Tag connections
    const validTagIds = [];
    for (const tagId of tagIds.slice(0,5)) {
      // Verify they are a connection
      const [u1,u2] = [req.user.id, tagId].sort();
      const { rows:[f] } = await pool.query(
        `SELECT id FROM friendships WHERE user_id_1=$1 AND user_id_2=$2 AND status='accepted'`, [u1,u2]
      );
      if (f) {
        await pool.query(`INSERT INTO moment_tags(moment_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [moment.id, tagId]);
        validTagIds.push(tagId);
        // Notify tagged connection
        const { rows:[me] } = await pool.query(
          `SELECT COALESCE(nickname,split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [req.user.id]
        );
        notify(tagId, 'note_posted', `📸 ${me.name} tagged you in a moment`,
          caption||'', '/memories').catch(()=>{});
      }
    }

    // Link to letter if provided
    if (letterId) {
      await pool.query(
        `INSERT INTO letter_moments(letter_id,moment_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [letterId, moment.id]
      );
    }

    res.status(201).json({
      id: moment.id,
      cdnUrl: moment.cdn_url,
      expiresAt: moment.expires_at,
      taggedCount: validTagIds.length,
    });
  } catch(e) {
    console.error('[moments upload]', e.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /api/moments/mine — my uploaded moments
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.cdn_url, m.caption, m.note_emoji, m.expires_at, m.created_at,
              ARRAY_AGG(DISTINCT COALESCE(ut.nickname,split_part(ut.full_name,' ',1)))
                FILTER(WHERE ut.id IS NOT NULL) AS tagged_names,
              (SELECT COUNT(*)::int FROM moment_likes WHERE moment_id=m.id) AS like_count,
              (SELECT COUNT(*)::int FROM moment_comments WHERE moment_id=m.id) AS comment_count,
              (SELECT JSON_AGG(JSON_BUILD_OBJECT('name', COALESCE(ul.nickname,split_part(ul.full_name,' ',1))))
               FROM moment_likes ml JOIN users ul ON ul.id=ml.user_id
               WHERE ml.moment_id=m.id) AS liked_by
       FROM moments m
       LEFT JOIN moment_tags mt ON mt.moment_id=m.id
       LEFT JOIN users ut ON ut.id=mt.user_id
       WHERE m.uploader_id=$1 AND m.expires_at > NOW()
       GROUP BY m.id ORDER BY m.created_at DESC`,
      [req.user.id]
    )
    res.json(rows)
  } catch(e) { res.status(500).json({ error:'Server error' }) }
})

// GET /api/moments/tagged — moments I'm tagged in
router.get('/tagged', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.cdn_url, m.caption, m.note_emoji, m.expires_at, m.created_at,
              COALESCE(u.nickname,split_part(u.full_name,' ',1)) AS uploader_name,
              m.uploader_id
       FROM moment_tags mt
       JOIN moments m ON m.id=mt.moment_id
       JOIN users u ON u.id=m.uploader_id
       WHERE mt.user_id=$1 AND m.expires_at > NOW()
       ORDER BY m.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

// DELETE /api/moments/:id — delete a moment (uploader only)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows:[m] } = await pool.query(
      `SELECT r2_key, created_at FROM moments WHERE id=$1 AND uploader_id=$2`,
      [req.params.id, req.user.id]
    )
    if (!m) return res.status(404).json({ error:'Not found' })
    // Delete from R2
    try {
      const r2 = getR2()
      await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: m.r2_key }))
    } catch(e) { console.warn('[moments] R2 delete failed:', e.message) }
    await pool.query(`DELETE FROM moments WHERE id=$1`, [req.params.id])
    // Deduct 50 seeds if this was posted today and no other post today exists
    const createdToday = new Date(m.created_at).toDateString() === new Date().toDateString()
    if (createdToday) {
      const { rows:[otherToday] } = await pool.query(
        `SELECT id FROM moments WHERE uploader_id=$1 AND created_at::date=CURRENT_DATE LIMIT 1`,
        [req.user.id]
      )
      if (!otherToday) {
        await pool.query(`UPDATE users SET seeds=GREATEST(0,COALESCE(seeds,0)-50) WHERE id=$1`, [req.user.id])
      }
    }
    res.json({ ok:true })
  } catch(e) { res.status(500).json({ error:'Server error' }) }
})


// POST /api/moments/:id/like
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const { rows:[m] } = await pool.query(
      `SELECT uploader_id FROM moments WHERE id=$1 AND expires_at>NOW()`, [req.params.id]
    )
    if (!m) return res.status(404).json({ error:'Not found' })
    await pool.query(
      `INSERT INTO moment_likes(moment_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id]
    )
    const { rows:[{count}] } = await pool.query(
      `SELECT COUNT(*) FROM moment_likes WHERE moment_id=$1`, [req.params.id]
    )
    // Notify uploader
    if (m.uploader_id !== req.user.id) {
      const { rows:[liker] } = await pool.query(
        `SELECT COALESCE(nickname,split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [req.user.id]
      )
      notify(m.uploader_id, 'note_posted', `❤️ ${liker?.name} liked your memory`, '', '/my-world').catch(()=>{})
    }
    res.json({ ok:true, likeCount: parseInt(count, 10) })
  } catch(e) { res.status(500).json({ error:'Server error' }) }
})

// GET /api/moments/:id/comments
// Visibility rules:
// - Uploader sees ALL comments
// - Commenter sees their OWN comment + comments from their connections
// - Others see only comments from their mutual connections
router.get('/:id/comments', requireAuth, async (req, res) => {
  try {
    const { rows:[moment] } = await pool.query(
      `SELECT uploader_id FROM moments WHERE id=$1`, [req.params.id]
    )
    if (!moment) return res.status(404).json({ error:'Not found' })

    const isUploader = moment.uploader_id === req.user.id

    // Get viewer's connection IDs
    const { rows: myConns } = await pool.query(
      `SELECT CASE WHEN user_id_1=$1 THEN user_id_2 ELSE user_id_1 END AS friend_id
       FROM friendships WHERE (user_id_1=$1 OR user_id_2=$1) AND status='accepted'`,
      [req.user.id]
    )
    const myConnIds = new Set(myConns.map(r => r.friend_id))
    myConnIds.add(req.user.id) // always include self

    const { rows } = await pool.query(
      `SELECT mc.id, mc.text, mc.created_at,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS author_name,
              u.id AS user_id
       FROM moment_comments mc JOIN users u ON u.id=mc.user_id
       WHERE mc.moment_id=$1 ORDER BY mc.created_at ASC`,
      [req.params.id]
    )

    // Filter: uploader sees all; others see own + comments from their connections
    const visible = isUploader
      ? rows
      : rows.filter(r => myConnIds.has(r.user_id))

    res.json(visible.map(r => ({ id:r.id, text:r.text, authorName:r.author_name, userId:r.user_id, createdAt:r.created_at })))
  } catch(e) { res.status(500).json({ error:'Server error' }) }
})

// POST /api/moments/:id/comment — 1 per person (delete first to recomment)
router.post('/:id/comment', requireAuth, async (req, res) => {
  const { text } = req.body
  if (!text?.trim() || text.length > 120) return res.status(400).json({ error:'Max 120 chars' })
  try {
    const { rows:[m] } = await pool.query(
      `SELECT uploader_id FROM moments WHERE id=$1 AND expires_at>NOW()`, [req.params.id]
    )
    if (!m) return res.status(404).json({ error:'Not found' })
    // Check if user already commented
    const { rows:[existing] } = await pool.query(
      `SELECT id FROM moment_comments WHERE moment_id=$1 AND user_id=$2`, [req.params.id, req.user.id]
    )
    if (existing) return res.status(409).json({ error:'Already commented. Delete your comment first to post a new one.' })
    const { rows:[comment] } = await pool.query(
      `INSERT INTO moment_comments(moment_id,user_id,text) VALUES($1,$2,$3) RETURNING id,text,created_at`,
      [req.params.id, req.user.id, text.trim()]
    )
    const { rows:[u] } = await pool.query(
      `SELECT COALESCE(nickname,split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [req.user.id]
    )
    // Notify uploader + award seeds for comment
    if (m.uploader_id !== req.user.id) {
      await pool.query(`UPDATE users SET seeds=COALESCE(seeds,0)+10 WHERE id=$1`, [m.uploader_id])
      notify(m.uploader_id, 'note_posted', `📝 ${u.name} left a note on your memory`,
        `+10 🌱 · "${text.trim().slice(0,40)}"`, '/my-world').catch(()=>{})
    }
    res.status(201).json({ id:comment.id, text:comment.text, authorName:u.name, userId:req.user.id, createdAt:comment.created_at })
  } catch(e) { res.status(500).json({ error:'Server error' }) }
})

// DELETE /api/moments/:id/comment — delete own comment
router.delete('/:id/comment', requireAuth, async (req, res) => {
  try {
    const { rows:[c] } = await pool.query(
      `DELETE FROM moment_comments WHERE moment_id=$1 AND user_id=$2 RETURNING id`, [req.params.id, req.user.id]
    )
    if (!c) return res.status(404).json({ error:'No comment to delete' })
    res.json({ ok:true })
  } catch(e) { res.status(500).json({ error:'Server error' }) }
})

// GET /api/moments/route — get route between two points for watermark
router.get('/route', requireAuth, async (req, res) => {
  const { lat1, lon1, lat2, lon2 } = req.query
  if (!lat1||!lon1||!lat2||!lon2) return res.status(400).json({ error:'Need lat1,lon1,lat2,lon2' })
  try {
    const route = await getRoute(parseFloat(lat1), parseFloat(lon1), parseFloat(lat2), parseFloat(lon2))
    res.json(route)
  } catch(e) { res.status(500).json({ error:'Route failed' }) }
})


// GET /api/moments/connections — all connections' recent moments (for feed)
router.get('/connections', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.cdn_url, m.caption, m.note_emoji, m.expires_at, m.created_at,
              m.uploader_id,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS uploader_name,
              (SELECT COUNT(*) FROM moment_likes WHERE moment_id=m.id)::int AS like_count,
              (SELECT COUNT(*) FROM moment_comments WHERE moment_id=m.id)::int AS comment_count,
              EXISTS(SELECT 1 FROM moment_tags mt WHERE mt.moment_id=m.id AND mt.user_id=$1) AS is_tagged,
              EXISTS(SELECT 1 FROM moment_likes ml WHERE ml.moment_id=m.id AND ml.user_id=$1) AS has_liked
       FROM moments m
       JOIN users u ON u.id=m.uploader_id
       WHERE m.expires_at > NOW()
         AND m.uploader_id IN (
           SELECT CASE WHEN user_id_1=$1 THEN user_id_2 ELSE user_id_1 END
           FROM friendships WHERE (user_id_1=$1 OR user_id_2=$1) AND status='accepted'
         )
       ORDER BY m.created_at DESC
       LIMIT 40`,
      [req.user.id]
    )
    res.json(rows)
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Server error' }) }
})

// GET /api/moments/by/:userId — get a specific user's public moments (must be connection)
router.get('/by/:userId', requireAuth, async (req, res) => {
  const targetId = req.params.userId
  try {
    // Must be a direct connection
    const [u1,u2] = [req.user.id, targetId].sort()
    const { rows:[f] } = await pool.query(
      `SELECT id FROM friendships WHERE user_id_1=$1 AND user_id_2=$2 AND status='accepted'`,
      [u1,u2]
    )
    if (!f && targetId !== req.user.id)
      return res.status(403).json({ error:'Only connections can view posts' })

    const { rows } = await pool.query(
      `SELECT m.id, m.cdn_url, m.caption, m.note_emoji, m.expires_at, m.created_at,
              m.uploader_id,
              (SELECT COUNT(*) FROM moment_likes WHERE moment_id=m.id)::int AS like_count,
              (SELECT COUNT(*) FROM moment_comments WHERE moment_id=m.id)::int AS comment_count,
              EXISTS(SELECT 1 FROM moment_tags mt WHERE mt.moment_id=m.id AND mt.user_id=$2) AS is_tagged,
              EXISTS(SELECT 1 FROM moment_likes ml WHERE ml.moment_id=m.id AND ml.user_id=$2) AS has_liked
       FROM moments m
       WHERE m.uploader_id=$1 AND m.expires_at > NOW()
       ORDER BY m.created_at DESC
       LIMIT 6`,
      [targetId, req.user.id]
    )
    res.json(rows)
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Server error' }) }
})

export default router;
