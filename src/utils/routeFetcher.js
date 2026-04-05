// src/utils/routeFetcher.js
// Fetches a simplified road/sea route between two lat/lng points
// Uses OpenRouteService free tier (2000 req/day)
// Falls back to great-circle arc if ORS fails or distance > 800km

const ORS_KEY = process.env.ORS_API_KEY  // add to Render env vars

// Haversine distance in km
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2-lat1)*Math.PI/180
  const dLon = (lon2-lon1)*Math.PI/180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

// Great circle arc — returns N interpolated points
function greatCircleArc(lat1, lon1, lat2, lon2, steps = 20) {
  const pts = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    pts.push([lat1 + (lat2-lat1)*t, lon1 + (lon2-lon1)*t])
  }
  return pts
}

// Simplify a polyline to at most maxPts points (Douglas-Peucker lite)
function simplify(pts, maxPts) {
  if (pts.length <= maxPts) return pts
  const step = Math.ceil(pts.length / maxPts)
  return pts.filter((_, i) => i % step === 0 || i === pts.length-1)
}

export async function getRoute(lat1, lon1, lat2, lon2) {
  const dist = haversine(lat1, lon1, lat2, lon2)

  // Over 800km or no ORS key — use great circle
  if (dist > 800 || !ORS_KEY) {
    return {
      points: greatCircleArc(lat1, lon1, lat2, lon2, 16),
      type: dist > 800 ? 'air' : 'direct',
      distanceKm: Math.round(dist),
    }
  }

  try {
    const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST',
      headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[lon1,lat1],[lon2,lat2]] }),
    })
    if (!res.ok) throw new Error(`ORS ${res.status}`)
    const data = await res.json()
    const coords = data.features?.[0]?.geometry?.coordinates || []
    const pts = simplify(coords.map(([lon,lat]) => [lat,lon]), 24)
    return { points: pts, type: 'road', distanceKm: Math.round(dist) }
  } catch {
    // Fallback
    return {
      points: greatCircleArc(lat1, lon1, lat2, lon2, 16),
      type: 'fallback',
      distanceKm: Math.round(dist),
    }
  }
}
