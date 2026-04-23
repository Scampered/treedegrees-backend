// src/utils/letters.js — vehicle tiers, delivery time, streak calculation

// ── Vehicle tiers ─────────────────────────────────────────────────────────────
export const VEHICLE_TIERS = {
  car:       { minStreak: 0,   maxHours: 20,  emoji: '🚗',  label: 'Car'           },
  sportscar: { minStreak: 16,  maxHours: 10,  emoji: '🏎️',  label: 'Sports Car'    },
  airliner:  { minStreak: 32,  maxHours: 5,   emoji: '✈️',  label: 'Airliner'      },
  jet:       { minStreak: 64,  maxHours: 2.5, emoji: '🛩️',  label: 'Jet'           },
  spaceship: { minStreak: 128, maxHours: 1,   emoji: '🚀',  label: 'Spaceship'     },
  radio:     { minStreak: 256, maxHours: 0,   emoji: '📡',  label: 'Radio'         },
}

export function getVehicleTier(streakDays) {
  if (streakDays >= 256) return 'radio'
  if (streakDays >= 128) return 'spaceship'
  if (streakDays >= 64)  return 'jet'
  if (streakDays >= 32)  return 'airliner'
  if (streakDays >= 16)  return 'sportscar'
  return 'car'
}

export function nextVehicleMilestone(streakDays) {
  const milestones = [16, 32, 64, 128, 256]
  return milestones.find(m => m > streakDays) || null
}

// ── Haversine distance ────────────────────────────────────────────────────────
const MAX_EARTH_KM = 20037

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

export function calcDeliveryMs(distKm, vehicleTier) {
  if (vehicleTier === 'radio') return 0
  const { maxHours } = VEHICLE_TIERS[vehicleTier]
  const ratio = Math.min(distKm / MAX_EARTH_KM, 1)
  // Minimum 30 seconds so very close users still get an animation
  return Math.max(30000, ratio * maxHours * 3600 * 1000)
}

// ── Streak lazy calculation ───────────────────────────────────────────────────
// No cron needed — we calculate missed days when the streak is fetched.
export function calculateEffectiveStreak(record) {
  if (!record) {
    return { streak_days: 0, fuel: 3, user1_sent_today: false, user2_sent_today: false, broken_at: null, broken_streak_days: 0 }
  }

  const today = new Date().toISOString().split('T')[0]
  const lastProcessed = record.last_day_processed instanceof Date
    ? record.last_day_processed.toISOString().split('T')[0]
    : String(record.last_day_processed || today)

  if (lastProcessed === today) return record // already up to date for today

  let { streak_days, fuel, user1_sent_today, user2_sent_today, broken_at, broken_streak_days } = record

  const daysDiff = Math.max(0, Math.floor(
    (new Date(today) - new Date(lastProcessed)) / 86400000
  ))

  for (let i = 0; i < daysDiff; i++) {
    if (i === 0) {
      // Yesterday — did both send?
      if (user1_sent_today && user2_sent_today) {
        streak_days += 1
        broken_at = null // healed if both sent
        broken_streak_days = 0
      } else if (streak_days > 0 && !broken_at) {
        // Streak just broke — record the break
        broken_at = new Date().toISOString()
        broken_streak_days = streak_days
        streak_days = 0
      }
    } else if (streak_days > 0) {
      // Multi-day gap — streak breaks immediately
      if (!broken_at) {
        broken_at = new Date().toISOString()
        broken_streak_days = streak_days
      }
      streak_days = 0
    }
    user1_sent_today = false
    user2_sent_today = false
  }

  // If broken_at is older than 3 days, clear the broken state
  if (broken_at) {
    const daysSinceBroken = (Date.now() - new Date(broken_at).getTime()) / 86400000
    if (daysSinceBroken >= 3) {
      broken_at = null
      broken_streak_days = 0
    }
  }

  return {
    ...record,
    streak_days,
    fuel, // fuel is now streak_savers, managed separately on users table
    user1_sent_today,
    user2_sent_today,
    broken_at,
    broken_streak_days,
    last_day_processed: today,
    _dirty: true,
  }
}

// ── Time formatting ───────────────────────────────────────────────────────────
export function formatDuration(ms) {
  if (ms <= 0) return 'Instant'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  if (m > 0) return `${m}m`
  return 'Less than a minute'
}
