// src/utils/letters.js — vehicle tiers, delivery time, streak calculation

// ── Vehicle tiers ─────────────────────────────────────────────────────────────
export const VEHICLE_TIERS = {
  car:       { emoji: '🚗',  maxHours: 72,  minHours: 24 },
  sportscar: { emoji: '🏎️',  maxHours: 48,  minHours: 12 },
  airliner:  { emoji: '🛩️',  maxHours: 24,  minHours: 6  },
  jet:       { emoji: '✈️',  maxHours: 12,  minHours: 3  },
  spaceship: { emoji: '🚀',  maxHours: 4,   minHours: 1  },
  radio:     { emoji: '🗼',  maxHours: 0,   minHours: 0  },
}

export function getVehicleTier(streakDays) {
  if (streakDays >= 365) return 'spaceship'
  if (streakDays >= 100) return 'jet'
  if (streakDays >= 30)  return 'airliner'
  if (streakDays >= 7)   return 'sportscar'
  return 'car'
}

export function calcDeliveryMs(distKm, vehicleTier) {
  if (vehicleTier === 'radio') return 0
  const { maxHours, minHours } = VEHICLE_TIERS[vehicleTier]
  const maxDistKm = 20000
  const t = Math.min(distKm / maxDistKm, 1)
  const hours = minHours + (maxHours - minHours) * t
  return Math.round(hours * 3600 * 1000)
}

export function formatDuration(ms) {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// ── Streak calculation (TikTok-style savers) ───────────────────────────────────
//
// Rules:
// - Both users must send a letter within the same calendar day to keep streak
// - If a day is missed: streak breaks the NEXT day (1 grace day)
//   → i.e. after 2 consecutive days of no letters, streak breaks
// - After breaking: user has 2 days to tap "restore" using a streak saver
// - Each friendship starts with 3 streak savers (stored on letter_streaks)
// - Streak savers are per-friendship, not global
// - No fuel system — savers are the only protection
//
export function calculateEffectiveStreak(record) {
  if (!record) {
    return {
      streak_days: 0,
      streak_savers: 3,
      user1_sent_today: false,
      user2_sent_today: false,
      broken_at: null,
      broken_streak_days: 0,
      _dirty: false,
    }
  }

  const todayStr = new Date().toISOString().split('T')[0]
  const lastStr  = record.last_day_processed instanceof Date
    ? record.last_day_processed.toISOString().split('T')[0]
    : String(record.last_day_processed || todayStr)

  // Already processed today — return as-is
  if (lastStr === todayStr) return record

  let {
    streak_days        = 0,
    streak_savers      = 3,
    user1_sent_today   = false,
    user2_sent_today   = false,
    broken_at          = null,
    broken_streak_days = 0,
  } = record

  const daysDiff = Math.max(0, Math.floor(
    (new Date(todayStr) - new Date(lastStr)) / 86400000
  ))

  for (let i = 0; i < daysDiff; i++) {
    const bothSent = user1_sent_today && user2_sent_today

    if (i === 0) {
      // Processing yesterday
      if (bothSent) {
        // Both sent — streak grows, clear any broken state
        streak_days += 1
        broken_at          = null
        broken_streak_days = 0
      } else if (streak_days > 0 && !broken_at) {
        // Nobody sent — 1 grace day passes, mark as broken
        // (streak breaks after the SECOND missed day, so we mark broken_at now
        //  but keep streak_days intact for 1 more day so UI can show "at risk")
        broken_at          = new Date().toISOString()
        broken_streak_days = streak_days
        streak_days        = 0
      }
    } else {
      // Multi-day gap — each extra day without letters
      if (!broken_at && streak_days > 0) {
        broken_at          = new Date().toISOString()
        broken_streak_days = streak_days
        streak_days        = 0
      }
    }

    // Reset daily send flags
    user1_sent_today = false
    user2_sent_today = false
  }

  // Clear broken state after 2-day recovery window expires
  if (broken_at) {
    const daysSinceBroken = (Date.now() - new Date(broken_at).getTime()) / 86400000
    if (daysSinceBroken >= 2) {
      broken_at          = null
      broken_streak_days = 0
    }
  }

  return {
    ...record,
    streak_days,
    streak_savers,
    user1_sent_today,
    user2_sent_today,
    broken_at,
    broken_streak_days,
    last_day_processed: todayStr,
    _dirty: true,
  }
}

// ── Haversine distance ────────────────────────────────────────────────────────
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

// ── Next vehicle milestone ────────────────────────────────────────────────────
export function nextVehicleMilestone(streakDays) {
  const milestones = [7, 30, 100, 365]
  return milestones.find(m => m > streakDays) ?? null
}
