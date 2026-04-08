// migrate_v34: backfill seeds_log from existing activity + clear expired note moments
import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
async function run() {
  const c = await pool.connect();
  try {
    // Backfill letters sent
    await c.query(`
      INSERT INTO seeds_log (user_id, amount, reason, label, created_at)
      SELECT sender_id, 5, 'send_letter', '✉️ Sent a letter', sent_at
      FROM letters
      WHERE sent_at IS NOT NULL
      ON CONFLICT DO NOTHING
    `).catch(e => console.log('letters sent backfill:', e.message))

    // Backfill letters received (on arrival)
    await c.query(`
      INSERT INTO seeds_log (user_id, amount, reason, label, created_at)
      SELECT recipient_id, 5, 'receive_letter', '📬 Received a letter', arrives_at
      FROM letters
      WHERE arrives_at <= NOW()
      ON CONFLICT DO NOTHING
    `).catch(e => console.log('letters received backfill:', e.message))

    // Backfill memories posted
    await c.query(`
      INSERT INTO seeds_log (user_id, amount, reason, label, created_at)
      SELECT uploader_id, 50, 'post_memory', '📸 Posted a memory', created_at
      FROM moments
      ON CONFLICT DO NOTHING
    `).catch(e => console.log('moments backfill:', e.message))

    // Add unique constraint to prevent duplicates if backfill runs again
    // (seeds_log doesn't have one by default - add a soft dedup index)
    await c.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_seeds_log_dedup
      ON seeds_log (user_id, reason, created_at)
    `).catch(() => {}) // ignore if exists

    // Clear expired note moment attachments
    await c.query(`
      UPDATE users
      SET note_moment_id = NULL, note_moment_cdn_url = NULL
      WHERE note_moment_id IS NOT NULL
        AND note_moment_id NOT IN (SELECT id FROM moments WHERE expires_at > NOW())
    `).catch(e => console.log('note moment clear:', e.message))

    console.log('v34: seeds_log backfill + expired note moments cleared')
  } catch(e) { console.error(e.message); }
  finally { c.release(); await pool.end(); }
}
run();
