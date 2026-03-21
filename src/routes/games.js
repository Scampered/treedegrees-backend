// src/routes/games.js — Trump Card (full logic fixes)
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// 90-card deck, 8 starting cards, max 10
const STARTING_HAND = 8;
const MAX_HAND      = 10;
const MAX_HEARTS    = 8; // hearts = starting hand size

const CARD_DEFS = [
  { id:'soldier',        name:'Soldier',          type:'unit',    sub:'basic',   atk:2,def:2,count:12 },
  { id:'armored_soldier',name:'Armored Soldier',   type:'unit',    sub:'basic',   atk:3,def:3,count:9  },
  { id:'drone',          name:'Drone',             type:'unit',    sub:'basic',   atk:3,def:2,count:11 },
  { id:'tank',           name:'Tank',              type:'unit',    sub:'basic',   atk:4,def:4,count:8  },
  { id:'jet',            name:'Jet',               type:'unit',    sub:'basic',   atk:4,def:3,count:7  },
  { id:'missile',        name:'Missile',           type:'unit',    sub:'basic',   atk:5,def:1,count:6  },
  { id:'artillery',      name:'Artillery',         type:'unit',    sub:'tactical',atk:3,def:4,count:8  },
  { id:'interceptor',    name:'Interceptor',       type:'unit',    sub:'tactical',atk:2,def:4,count:8  },
  { id:'divert_attack',  name:'Divert Attack',     type:'special', sub:'amber',   atk:0,def:0,count:6  },
  { id:'call_reinforce', name:'Reinforcements',    type:'special', sub:'amber',   atk:0,def:0,count:7  },
  { id:'spy_operation',  name:'Spy Operation',     type:'special', sub:'purple',  atk:0,def:0,count:6  },
  { id:'block_comms',    name:'Block Comms',       type:'special', sub:'purple',  atk:0,def:0,count:4  },
  // Total: 12+9+11+8+7+6+8+8+6+7+6+4 = 92 cards
];

function buildDeck() {
  const cards = [];
  let uid = 0;
  for (const def of CARD_DEFS)
    for (let i = 0; i < def.count; i++)
      cards.push({ uid:`c${uid++}`, ...def });
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

// ── Damaged card: halve atk/def, min 1 ───────────────────────────────────────
function damageCard(card) {
  if (card.damaged) {
    // Already damaged — destroy it (no more uses)
    return null;
  }
  return {
    ...card,
    atk: Math.max(1, Math.floor((card.atk || 1) / 2)),
    def: Math.max(1, Math.floor((card.def || 1) / 2)),
    damaged: true,
    originalAtk: card.atk,
    originalDef: card.def,
  };
}

function addLog(state, text) {
  if (!state.log) state.log = [];
  state.log.unshift({ text, ts: Date.now() });
  if (state.log.length > 60) state.log.length = 60;
}

// Push a notification to a specific player (they see it as a popup)
function notify(state, playerIdx, text) {
  if (!state.notifications) state.notifications = {};
  if (!state.notifications[playerIdx]) state.notifications[playerIdx] = [];
  state.notifications[playerIdx].unshift({ text, ts: Date.now() });
  if (state.notifications[playerIdx].length > 5) state.notifications[playerIdx].length = 5;
}

function nextAliveIndex(state, from) {
  let idx = (from + 1) % state.players.length;
  for (let i = 0; i < state.players.length; i++) {
    if (!state.players[idx].eliminated) return idx;
    idx = (idx + 1) % state.players.length;
  }
  return from;
}

function checkWin(state) {
  const alive = state.players.filter(p => !p.eliminated);
  if (alive.length === 1) {
    state.status = 'ended';
    state.winner = alive[0].userId;
    state.winnerName = alive[0].name;
    state.turnPhase = 'ended';
    addLog(state, `🏆 ${alive[0].name} wins Trump Card!`);
    return true;
  }
  return false;
}

function giveCard(state, playerIndex, count = 1) {
  const p = state.players[playerIndex];
  if (!p || p.eliminated) return 0;
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    if (state.deck.length === 0 || p.hand.length >= MAX_HAND) break;
    p.hand.push(state.deck.pop());
    drawn++;
  }
  return drawn;
}

function calcPoints(state, winnerId) {
  const opponents = state.players.filter(p => p.userId !== winnerId).length;
  return 100 + (opponents * 30);
}

// ── Resolve combat with damage/destroyed card mechanic ────────────────────────
// Returns { defCardsBack, discardedCount, logLines }
function resolveCombat(state, attackTotal, defCards, defender, defMyIdx) {
  const defTotal = defCards.reduce((s, c) => s + (c.def || 0), 0);
  const logs = [];

  if (defTotal >= attackTotal) {
    // ── Defense holds — cards survive but get damaged ──
    const returned = [];
    for (const card of defCards) {
      const dmg = damageCard(card);
      if (dmg) {
        returned.push(dmg);
        logs.push(`🛡️ ${card.name} survived damaged (${dmg.atk}/${dmg.def})`);
      } else {
        logs.push(`💔 ${card.name} was destroyed by overuse`);
      }
    }
    // Return surviving cards to defender's hand
    for (const c of returned) defender.hand.push(c);
    logs.unshift(`🛡️ ${defender.name} holds! DEF ${defTotal} ≥ ATK ${attackTotal}.`);
    return { damage: 0, defCardsBack: returned.length };
  } else {
    // ── Attack hits — defense cards lost, hand loses excess damage ──
    const damage = attackTotal - defTotal;
    const handLoss = Math.min(damage, defender.hand.length);
    // Remove from front of hand (oldest cards)
    const discarded = defender.hand.splice(0, handLoss);
    logs.push(`💥 ${defender.name} takes ${damage} dmg! Loses ${handLoss} card${handLoss!==1?'s':''}.`);
    if (discarded.length) logs.push(`🗑️ Lost: ${discarded.map(c=>c.name).join(', ')}`);
    return { damage, discarded, handLoss };
  }
}

function processAction(state, type, payload, userId) {
  const myIdx = state.players.findIndex(p => p.userId === userId);
  if (myIdx < 0) return { ok: false, error: 'Not in game' };
  const me = state.players[myIdx];

  // ── Chat ──────────────────────────────────────────────────────────────────
  if (type === 'chat') {
    const text = (payload.text || '').trim().slice(0, 128);
    if (!text) return { ok: false, error: 'Empty message' };
    if (!state.chat) state.chat = [];
    state.chat.unshift({ userId, name: me.name, text, ts: Date.now() });
    if (state.chat.length > 30) state.chat.length = 30;
    return { ok: true };
  }

  // ── Quit ──────────────────────────────────────────────────────────────────
  if (type === 'quit') {
    if (me.spectating) return { ok: false, error: 'Already spectating' };
    me.spectating = true; me.eliminated = true; me.hand = [];
    addLog(state, `${me.name} quit (now spectating).`);
    if (myIdx === state.turnPlayerIndex && state.turnPhase === 'select')
      state.turnPlayerIndex = nextAliveIndex(state, myIdx);
    if (myIdx === state.targetPlayerIndex && state.turnPhase === 'defending') {
      giveCard(state, state.turnPlayerIndex, 1);
      state.playZone = []; state.attackTotal = 0;
      state.targetPlayerIndex = null; state.defenseDeadline = null;
      if (!checkWin(state)) { state.turnPhase = 'select'; state.turnPlayerIndex = nextAliveIndex(state, myIdx); }
    }
    checkWin(state);
    return { ok: true };
  }

  if (me.spectating) return { ok: false, error: 'You are spectating' };

  // ── Dismiss popup ─────────────────────────────────────────────────────────
  if (type === 'dismiss_popup') {
    if (state.notifications?.[myIdx]?.length) {
      state.notifications[myIdx].shift();
    }
    return { ok: true };
  }

  // ── Spy respond ───────────────────────────────────────────────────────────
  if (type === 'spy_respond') {
    if (!state.pendingSpy || state.pendingSpy.targetIdx !== myIdx)
      return { ok: false, error: 'No spy pending for you' };
    const spy = state.pendingSpy;
    const isSpying = Math.random() * 100 < spy.spyChance;
    state.pendingSpy = null;
    const senderName = state.players[spy.senderIdx]?.name || '?';

    if (payload.deploy) {
      if (isSpying) {
        const lostCards = me.hand.slice(0, spy.value).map(c => c.name);
        const dc = Math.min(spy.value, me.hand.length);
        me.hand.splice(0, dc);
        addLog(state, `🔴 SPY! ${senderName}'s card was a spy! ${me.name} loses ${dc} cards.`);
        notify(state, myIdx, `🔴 Spy revealed! The card from ${senderName} was a spy! You lost: ${lostCards.join(', ')}`);
      } else {
        const gainMap = [null,'soldier','armored_soldier','drone','jet','missile'];
        const gc = CARD_DEFS.find(d => d.id === gainMap[spy.value]);
        if (gc && me.hand.length < MAX_HAND) {
          me.hand.push({ uid:`sg${Date.now()}`, ...gc });
          addLog(state, `✅ Clean! ${me.name} gains a ${gc.name} from ${senderName}.`);
          notify(state, myIdx, `✅ The spy card was clean! You gained a ${gc.name} from ${senderName}.`);
        }
      }
    } else {
      addLog(state, `🗑️ ${me.name} discarded the spy card without deploying.`);
    }

    if (me.hand.length === 0) { me.eliminated = true; addLog(state, `💀 ${me.name} eliminated!`); }
    if (state.turnPhase === 'spy_pending') { state.turnPhase = 'select'; state.playZone = []; }
    checkWin(state);
    return { ok: true };
  }

  const isTurn   = myIdx === state.turnPlayerIndex;
  const isTarget = myIdx === state.targetPlayerIndex;

  // ── Choose divert target ──────────────────────────────────────────────────
  if (type === 'choose_divert') {
    if (!state.pendingDivert || state.pendingDivert.defenderIdx !== myIdx)
      return { ok: false, error: 'No divert pending for you' };
    const { newTargetIdx } = payload;
    const newTarget = state.players[newTargetIdx];
    if (!newTarget || newTarget.eliminated || newTargetIdx === state.turnPlayerIndex || newTargetIdx === myIdx)
      return { ok: false, error: 'Invalid redirect target' };
    state.pendingDivert = null;
    state.targetPlayerIndex = newTargetIdx;
    state.turnPhase = 'defending'; // back to defending for new target
    state.defenseDeadline = new Date(Date.now() + 30000).toISOString();
    addLog(state, `↩️ ${me.name} diverts the attack to ${newTarget.name}!`);
    notify(state, newTargetIdx, `↩️ ${me.name} has diverted the attack to you! ATK: ${state.attackTotal}. You have 30s to defend.`);
    return { ok: true };
  }

  // ── Cancel divert — give original defender their card back (it was already removed) ──
  // Just restores the phase so they can still take damage normally
  if (type === 'cancel_divert') {
    if (!state.pendingDivert || state.pendingDivert.defenderIdx !== myIdx)
      return { ok: false, error: 'No divert to cancel' };
    state.pendingDivert = null;
    state.targetPlayerIndex = myIdx; // back to being the defender
    state.turnPhase = 'defending';
    state.defenseDeadline = new Date(Date.now() + 20000).toISOString(); // shorter since they used time
    addLog(state, `↩️ ${me.name} cancelled the divert — will defend normally.`);
    return { ok: true };
  }

  // ── Deploy attack (attacker's SELECT phase) ───────────────────────────────
  if (type === 'deploy_cards') {
    if (!isTurn) return { ok: false, error: 'Not your turn' };
    if (state.turnPhase !== 'select') return { ok: false, error: 'Wrong phase' };
    const { cardUids, spyValue } = payload;
    if (!Array.isArray(cardUids) || cardUids.length === 0 || cardUids.length > 3)
      return { ok: false, error: 'Deploy 1–3 cards' };

    const cards = cardUids.map(uid => me.hand.find(c => c.uid === uid)).filter(Boolean);
    if (cards.length !== cardUids.length) return { ok: false, error: 'Invalid card selection — card not in hand' };

    const only = cards.length === 1 ? cards[0] : null;

    // ── Call Reinforcements ──
    if (only?.id === 'call_reinforce') {
      const idx = me.hand.findIndex(c => c.uid === only.uid);
      if (idx < 0) return { ok: false, error: 'Card not found' };
      me.hand.splice(idx, 1);
      const drawn = giveCard(state, myIdx, 2);
      addLog(state, `📦 ${me.name} plays Reinforcements — draws ${drawn} card${drawn!==1?'s':''}!`);
      notify(state, myIdx, `📦 Reinforcements played! You drew ${drawn} card${drawn!==1?'s':''}.`);
      state.turnPhase = 'select'; state.playZone = [];
      state.turnPlayerIndex = nextAliveIndex(state, myIdx);
      return { ok: true };
    }

    // ── Block Comms — works solo OR mixed with attack cards ──
    const blockCard = cards.find(c => c.id === 'block_comms');
    if (blockCard) {
      // Remove the block_comms card from hand
      const bIdx = me.hand.findIndex(c => c.uid === blockCard.uid);
      if (bIdx >= 0) me.hand.splice(bIdx, 1);
      state.blockCommsNextPlayer = true;
      addLog(state, `📡 ${me.name} activates Block Communications! Next defender's cards are hidden.`);
      // If solo, just end turn
      const nonBlockCards = cards.filter(c => c.id !== 'block_comms');
      if (nonBlockCards.length === 0) {
        state.turnPhase = 'select'; state.playZone = [];
        state.turnPlayerIndex = nextAliveIndex(state, myIdx);
        return { ok: true };
      }
      // Otherwise fall through with remaining cards as the attack
      // (spy/units below will use the remaining cards)
    }

    // Refilter cards removing already-processed specials (block_comms handled above)
    const remainingCards = cards.filter(c => c.id !== 'block_comms');

    // ── Spy Operation (solo or mixed with units, supports multiple) ──
    const spyCards = remainingCards.filter(c => c.id === 'spy_operation');
    const spyCard = spyCards[0]; // handle first spy; extra spies handled below
    if (spyCard) {
      const sv = Math.max(2, Math.min(5, parseInt(spyValue) || 3));
      const chances = { 2:15, 3:25, 4:40, 5:55 };
      const spyIdx = me.hand.findIndex(c => c.uid === spyCard.uid);
      me.hand.splice(spyIdx, 1);
      const spyTargetIdx = nextAliveIndex(state, myIdx);
      // If multiple spy cards, queue them (send to successive players)
      if (spyCards.length > 1) {
        const secondSpy = spyCards[1];
        const s2Idx = me.hand.findIndex(c => c.uid === secondSpy.uid);
        if (s2Idx >= 0) me.hand.splice(s2Idx, 1);
        const nextSpyTarget = nextAliveIndex(state, spyTargetIdx);
        if (nextSpyTarget !== myIdx && nextSpyTarget !== spyTargetIdx) {
          // Send second spy to the player after the first target
          addLog(state, `🕵️ ${me.name} also sends a Spy to ${state.players[nextSpyTarget].name}!`);
          notify(state, nextSpyTarget, `🕵️ ${me.name} also sent you a Spy card (value ${sv}, ${chances[sv]}% spy chance).`);
          // Store second spy in pendingSpy2
          state.pendingSpy2 = { senderIdx: myIdx, targetIdx: nextSpyTarget, value: sv, spyChance: chances[sv] };
        }
      }
      state.pendingSpy = { senderIdx: myIdx, targetIdx: spyTargetIdx, value: sv, spyChance: chances[sv] };
      addLog(state, `🕵️ ${me.name} sends Spy Operation (value ${sv}) to ${state.players[spyTargetIdx].name}!`);
      notify(state, spyTargetIdx, `🕵️ ${me.name} sent you a Spy card (value ${sv}, ${chances[sv]}% spy chance). Deploy or discard?`);

      // If spy was the only card, end turn and let spy phase resolve
      const unitCards2 = remainingCards.filter(c => c.type === 'unit' || (c.id !== 'spy_operation' && c.type !== 'special'));
      if (unitCards2.length === 0) {
        state.turnPhase = 'spy_pending';
        state.turnPlayerIndex = nextAliveIndex(state, myIdx);
        state.playZone = [];
        return { ok: true };
      }
      // Otherwise fall through and also launch the unit attack below
      // The spy is sent simultaneously; the attack proceeds normally
    }

    // ── Normal unit attack ──
    const unitCards = (typeof remainingCards !== 'undefined' ? remainingCards : cards).filter(c => c.type === 'unit');
    if (unitCards.length === 0) return { ok: false, error: 'Need at least one unit card to attack' };
    for (const card of unitCards)
      me.hand.splice(me.hand.findIndex(c => c.uid === card.uid), 1);

    const targetIdx = nextAliveIndex(state, myIdx);
    state.playZone = unitCards.map(c => ({ ...c, hidden: !!state.blockCommsNextPlayer }));
    state.blockCommsNextPlayer = false;
    state.attackTotal = unitCards.reduce((s, c) => s + (c.atk || 0), 0);
    state.targetPlayerIndex = targetIdx;
    state.defenseTotal = 0;

    if (state.attackTotal > 9 && me.hand.length > 0) {
      const pi = Math.floor(Math.random() * me.hand.length);
      const lost = me.hand.splice(pi, 1)[0];
      addLog(state, `⚠️ ${me.name} overextended! Loses ${lost.name}.`);
    }
    addLog(state, `⚔️ ${me.name} attacks ${state.players[targetIdx].name} — ATK ${state.attackTotal}!`);
    notify(state, targetIdx, `⚔️ ${me.name} is attacking you with ATK ${state.attackTotal}! Deploy defense cards.`);
    state.turnPhase = 'defending';
    state.defenseDeadline = new Date(Date.now() + 30000).toISOString();
    return { ok: true };
  }

  // ── Defend ────────────────────────────────────────────────────────────────
  if (type === 'defend' || type === 'skip_defense') {
    if (state.turnPhase !== 'defending' && state.turnPhase !== 'diverting') return { ok: false, error: 'Not defense phase' };

    if (type === 'skip_defense' && !isTarget) {
      const deadline = state.defenseDeadline ? new Date(state.defenseDeadline) : null;
      if (deadline && Date.now() < deadline.getTime())
        return { ok: false, error: 'Defense timer still running' };
    } else if (type === 'defend' && !isTarget) {
      return { ok: false, error: 'Not the defender' };
    }

    const defender  = state.players[state.targetPlayerIndex];
    const defMyIdx  = state.targetPlayerIndex;

    // ── Auto-resolve: defender has 0 cards — eliminate immediately ────────
    if (defender.hand.length === 0) {
      defender.eliminated = true;
      addLog(state, `💀 ${defender.name} has no cards left — eliminated!`);
      giveCard(state, state.turnPlayerIndex, 1);
      state.playZone = []; state.attackTotal = 0; state.defenseTotal = 0;
      state.targetPlayerIndex = null; state.defenseDeadline = null; state.pendingDivert = null;
      if (!checkWin(state)) {
        state.turnPhase = 'select';
        state.turnPlayerIndex = nextAliveIndex(state, defMyIdx);
      }
      return { ok: true };
    }

    let defCards    = [];
    let counterCard = null;

    if (type === 'defend') {
      const { cardUids } = payload;
      const cards = (cardUids || []).map(uid => defender.hand.find(c => c.uid === uid)).filter(Boolean);

      // Call Reinforcements on defense — draw 2, then take full damage (0 DEF)
      if (cards.length === 1 && cards[0].id === 'call_reinforce') {
        const idx = defender.hand.findIndex(c => c.uid === cards[0].uid);
        if (idx >= 0) defender.hand.splice(idx, 1);
        const drawn = giveCard(state, defMyIdx, 2);
        addLog(state, `📦 ${defender.name} plays Reinforcements on defense — draws ${drawn} card${drawn!==1?'s':''}!`);
        notify(state, defMyIdx, `📦 Reinforcements! Drew ${drawn} card${drawn!==1?'s':''}. No defense deployed — you take full damage.`);
        // defCards stays empty → full damage resolved below
      // Divert Attack — player picks new target
      } else if (cards.length === 1 && cards[0].id === 'divert_attack') {
        // Check if there are any valid redirect targets first
        const validTargets = state.players.filter((p, i) =>
          !p.eliminated && i !== defMyIdx && i !== state.turnPlayerIndex
        );
        if (validTargets.length === 0) {
          // No one to redirect to — card is wasted, take damage normally
          addLog(state, `↩️ ${defender.name} tried Divert Attack but there are no valid targets — card wasted!`);
          notify(state, defMyIdx, `↩️ Divert Attack has no valid targets (only 2 players). Card wasted — taking damage normally.`);
          const idx = defender.hand.findIndex(c => c.uid === cards[0].uid);
          if (idx >= 0) defender.hand.splice(idx, 1);
          // defCards stays empty, full damage below
        } else {
          const idx = defender.hand.findIndex(c => c.uid === cards[0].uid);
          defender.hand.splice(idx, 1);
          state.pendingDivert = { defenderIdx: defMyIdx };
          state.turnPhase = 'diverting';
          addLog(state, `↩️ ${defender.name} plays Divert Attack! Choose a new target.`);
          notify(state, defMyIdx, `↩️ Divert Attack played! Click on a player to redirect the attack to them.`);
          return { ok: true, needsDivert: true };
        }
      } else {
        // Normal defense — slots [0,1]=DEF, [2]=counter
        defCards    = cards.slice(0, 2).filter(c => c.type === 'unit');
        counterCard = cards[2] || null;
        // Remove cards from hand before resolving
        for (const uid of (cardUids || [])) {
          const idx = defender.hand.findIndex(c => c.uid === uid);
          if (idx >= 0) defender.hand.splice(idx, 1);
        }
      }

    } else {
      // skip_defense / timer expired — auto-play random cards
      const autoCount = Math.min(2, defender.hand.length);
      if (autoCount > 0) {
        addLog(state, `⏱️ ${defender.name}'s timer expired — random cards used for defense!`);
        for (let i = 0; i < autoCount; i++) {
          const ri = Math.floor(Math.random() * defender.hand.length);
          defCards.push(defender.hand.splice(ri, 1)[0]);
        }
        notify(state, defMyIdx, `⏱️ Your defense timer ran out! ${defCards.map(c=>c.name).join(' & ')} were auto-deployed.`);
      } else {
        addLog(state, `⏱️ ${defender.name}'s timer expired with no cards — full damage!`);
      }
    }

    // ── Resolve combat ─────────────────────────────────────────────────────
    const defTotal = defCards.reduce((s, c) => s + (c.def || 0), 0);
    const diff     = defTotal - state.attackTotal; // positive = excess defence, negative = damage taken

    if (diff > 0) {
      // DEF EXCEEDS ATK — cards survive but come back damaged (used hard)
      const returned = [];
      for (const card of defCards) {
        const dmg = damageCard(card);
        if (dmg) returned.push(dmg);
      }
      for (const c of returned) defender.hand.push(c);
      addLog(state, `🛡️ ${defender.name} holds! DEF ${defTotal} > ATK ${state.attackTotal}. Cards return damaged.`);
      if (returned.length) notify(state, defMyIdx, `🛡️ Defense exceeded the attack! Cards return damaged: ${returned.map(c=>`${c.name} (${c.atk}/${c.def})`).join(', ')}`);
    } else if (diff === 0) {
      // EXACTLY BALANCED — defence cards are fully consumed (used up), no hand loss
      addLog(state, `⚖️ ${defender.name} perfectly blocks! DEF ${defTotal} = ATK ${state.attackTotal}. Cards used up.`);
      notify(state, defMyIdx, `⚖️ Perfect block! Your DEF exactly matched the ATK ${state.attackTotal}. Defense cards consumed.`);
    } else {
      // ATK EXCEEDS DEF — defence cards consumed AND hand loses extra
      const damage   = state.attackTotal - defTotal;
      const handLoss = Math.min(damage, defender.hand.length);
      const lost     = handLoss > 0 ? defender.hand.splice(0, handLoss) : [];
      addLog(state, `💥 ${defender.name} takes ${damage} dmg! Loses ${handLoss} card${handLoss!==1?'s':''}.`);
      if (lost.length) {
        addLog(state, `🗑️ Lost: ${lost.map(c=>c.name).join(', ')}`);
        notify(state, defMyIdx, `💥 Attack broke through! You lost ${handLoss} card${handLoss!==1?'s':''}: ${lost.map(c=>c.name).join(', ')}.`);
      }
    }

    // Attacker draws 1
    const drawn = giveCard(state, state.turnPlayerIndex, 1);
    if (drawn) notify(state, state.turnPlayerIndex, `📥 You drew 1 card after your attack.`);

    if (defender.hand.length === 0) {
      defender.eliminated = true;
      addLog(state, `💀 ${defender.name} eliminated!`);
    }

    // Counter-attack from slot 3
    if (counterCard && !defender.eliminated && (counterCard.atk || 0) > 0) {
      const nextTarget = nextAliveIndex(state, defMyIdx);
      if (!state.players[nextTarget].eliminated && nextTarget !== state.turnPlayerIndex) {
        state.attackTotal    = counterCard.atk;
        state.defenseTotal   = 0;
        state.playZone       = [counterCard];
        state.turnPlayerIndex = defMyIdx;
        state.targetPlayerIndex = nextTarget;
        state.defenseDeadline = new Date(Date.now() + 30000).toISOString();
        addLog(state, `⚡ ${defender.name} counter-attacks ${state.players[nextTarget].name} — ATK ${counterCard.atk}!`);
        notify(state, nextTarget, `⚡ ${defender.name} counter-attacks you with ATK ${counterCard.atk}!`);
        if (!checkWin(state)) state.turnPhase = 'defending';
        return { ok: true };
      }
    }

    state.playZone = []; state.attackTotal = 0; state.defenseTotal = 0;
    state.targetPlayerIndex = null; state.defenseDeadline = null;
    state.pendingDivert = null;

    if (!checkWin(state)) {
      state.turnPhase = 'select';
      state.turnPlayerIndex = defender.eliminated
        ? nextAliveIndex(state, defMyIdx)
        : defMyIdx; // defender becomes next attacker (circular)
    }
    return { ok: true };
  }

  return { ok: false, error: 'Unknown action: ' + type };
}

// ── playerView ────────────────────────────────────────────────────────────────
function playerView(state, userId) {
  const myIdx = state.players.findIndex(p => p.userId === userId);
  return {
    status:           state.status,
    turnPhase:        state.turnPhase,
    turnPlayerIndex:  state.turnPlayerIndex,
    myPlayerIndex:    myIdx,
    myHand:           myIdx >= 0 ? state.players[myIdx].hand : [],
    maxHearts:        MAX_HEARTS,
    players: state.players.map((p, i) => ({
      userId: p.userId, name: p.name,
      cardCount: p.hand.length,
      hearts: Math.min(MAX_HEARTS, p.hand.length),
      maxHearts: MAX_HEARTS,
      eliminated: p.eliminated, spectating: p.spectating || false,
      seatIndex: p.seatIndex, isCurrentTurn: i === state.turnPlayerIndex,
    })),
    playZone:            state.playZone || [],
    attackTotal:         state.attackTotal || 0,
    defenseTotal:        state.defenseTotal || 0,
    targetPlayerIndex:   state.targetPlayerIndex,
    pendingDivertForMe:  state.pendingDivert?.defenderIdx === myIdx,
    blockCommsActive:    !!(state.blockCommsNextPlayer || (state.turnPhase === 'defending' && state.playZone.some(c => c.hidden))),
    pendingSpyForMe:     state.pendingSpy?.targetIdx === myIdx ? { value: state.pendingSpy.value } : null,
    deckCount:           state.deck.length,
    log:                 (state.log  || []).slice(0, 20),
    chat:                (state.chat || []).slice(0, 30),
    winner:              state.winner,
    winnerName:          state.winnerName,
    defenseDeadline:     state.defenseDeadline,
    groupName:           state.groupName,
    createdBy:           state.createdBy,
    createdAt:           state.createdAt,
    startingHand:        STARTING_HAND,
    popup:               myIdx >= 0 ? (state.notifications?.[myIdx]?.[0] || null) : null,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: games } = await pool.query(
      `SELECT tcg.id, tcg.status, tcg.created_at, tcg.group_id,
              g.name AS group_name, g.color AS group_color,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS creator_name,
              COUNT(DISTINCT tcp.user_id) AS player_count
       FROM trump_card_games tcg
       JOIN groups g ON g.id = tcg.group_id
       JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=$1 AND gm.status='accepted'
       LEFT JOIN users u ON u.id = tcg.created_by
       LEFT JOIN trump_card_players tcp ON tcp.game_id = tcg.id
       WHERE tcg.status IN ('waiting','playing')
       GROUP BY tcg.id, g.name, g.color, u.nickname, u.full_name
       ORDER BY tcg.created_at DESC LIMIT 20`,
      [req.user.id]
    );
    const { rows: [pts] } = await pool.query(
      `SELECT game_points FROM users WHERE id=$1`, [req.user.id]
    );
    res.json({ games: games.map(r=>({
      id:r.id, status:r.status, createdAt:r.created_at,
      groupId:r.group_id, groupName:r.group_name, groupColor:r.group_color,
      creatorName:r.creator_name, playerCount:parseInt(r.player_count),
    })), gamePoints: pts?.game_points || 0 });
  } catch (err) { console.error(err.message); res.status(500).json({ error:'Server error' }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.body;
    const mem = await pool.query(`SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'`, [groupId, req.user.id]);
    if (mem.rows.length === 0) return res.status(403).json({ error:'Not a group member' });
    const {rows:[me]}  = await pool.query(`SELECT COALESCE(nickname,split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [req.user.id]);
    const {rows:[grp]} = await pool.query(`SELECT name FROM groups WHERE id=$1`, [groupId]);
    const initState = {
      status:'waiting', turnPhase:'waiting', turnPlayerIndex:0,
      players:[{userId:req.user.id, name:me.name, hand:[], seatIndex:0, eliminated:false, spectating:false}],
      deck:[], playZone:[], attackTotal:0, defenseTotal:0,
      targetPlayerIndex:null, blockCommsNextPlayer:false,
      pendingSpy:null, pendingDivert:null, notifications:{},
      log:[], chat:[], winner:null, winnerName:null, defenseDeadline:null,
      groupName:grp?.name||'', createdBy:req.user.id, createdAt:new Date().toISOString(),
    };
    const {rows:[game]} = await pool.query(
      `INSERT INTO trump_card_games (group_id,created_by,status,game_state) VALUES ($1,$2,'waiting',$3) RETURNING id`,
      [groupId, req.user.id, JSON.stringify(initState)]
    );
    await pool.query(`INSERT INTO trump_card_players (game_id,user_id,seat_index) VALUES ($1,$2,0)`, [game.id, req.user.id]);
    res.status(201).json({ id:game.id });
  } catch (err) { console.error(err.message); res.status(500).json({ error:'Server error' }); }
});

router.post('/:id/join', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:[game]} = await client.query(`SELECT * FROM trump_card_games WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!game) return res.status(404).json({ error:'Not found' });
    if (game.status !== 'waiting') { await client.query('COMMIT'); return res.json({ message:'Spectating' }); }
    const state = game.game_state;
    if (state.players.find(p => p.userId === req.user.id)) { await client.query('COMMIT'); return res.json({ message:'Already in lobby' }); }
    if (state.players.length >= 9) return res.status(400).json({ error:'Full' });
    const mem = await client.query(`SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'`, [game.group_id, req.user.id]);
    if (mem.rows.length === 0) { await client.query('ROLLBACK'); return res.status(403).json({ error:'Not a group member' }); }
    const {rows:[me]} = await client.query(`SELECT COALESCE(nickname,split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [req.user.id]);
    const seatIndex = state.players.length;
    state.players.push({userId:req.user.id, name:me.name, hand:[], seatIndex, eliminated:false, spectating:false});
    addLog(state, `${me.name} joined the lobby.`);
    await client.query(`UPDATE trump_card_games SET game_state=$1,updated_at=NOW() WHERE id=$2`, [JSON.stringify(state), req.params.id]);
    await client.query(`INSERT INTO trump_card_players (game_id,user_id,seat_index) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.params.id, req.user.id, seatIndex]);
    await client.query('COMMIT');
    res.json({ message:'Joined!' });
  } catch (err) { await client.query('ROLLBACK'); console.error(err.message); res.status(500).json({ error:'Server error' }); }
  finally { client.release(); }
});

router.post('/:id/start', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:[game]} = await client.query(`SELECT * FROM trump_card_games WHERE id=$1 AND created_by=$2 FOR UPDATE`, [req.params.id, req.user.id]);
    if (!game) return res.status(403).json({ error:'Not found or not creator' });
    if (game.status !== 'waiting') return res.status(400).json({ error:'Already started' });
    const state = game.game_state;
    if (state.players.length < 2) return res.status(400).json({ error:'Need at least 2 players' });
    state.deck = buildDeck();
    state.status = 'playing'; state.turnPhase = 'select'; state.turnPlayerIndex = 0;
    for (let i = 0; i < state.players.length; i++)
      for (let j = 0; j < STARTING_HAND; j++)
        if (state.deck.length > 0) state.players[i].hand.push(state.deck.pop());
    addLog(state, `🃏 Game started! ${state.players.length} players, ${STARTING_HAND} cards each. Deck: ${state.deck.length}.`);
    addLog(state, `${state.players[0].name} attacks first.`);
    await client.query(`UPDATE trump_card_games SET game_state=$1,status='playing',updated_at=NOW() WHERE id=$2`, [JSON.stringify(state), req.params.id]);
    await client.query('COMMIT');
    res.json({ message:'Game started!' });
  } catch (err) { await client.query('ROLLBACK'); console.error(err.message); res.status(500).json({ error:'Server error' }); }
  finally { client.release(); }
});

router.get('/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const {rows:[game]} = await client.query(
      `SELECT tcg.*, g.name AS group_name FROM trump_card_games tcg JOIN groups g ON g.id=tcg.group_id WHERE tcg.id=$1`,
      [req.params.id]
    );
    if (!game) return res.status(404).json({ error:'Not found' });
    if (game.status === 'waiting' && Date.now() - new Date(game.created_at).getTime() > 120000) {
      await client.query(`UPDATE trump_card_games SET status='ended',updated_at=NOW() WHERE id=$1`, [req.params.id]);
      return res.json({status:'ended',expired:true,groupName:game.group_name,turnPhase:'ended',players:[],myPlayerIndex:-1,myHand:[],playZone:[],deckCount:0,log:[{text:'Lobby expired.',ts:Date.now()}],chat:[],winner:null,popup:null});
    }
    const state = game.game_state;
    state.groupName = game.group_name;
    const view = playerView(state, req.user.id);
    view.createdBy = game.created_by;
    view.createdAt = game.created_at;
    res.json(view);
  } catch (err) { console.error(err.message); res.status(500).json({ error:'Server error' }); }
  finally { client.release(); }
});

router.delete('/:id/lobby', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:[game]} = await client.query(`SELECT * FROM trump_card_games WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!game) { await client.query('ROLLBACK'); return res.status(404).json({ error:'Not found' }); }
    if (game.status !== 'waiting') { await client.query('ROLLBACK'); return res.status(400).json({ error:'Already started' }); }
    if (game.created_by === req.user.id) {
      await client.query(`UPDATE trump_card_games SET status='ended',updated_at=NOW() WHERE id=$1`, [req.params.id]);
    } else {
      const state = game.game_state;
      state.players = state.players.filter(p => p.userId !== req.user.id);
      await client.query(`UPDATE trump_card_games SET game_state=$1,updated_at=NOW() WHERE id=$2`, [JSON.stringify(state), req.params.id]);
      await client.query(`DELETE FROM trump_card_players WHERE game_id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    }
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch (err) { await client.query('ROLLBACK'); console.error(err.message); res.status(500).json({ error:'Server error' }); }
  finally { client.release(); }
});

router.post('/:id/action', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:[game]} = await client.query(`SELECT * FROM trump_card_games WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!game) { await client.query('ROLLBACK'); return res.status(404).json({ error:'Not found' }); }
    if (game.status === 'ended') { await client.query('ROLLBACK'); return res.status(400).json({ error:'Game over' }); }
    const state = game.game_state;
    const result = processAction(state, req.body.type, req.body.payload || {}, req.user.id);
    if (!result.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error:result.error }); }
    if (state.status === 'ended' && state.winner) {
      const pts = calcPoints(state, state.winner);
      await client.query(`UPDATE users SET game_points = COALESCE(game_points,0) + $1 WHERE id=$2`, [pts, state.winner]);
      addLog(state, `🎖️ ${state.winnerName} earns ${pts} points!`);
    }
    await client.query(`UPDATE trump_card_games SET game_state=$1,status=$2,updated_at=NOW() WHERE id=$3`, [JSON.stringify(state), state.status, req.params.id]);
    await client.query('COMMIT');
    res.json({ ...result, state: playerView(state, req.user.id) });
  } catch (err) { await client.query('ROLLBACK'); console.error(err.message); res.status(500).json({ error:'Server error' }); }
  finally { client.release(); }
});

export default router;
