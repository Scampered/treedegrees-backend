// src/utils/letters.js

export const VEHICLE_TIERS = {
  car:       { minStreak: 0,   maxHours: 20,  emoji: '🚗',  label: 'Car'        },
  sportscar: { minStreak: 16,  maxHours: 10,  emoji: '🏎️',  label: 'Sports Car' },
  airliner:  { minStreak: 32,  maxHours: 5,   emoji: '✈️',  label: 'Airliner'   },
  jet:       { minStreak: 64,  maxHours: 2.5, emoji: '🛩️',  label: 'Jet'        },
  spaceship: { minStreak: 128, maxHours: 1,   emoji: '🚀',  label: 'Spaceship'  },
  radio:     { minStreak: 256, maxHours: 0,   emoji: '📡',  label: 'Radio'      },
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

// ── Haversine ─────────────────────────────────────────────────────────────────
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
  return Math.max(30000, ratio * maxHours * 3600 * 1000)
}

// ── Streak — uses SENDER'S local date (passed in from client) ─────────────────
//
// Rules:
// - A "day" is defined by the SENDER's local midnight (client sends their date string)
// - Both users must send at least one letter each on the same local day to grow streak
// - Sending a letter adds +1 fuel (max 3)
// - Each elapsed day costs 1 fuel
// - If fuel hits 0, streak resets
// - If 1 fuel left, show ⌛ warning on frontend
//
// The record stores:
//   sender_local_date_1 — the date string (YYYY-MM-DD) in user1's local time when they last sent
//   sender_local_date_2 — same for user2
//   current_period     — the "day key" of the current active period (first sender's date that day)
//
// For simplicity we store the local date of the FIRST sender each day in current_period.
// When user2 sends on the same local date as user1's current_period, both-sent = true.

export function calculateEffectiveStreak(record, todayStr) {
  // todayStr: caller passes the CURRENT date in local time (YYYY-MM-DD).
  // Falls back to server UTC date if not provided.
  const today = todayStr || new Date().toISOString().split('T')[0]

  if (!record) {
    return {
      streak_days: 0, fuel: 0,
      user1_sent_today: false, user2_sent_today: false,
      last_day_processed: today,
    }
  }

  const lastProcessed = record.last_day_processed instanceof Date
    ? record.last_day_processed.toISOString().split('T')[0]
    : String(record.last_day_processed || today)

  if (lastProcessed === today) return record

  let { streak_days, fuel, user1_sent_today, user2_sent_today } = record
  streak_days = streak_days || 0
  fuel        = fuel        || 0

  const daysDiff = Math.max(0, Math.floor(
    (new Date(today) - new Date(lastProcessed)) / 86400000
  ))

  for (let i = 0; i < daysDiff; i++) {
    if (i === 0) {
      // Resolve the last active day
      if (user1_sent_today && user2_sent_today) {
        // Both sent — increment streak AND earn 1 fuel (Snapchat-style)
        streak_days += 1
        fuel = Math.min(3, fuel + 1)
      } else {
        // At least one didn't send — spend 1 fuel (streak save)
        if (fuel > 0) {
          fuel -= 1
          // streak_days is preserved — the save was used
        } else {
          // No fuel left — streak breaks
          streak_days = 0
        }
      }
    } else {
      // Additional missed days beyond the first
      if (fuel > 0) {
        fuel -= 1
      } else {
        streak_days = 0
      }
    }
    user1_sent_today = false
    user2_sent_today = false
  }

  return {
    ...record,
    streak_days, fuel,
    user1_sent_today, user2_sent_today,
    last_day_processed: today,
    _dirty: true,
  }
}

export function formatDuration(ms) {
  if (ms <= 0) return 'Instant'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  if (m > 0) return `${m}m`
  return 'Less than a minute'
}
