// src/utils/marketEvents.js
// Called by other routes to move market prices based on activity.
// All functions fire-and-forget (never block the calling request).
import { updateMarketPrice, applyCrudeEconomyEffect } from '../routes/market.js';
import pool from '../db/pool.js';

// Letter sent → crude rises (fuel consumed), canopy rises (activity signal)
export function onLetterSent(distanceKm) {
  const fuelUsed = Math.max(1, Math.round(distanceKm / 5000)); // 1-4 pts crude per letter
  updateMarketPrice('crude',  +fuelUsed,  null).catch(() => {});
  updateMarketPrice('canopy', +2,          null).catch(() => {});
  applyCrudeEconomyEffect(null).catch(() => {});
}

// Letter arrived → canopy rises (successful connection = healthy economy)
export function onLetterArrived() {
  updateMarketPrice('canopy', +1, null).catch(() => {});
}

// Streak broken → canopy dips (disengagement signal)
export function onStreakBroken() {
  updateMarketPrice('canopy', -3, null).catch(() => {});
}

// Streak milestone (both sent) → canopy rises
export function onStreakMilestone() {
  updateMarketPrice('canopy', +2, null).catch(() => {});
}

// Daily note posted → canopy rises slightly
export function onNotePosted() {
  updateMarketPrice('canopy', +1, null).catch(() => {});
}

// Grove investment → canopy rises (confidence)
export function onGroveInvestment(amount) {
  const bump = Math.max(1, Math.floor(amount * 0.05)); // 5%: 20→1pt, 100→5pt, 500→25pt
  updateMarketPrice('canopy', +bump, null).catch(() => {});
}

// Grove withdrawal → canopy dips slightly
export function onGroveWithdrawal(amount) {
  const drag = Math.max(1, Math.floor(amount * 0.02)); // 2%: 20→0pt, 100→2pt, 500→10pt
  updateMarketPrice('canopy', -drag, null).catch(() => {});
}

// Weekend bonus — called by a daily cron or first request of weekend day
export async function applyWeekendBonus() {
  const day = new Date().getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) {
    await updateMarketPrice('canopy', +10, null).catch(() => {});
    console.log('[Market] Weekend bonus applied to canopy');
  }
}

// Daily decay — canopy slowly drifts toward 1000 baseline if no activity
// Crude slowly returns to 50 baseline (supply/demand equilibrium)
export async function applyDailyDecay() {
  const { rows } = await pool.query(`SELECT market, price FROM market_state`);
  for (const r of rows) {
    const price    = parseFloat(r.price);
    const baseline = r.market === 'canopy' ? 1000 : 50;
    const diff     = baseline - price;
    // Drift 2% toward baseline each day
    const drift    = Math.round(diff * 0.02);
    if (Math.abs(drift) >= 1) {
      await updateMarketPrice(r.market, drift, null).catch(() => {});
    }
  }
}
