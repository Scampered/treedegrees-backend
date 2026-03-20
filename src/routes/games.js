// src/routes/games.js — Trump Card game backend
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── Card definitions ──────────────────────────────────────────────────────────
const CARD_DEFS = [
  { id:'soldier',         name:'Soldier',               type:'unit',    sub:'basic',    atk:2, def:2, count:8  },
  { id:'armored_soldier', name:'Armored Soldier',        type:'unit',    sub:'basic',    atk:3, def:3, count:6  },
  { id:'drone',           name:'Drone',                  type:'unit',    sub:'basic',    atk:3, def:2, count:7  },
  { id:'tank',            name:'Tank',                   type:'unit',    sub:'basic',    atk:4, def:4, count:6  },
  { id:'jet',             name:'Jet',                    type:'unit',    sub:'basic',    atk:4, def:3, count:5  },
  { id:'missile',         name:'Missile',                type:'unit',    sub:'basic',    atk:5, def:1, count:4  },
  { id:'artillery',       name:'Artillery',              type:'unit',    sub:'tactical', atk:3, def:4, count:5  },
  { id:'interceptor',     name:'Interceptor',            type:'unit',    sub:'tactical', atk:2, def:4, count:5  },
  { id:'divert_attack',   name:'Divert Attack',          type:'special', sub:'amber',    atk:0, def:0, count:4  },
  { id:'call_reinforce',  name:'Call Reinforcements',    type:'special', sub:'amber',    atk:0, def:0, count:5  },
  { id:'spy_operation',   name:'Spy Operation',          type:'special', sub:'purple',   atk:0, def:0, count:5  },
  { id:'block_comms',     name:'Block Communications',   type:'special', sub:'purple',   atk:0, def:0, count:3  },
];

function buildDeck() {
  const cards = [];
  let uid = 0;
  for (const def of CARD_DEFS) {
    for (let i = 0; i < def.count; i++) {
      cards.push({ uid: `c${uid++}`, ...def });
    }
  }
  // Fisher-Yates shuffle
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function addLog(state, text) {
  state.log.unshift({ text, ts: Date.now() });
  if (state.log.length > 40) state.log.length = 40;
}

function nextAliveIndex(state, from) {
  let idx = (from + 1) % state.players.length;
  let tries = 0;
  while (state.players[idx].eliminated && tries < state.players.length) {
    idx = (idx + 1) % state.players.length;
    tries++;
  }
  return idx;
}

function checkWin(state) {
  const alive = state.players.filter(p => !p.eliminated);
  if (alive.length === 1) {
    state.status = 'ended';
    state.winner = alive[0].userId;
    state.turnPhase = 'ended';
    addLog(state, `🏆 ${alive[0].name} wins!`);
    return true;
  }
  return false;
}

function drawCard(state, playerIndex, count = 1) {
  const p = state.players[playerIndex];
  for (let i = 0; i < count; i++) {
    if (state.deck.length === 0) break;
    if (p.hand.length >= 8) break;
    p.hand.push(state.deck.pop());
  }
}

// Return game state filtered for a specific user
function playerView(state, userId, players) {
  const myIdx = state.players.findIndex(p => p.userId === userId);
  return {
    status: state.status,
    turnPhase: state.turnPhase,
    turnPlayerIndex: state.turnPlayerIndex,
    myPlayerIndex: myIdx,
    myHand: myIdx >= 0 ? state.players[myIdx].hand : [],
    players: state.players.map((p, i) => ({
      userId: p.userId,
      name: p.name,
      cardCount: p.hand.length,
      eliminated: p.eliminated,
      seatIndex: p.seatIndex,
      isCurrentTurn: i === state.turnPlayerIndex,
    })),
    playZone: state.playZone,
    attackTotal: state.attackTotal,
    defenseTotal: state.defenseTotal,
    targetPlayerIndex: state.targetPlayerIndex,
    blockCommsActive: state.blockCommsNextPlayer && state.turnPlayerIndex === (myIdx),
    pendingSpyForMe: state.pendingSpy?.targetIdx === myIdx ? { value: state.pendingSpy.value } : null,
    pendingDivert: state.pendingDivert || null,
    deckCount: state.deck.length,
    log: state.log.slice(0, 15),
    winner: state.winner,
    defenseDeadline: state.defenseDeadline,
  };
}

// ── Process game actions ───────────────────────────────────────────────────────
function processAction(state, type, payload, userId) {
  const myIdx = state.players.findIndex(p => p.userId === userId);
  if (myIdx < 0) return { ok: false, error: 'Not in game' };
  const me = state.players[myIdx];

  // Actions available anytime (not turn-gated):
  if (type === 'spy_respond') {
    if (!state.pendingSpy || state.pendingSpy.targetIdx !== myIdx) return { ok: false, error: 'No spy card for you' };
    const spy = state.pendingSpy;
    const isSpying = Math.random() * 100 < spy.spyChance;
    state.pendingSpy = null;
    const senderName = state.players[spy.senderIdx].name;
    if (payload.deploy) {
      if (isSpying) {
        // Spy: discard cards equal to value
        const discard = Math.min(spy.value, me.hand.length);
        me.hand.splice(0, discard);
        addLog(state, `🔴 Spy revealed! ${me.name} discards ${discard} cards!`);
      } else {
        // Not spy: gain a unit card based on value
        const gainDef = [null,'soldier','armored_soldier','drone','jet','missile'];
        const gainCard = CARD_DEFS.find(d => d.id === gainDef[spy.value]);
        if (gainCard && me.hand.length < 8) {
          me.hand.push({ uid: `spy_gain_${Date.now()}`, ...gainCard });
          addLog(state, `✅ Clean! ${me.name} gains a ${gainCard.name} from ${senderName}!`);
        }
      }
    } else {
      addLog(state, `🗑️ ${me.name} discarded the spy card without deploying.`);
    }
    // Check if this player was holding things up
    if (state.turnPhase === 'spy_pending') {
      state.turnPhase = 'select';
      const nextIdx = nextAliveIndex(state, state.turnPlayerIndex);
      state.turnPlayerIndex = nextIdx;
      state.playZone = [];
    }
    if (me.hand.length === 0) {
      me.eliminated = true;
      addLog(state, `💀 ${me.name} is eliminated!`);
      checkWin(state);
    }
    return { ok: true };
  }

  if (type === 'divert_respond') {
    if (!state.pendingDivert || state.pendingDivert.targetIdx !== myIdx) return { ok: false, error: 'No divert for you' };
    // Play divert card from hand
    const cardIdx = me.hand.findIndex(c => c.id === 'divert_attack');
    if (cardIdx < 0) return { ok: false, error: 'No Divert Attack card in hand' };
    me.hand.splice(cardIdx, 1);
    const newTargetIdx = payload.newTargetIdx;
    const newTarget = state.players[newTargetIdx];
    if (!newTarget || newTarget.eliminated || newTargetIdx === state.turnPlayerIndex) return { ok: false, error: 'Invalid redirect target' };
    addLog(state, `↩️ ${me.name} diverts attack to ${newTarget.name}!`);
    state.pendingDivert = null;
    state.targetPlayerIndex = newTargetIdx;
    state.turnPhase = 'defending';
    state.defenseDeadline = new Date(Date.now() + 30000).toISOString();
    return { ok: true };
  }

  // Turn-gated actions
  const isTurn = myIdx === state.turnPlayerIndex;

  if (type === 'deploy_cards') {
    if (!isTurn) return { ok: false, error: 'Not your turn' };
    if (state.turnPhase !== 'select') return { ok: false, error: 'Wrong phase' };
    const { cardUids, targetIdx } = payload;
    if (!cardUids || cardUids.length < 1 || cardUids.length > 3) return { ok: false, error: 'Deploy 1-3 cards' };

    const cards = cardUids.map(uid => me.hand.find(c => c.uid === uid)).filter(Boolean);
    if (cards.length !== cardUids.length) return { ok: false, error: 'Invalid card selection' };

    // Handle special cards separately
    const specials = cards.filter(c => c.type === 'special');
    const units = cards.filter(c => c.type === 'unit');

    // Call Reinforcements (solo action)
    if (specials.some(c => c.id === 'call_reinforce') && cards.length === 1) {
      const idx = me.hand.findIndex(c => c.uid === cards[0].uid);
      me.hand.splice(idx, 1);
      drawCard(state, myIdx, 2);
      addLog(state, `📦 ${me.name} calls reinforcements — draws 2 cards.`);
      state.turnPhase = 'select';
      state.turnPlayerIndex = nextAliveIndex(state, myIdx);
      state.playZone = [];
      return { ok: true };
    }

    // Block Communications
    if (specials.some(c => c.id === 'block_comms') && cards.length === 1) {
      const idx = me.hand.findIndex(c => c.uid === cards[0].uid);
      me.hand.splice(idx, 1);
      state.blockCommsNextPlayer = true;
      addLog(state, `📡 ${me.name} blocks communications! Next player's cards are hidden.`);
      state.turnPhase = 'select';
      state.turnPlayerIndex = nextAliveIndex(state, myIdx);
      state.playZone = [];
      return { ok: true };
    }

    // Spy Operation
    if (specials.some(c => c.id === 'spy_operation') && cards.length === 1) {
      if (targetIdx == null || targetIdx === myIdx) return { ok: false, error: 'Choose a target for spy' };
      const { spyValue } = payload; // 2-5
      if (!spyValue || spyValue < 2 || spyValue > 5) return { ok: false, error: 'Choose spy value 2-5' };
      const spyChances = { 2: 15, 3: 25, 4: 40, 5: 55 };
      const idx = me.hand.findIndex(c => c.uid === cards[0].uid);
      me.hand.splice(idx, 1);
      state.pendingSpy = { senderIdx: myIdx, targetIdx, value: spyValue, spyChance: spyChances[spyValue] };
      addLog(state, `🕵️ ${me.name} sends a Spy Operation to ${state.players[targetIdx].name}!`);
      state.turnPhase = 'spy_pending';
      // Current turn ends, next player goes
      state.turnPlayerIndex = nextAliveIndex(state, myIdx);
      state.playZone = [];
      return { ok: true };
    }

    // Normal unit attack deployment
    if (units.length === 0) return { ok: false, error: 'No attack units selected' };
    if (targetIdx == null || targetIdx === myIdx) return { ok: false, error: 'Choose a target player' };
    const target = state.players[targetIdx];
    if (!target || target.eliminated) return { ok: false, error: 'Invalid target' };

    // Remove cards from hand and put in play zone
    for (const card of units) {
      const idx = me.hand.findIndex(c => c.uid === card.uid);
      me.hand.splice(idx, 1);
    }
    state.playZone = units.map(c => ({ ...c, hidden: state.blockCommsNextPlayer }));
    state.blockCommsNextPlayer = false;
    state.attackTotal = units.reduce((s, c) => s + c.atk, 0);
    state.targetPlayerIndex = targetIdx;

    // Overextension penalty
    if (state.attackTotal > 9 && me.hand.length > 0) {
      const penaltyIdx = Math.floor(Math.random() * me.hand.length);
      me.hand.splice(penaltyIdx, 1);
      addLog(state, `⚠️ ${me.name} overextended! Discards 1 card as penalty.`);
    }

    addLog(state, `⚔️ ${me.name} attacks ${target.name} with ${state.attackTotal} ATK!`);
    state.turnPhase = 'defending';
    state.defenseDeadline = new Date(Date.now() + 30000).toISOString();
    return { ok: true };
  }

  if (type === 'defend') {
    if (state.turnPhase !== 'defending') return { ok: false, error: 'Not defense phase' };
    if (myIdx !== state.targetPlayerIndex) return { ok: false, error: 'Not the defender' };
    const { cardUids } = payload;
    const cards = (cardUids || []).map(uid => me.hand.find(c => c.uid === uid)).filter(Boolean);

    // Check for Divert Attack card in selection
    const divertCard = cards.find(c => c.id === 'divert_attack');
    if (divertCard && cards.length === 1) {
      const idx = me.hand.findIndex(c => c.uid === divertCard.uid);
      me.hand.splice(idx, 1);
      state.pendingDivert = { targetIdx: myIdx, fromIdx: state.turnPlayerIndex };
      state.turnPhase = 'diverting';
      addLog(state, `↩️ ${me.name} plays Divert Attack! Choose a new target.`);
      return { ok: true, needsDivert: true };
    }

    const defCards = cards.filter(c => c.type === 'unit');
    for (const card of defCards) {
      const idx = me.hand.findIndex(c => c.uid === card.uid);
      me.hand.splice(idx, 1);
    }
    state.defenseTotal = defCards.reduce((s, c) => s + c.def, 0);
    addLog(state, `🛡️ ${me.name} defends with ${state.defenseTotal} DEF.`);

    // Resolve combat
    const damage = Math.max(0, state.attackTotal - state.defenseTotal);
    if (damage > 0) {
      const discardCount = Math.min(damage, me.hand.length);
      me.hand.splice(0, discardCount);
      addLog(state, `💥 ${me.name} takes ${damage} damage! Discards ${discardCount} cards.`);
    } else {
      addLog(state, `✅ ${me.name}'s defense holds! No damage dealt.`);
    }

    if (me.hand.length === 0) {
      me.eliminated = true;
      addLog(state, `💀 ${me.name} is eliminated!`);
    }

    // Attacker draws 1
    drawCard(state, state.turnPlayerIndex, 1);

    // Reset and advance turn
    state.playZone = [];
    state.attackTotal = 0;
    state.defenseTotal = 0;
    state.targetPlayerIndex = null;
    state.defenseDeadline = null;

    if (!checkWin(state)) {
      state.turnPhase = 'select';
      state.turnPlayerIndex = nextAliveIndex(state, state.turnPlayerIndex);
    }
    return { ok: true };
  }

  if (type === 'skip_defense') {
    // Auto-resolve when defender timer expires or passes
    if (state.turnPhase !== 'defending') return { ok: false, error: 'Not defense phase' };
    // Anyone can trigger this after deadline passes, or the defender themselves
    const now = new Date();
    const deadline = state.defenseDeadline ? new Date(state.defenseDeadline) : null;
    if (myIdx !== state.targetPlayerIndex && deadline && now < deadline) {
      return { ok: false, error: 'Defense timer still running' };
    }
    // 0 defense
    const defender = state.players[state.targetPlayerIndex];
    state.defenseTotal = 0;
    const damage = state.attackTotal;
    const discardCount = Math.min(damage, defender.hand.length);
    defender.hand.splice(0, discardCount);
    addLog(state, `💥 ${defender.name} takes ${damage} damage (no defense)! Discards ${discardCount} cards.`);

    if (defender.hand.length === 0) {
      defender.eliminated = true;
      addLog(state, `💀 ${defender.name} is eliminated!`);
    }

    drawCard(state, state.turnPlayerIndex, 1);

    state.playZone = [];
    state.attackTotal = 0;
    state.defenseTotal = 0;
    state.targetPlayerIndex = null;
    state.defenseDeadline = null;

    if (!checkWin(state)) {
      state.turnPhase = 'select';
      state.turnPlayerIndex = nextAliveIndex(state, state.turnPlayerIndex);
    }
    return { ok: true };
  }

  return { ok: false, error: 'Unknown action' };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/games — list games for viewer's groups
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tcg.id, tcg.status, tcg.created_at, tcg.group_id,
              g.name AS group_name, g.color AS group_color,
              COALESCE(u.nickname, split_part(u.full_name,' ',1)) AS creator_name,
              COUNT(DISTINCT tcp.user_id) AS player_count
       FROM trump_card_games tcg
       JOIN groups g ON g.id = tcg.group_id
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1 AND gm.status = 'accepted'
       LEFT JOIN users u ON u.id = tcg.created_by
       LEFT JOIN trump_card_players tcp ON tcp.game_id = tcg.id
       WHERE tcg.status IN ('waiting','playing')
       GROUP BY tcg.id, g.name, g.color, u.nickname, u.full_name
       ORDER BY tcg.created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json(rows.map(r => ({
      id: r.id, status: r.status, createdAt: r.created_at,
      groupId: r.group_id, groupName: r.group_name, groupColor: r.group_color,
      creatorName: r.creator_name, playerCount: parseInt(r.player_count),
    })));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/games — create game
router.post('/', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.body;
    const member = await pool.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'`,
      [groupId, req.user.id]
    );
    if (member.rows.length === 0) return res.status(403).json({ error: 'Not a group member' });

    const { rows: [me] } = await pool.query(
      `SELECT COALESCE(nickname, split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`,
      [req.user.id]
    );

    const initState = {
      status: 'waiting', turnPhase: 'waiting', turnPlayerIndex: 0,
      players: [{ userId: req.user.id, name: me.name, hand: [], seatIndex: 0, eliminated: false }],
      deck: [], playZone: [], attackTotal: 0, defenseTotal: 0,
      targetPlayerIndex: null, blockCommsNextPlayer: false,
      pendingSpy: null, pendingDivert: null, log: [], winner: null, defenseDeadline: null,
    };

    const { rows: [game] } = await pool.query(
      `INSERT INTO trump_card_games (group_id, created_by, status, game_state) VALUES ($1,$2,'waiting',$3) RETURNING id`,
      [groupId, req.user.id, JSON.stringify(initState)]
    );
    await pool.query(
      `INSERT INTO trump_card_players (game_id, user_id, seat_index) VALUES ($1,$2,0)`,
      [game.id, req.user.id]
    );
    res.status(201).json({ id: game.id });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/games/:id/join
router.post('/:id/join', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [game] } = await client.query(
      `SELECT tcg.*, g.id AS gid FROM trump_card_games tcg JOIN groups g ON g.id = tcg.group_id WHERE tcg.id=$1 FOR UPDATE`,
      [req.params.id]
    );
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.status !== 'waiting') return res.status(400).json({ error: 'Game already started' });

    const state = game.game_state;
    if (state.players.find(p => p.userId === req.user.id)) {
      await client.query('COMMIT');
      return res.json({ message: 'Already in game' });
    }
    if (state.players.length >= 9) return res.status(400).json({ error: 'Game is full (max 9)' });

    // Check group membership
    const mem = await client.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'`,
      [game.group_id, req.user.id]
    );
    if (mem.rows.length === 0) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Not a group member' }); }

    const { rows: [me] } = await client.query(
      `SELECT COALESCE(nickname, split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [req.user.id]
    );

    const seatIndex = state.players.length;
    state.players.push({ userId: req.user.id, name: me.name, hand: [], seatIndex, eliminated: false });
    addLog(state, `${me.name} joined the game.`);

    await client.query(
      `UPDATE trump_card_games SET game_state=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(state), req.params.id]
    );
    await client.query(
      `INSERT INTO trump_card_players (game_id, user_id, seat_index) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id, seatIndex]
    );
    await client.query('COMMIT');
    res.json({ message: 'Joined!' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST /api/games/:id/start
router.post('/:id/start', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [game] } = await client.query(
      `SELECT * FROM trump_card_games WHERE id=$1 AND created_by=$2 FOR UPDATE`,
      [req.params.id, req.user.id]
    );
    if (!game) return res.status(403).json({ error: 'Not found or not creator' });
    if (game.status !== 'waiting') return res.status(400).json({ error: 'Already started' });
    const state = game.game_state;
    if (state.players.length < 2) return res.status(400).json({ error: 'Need at least 2 players' });

    state.deck = buildDeck();
    state.status = 'playing';
    state.turnPhase = 'select';
    state.turnPlayerIndex = 0;

    // Deal 7 cards each
    for (let i = 0; i < state.players.length; i++) {
      for (let j = 0; j < 7; j++) {
        if (state.deck.length > 0) state.players[i].hand.push(state.deck.pop());
      }
    }
    addLog(state, `🃏 Game started! ${state.players.length} players. ${state.deck.length} cards in deck.`);
    addLog(state, `${state.players[0].name}'s turn.`);

    await client.query(
      `UPDATE trump_card_games SET game_state=$1, status='playing', updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(state), req.params.id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Game started!' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /api/games/:id — get game state (player-filtered)
router.get('/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: [game] } = await client.query(
      `SELECT tcg.game_state, tcg.status, tcg.created_at, tcg.created_by,
              g.name AS group_name
       FROM trump_card_games tcg
       JOIN groups g ON g.id = tcg.group_id
       WHERE tcg.id=$1`, [req.params.id]
    );
    if (!game) return res.status(404).json({ error: 'Game not found' });

    // Auto-expire waiting lobbies after 2 minutes
    if (game.status === 'waiting') {
      const ageMs = Date.now() - new Date(game.created_at).getTime();
      if (ageMs > 120000) {
        await client.query(
          `UPDATE trump_card_games SET status='ended', updated_at=NOW() WHERE id=$1`,
          [req.params.id]
        );
        return res.json({ status: 'ended', expired: true, groupName: game.group_name,
          turnPhase: 'ended', players: [], myPlayerIndex: -1, myHand: [],
          playZone: [], deckCount: 0, log: [{ text: 'Lobby expired after 2 minutes.', ts: Date.now() }],
          winner: null });
      }
    }

    const state = game.game_state;
    const { rows: players } = await client.query(
      `SELECT user_id, seat_index FROM trump_card_players WHERE game_id=$1`, [req.params.id]
    );
    const view = playerView(state, req.user.id, players);
    view.groupName = game.group_name;
    view.createdBy = game.created_by;
    res.json(view);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/games/:id/lobby — leave or close lobby
router.delete('/:id/lobby', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [game] } = await client.query(
      `SELECT * FROM trump_card_games WHERE id=$1 FOR UPDATE`, [req.params.id]
    );
    if (!game) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (game.status !== 'waiting') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Game already started' }); }

    if (game.created_by === req.user.id) {
      // Admin: close the whole lobby
      await client.query(
        `UPDATE trump_card_games SET status='ended', updated_at=NOW() WHERE id=$1`, [req.params.id]
      );
      addLog(game.game_state, 'Lobby closed by host.');
      await client.query('COMMIT');
      return res.json({ closed: true });
    } else {
      // Non-admin: just remove themselves
      await client.query(
        `DELETE FROM trump_card_players WHERE game_id=$1 AND user_id=$2`, [req.params.id, req.user.id]
      );
      const state = game.game_state;
      state.players = state.players.filter(p => p.userId !== req.user.id);
      await client.query(
        `UPDATE trump_card_games SET game_state=$1, updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(state), req.params.id]
      );
      await client.query('COMMIT');
      return res.json({ left: true });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST /api/games/:id/action
router.post('/:id/action', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [game] } = await client.query(
      `SELECT * FROM trump_card_games WHERE id=$1 FOR UPDATE`, [req.params.id]
    );
    if (!game) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (game.status === 'ended') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Game over' }); }

    const state = game.game_state;
    const result = processAction(state, req.body.type, req.body.payload || {}, req.user.id);

    if (!result.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: result.error }); }

    await client.query(
      `UPDATE trump_card_games SET game_state=$1, status=$2, updated_at=NOW() WHERE id=$3`,
      [JSON.stringify(state), state.status, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ ...result, state: playerView(state, req.user.id, []) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

export default router;
