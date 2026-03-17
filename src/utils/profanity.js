// src/utils/profanity.js
// Basic profanity filter for names, nicknames, and bios.
// Uses a blocked-word list approach with normalisation to catch leetspeak variations.

// Core blocked words — extend this list as needed
const BLOCKED = [
  'fuck','shit','bitch','asshole','ass','cunt','dick','cock','pussy','faggot','fag',
  'nigger','nigga','kike','spic','chink','slut','whore','bastard','damn','hell',
  'piss','crap','twat','wank','jerk','idiot','moron','retard','rape','porn',
  'sex','nude','naked','nsfw','xxx','penis','vagina','boob','tit','anus',
  // Arabic equivalents (common ones)
  'كس','خرا','شرموط','عاهرة','منيوك','زب','طيز','لعنة',
]

// Normalise to catch simple leetspeak: a=@=4, e=3, i=1=!, o=0, s=$=5
function normalise(str) {
  return str
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/[^a-zء-ي\s]/g, '') // strip remaining non-alpha
    .trim()
}

export function containsProfanity(text) {
  if (!text) return false
  const normalised = normalise(text)
  // Check each blocked word as a substring
  return BLOCKED.some(word => normalised.includes(word))
}

export function profanityError(field = 'This field') {
  return `${field} contains inappropriate language. Please choose something else.`
}
