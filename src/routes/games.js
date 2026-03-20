// src/routes/games.js — Trump Card game (circular order, ordered slots)
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const CARD_DEFS = [
  { id:'soldier',        name:'Soldier',             type:'unit',    sub:'basic',   atk:2,def:2,count:8 },
  { id:'armored_soldier',name:'Armored Soldier',      type:'unit',    sub:'basic',   atk:3,def:3,count:6 },
  { id:'drone',          name:'Drone',                type:'unit',    sub:'basic',   atk:3,def:2,count:7 },
  { id:'tank',           name:'Tank',                 type:'unit',    sub:'basic',   atk:4,def:4,count:6 },
  { id:'jet',            name:'Jet',                  type:'unit',    sub:'basic',   atk:4,def:3,count:5 },
  { id:'missile',        name:'Missile',              type:'unit',    sub:'basic',   atk:5,def:1,count:4 },
  { id:'artillery',      name:'Artillery',            type:'unit',    sub:'tactical',atk:3,def:4,count:5 },
  { id:'interceptor',    name:'Interceptor',          type:'unit',    sub:'tactical',atk:2,def:4,count:5 },
  { id:'divert_attack',  name:'Divert Attack',        type:'special', sub:'amber',   atk:0,def:0,count:4 },
  { id:'call_reinforce', name:'Call Reinforcements',  type:'special', sub:'amber',   atk:0,def:0,count:5 },
  { id:'spy_operation',  name:'Spy Operation',        type:'special', sub:'purple',  atk:0,def:0,count:5 },
  { id:'block_comms',    name:'Block Comms',          type:'special', sub:'purple',  atk:0,def:0,count:3 },
];

function buildDeck() {
  const cards = [];
  let uid = 0;
  for (const def of CARD_DEFS)
    for (let i = 0; i < def.count; i++)
      cards.push({ uid: `c${uid++}`, ...def });
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function addLog(state, text) {
  if (!state.log) state.log = [];
  state.log.unshift({ text, ts: Date.now() });
  if (state.log.length > 50) state.log.length = 50;
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
    state.turnPhase = 'ended';
    addLog(state, `🏆 ${alive[0].name} wins Last Command!`);
    return true;
  }
  return false;
}

function drawCard(state, playerIndex, count = 1) {
  const p = state.players[playerIndex];
  if (!p || p.eliminated) return;
  for (let i = 0; i < count; i++) {
    if (state.deck.length === 0 || p.hand.length >= 8) break;
    p.hand.push(state.deck.pop());
  }
}

function playerView(state, userId) {
  const myIdx = state.players.findIndex(p => p.userId === userId);
  return {
    status: state.status,
    turnPhase: state.turnPhase,
    turnPlayerIndex: state.turnPlayerIndex,
    myPlayerIndex: myIdx,
    myHand: myIdx >= 0 ? state.players[myIdx].hand : [],
    players: state.players.map((p, i) => ({
      userId: p.userId, name: p.name,
      cardCount: p.hand.length, eliminated: p.eliminated,
      spectating: p.spectating || false,
      seatIndex: p.seatIndex, isCurrentTurn: i === state.turnPlayerIndex,
    })),
    playZone: state.playZone || [],
    attackTotal: state.attackTotal || 0,
    defenseTotal: state.defenseTotal || 0,
    targetPlayerIndex: state.targetPlayerIndex,
    pendingSpyForMe: state.pendingSpy?.targetIdx === myIdx ? { value: state.pendingSpy.value } : null,
    deckCount: state.deck.length,
    log: (state.log || []).slice(0, 20),
    chat: (state.chat || []).slice(0, 30),
    winner: state.winner,
    defenseDeadline: state.defenseDeadline,
    groupName: state.groupName,
    createdBy: state.createdBy,
    createdAt: state.createdAt,
  };
}

function processAction(state, type, payload, userId) {
  const myIdx = state.players.findIndex(p => p.userId === userId);
  if (myIdx < 0) return { ok: false, error: 'Not in game' };
  const me = state.players[myIdx];

  // ── Chat (any time) ────────────────────────────────────────────────────────
  if (type === 'chat') {
    const text = (payload.text || '').trim().slice(0, 128);
    if (!text) return { ok: false, error: 'Empty message' };
    if (!state.chat) state.chat = [];
    state.chat.unshift({ userId, name: me.name, text, ts: Date.now() });
    if (state.chat.length > 30) state.chat.length = 30;
    return { ok: true };
  }

  // ── Quit (become spectator) ────────────────────────────────────────────────
  if (type === 'quit') {
    if (me.spectating) return { ok: false, error: 'Already spectating' };
    me.spectating = true;
    me.eliminated = true;
    me.hand = [];
    addLog(state, `${me.name} left the game (now spectating).`);
    const isTurn = myIdx === state.turnPlayerIndex;
    const isTarget = myIdx === state.targetPlayerIndex;
    if (isTurn && state.turnPhase === 'select') {
      state.turnPlayerIndex = nextAliveIndex(state, myIdx);
    }
    if (isTarget && state.turnPhase === 'defending') {
      drawCard(state, state.turnPlayerIndex, 1);
      state.playZone = []; state.attackTotal = 0;
      state.targetPlayerIndex = null; state.defenseDeadline = null;
      if (!checkWin(state)) {
        state.turnPhase = 'select';
        state.turnPlayerIndex = nextAliveIndex(state, myIdx);
      }
    }
    checkWin(state);
    return { ok: true };
  }

  if (me.spectating) return { ok: false, error: 'You are spectating' };

  // ── Spy respond (any time for target) ─────────────────────────────────────
  if (type === 'spy_respond') {
    if (!state.pendingSpy || state.pendingSpy.targetIdx !== myIdx)
      return { ok: false, error: 'No spy pending for you' };
    const spy = state.pendingSpy;
    const isSpying = Math.random() * 100 < spy.spyChance;
    state.pendingSpy = null;
    if (payload.deploy) {
      if (isSpying) {
        const discard = Math.min(spy.value, me.hand.length);
        me.hand.splice(0, discard);
        addLog(state, `🔴 Spy revealed! ${me.name} discards ${discard} cards!`);
      } else {
        const map = [null,'soldier','armored_soldier','drone','jet','missile'];
        const gc = CARD_DEFS.find(d => d.id === map[spy.value]);
        if (gc && me.hand.length < 8) {
          me.hand.push({ uid:`sg${Date.now()}`, ...gc });
          addLog(state, `✅ ${me.name} gains a ${gc.name}!`);
        }
      }
    } else { addLog(state, `🗑️ ${me.name} discarded the spy card.`); }
    if (me.hand.length === 0) { me.eliminated = true; addLog(state, `💀 ${me.name} is eliminated!`); }
    if (state.turnPhase === 'spy_pending') {
      state.turnPhase = 'select';
      state.playZone = [];
    }
    checkWin(state);
    return { ok: true };
  }

  const isTurn = myIdx === state.turnPlayerIndex;

  // ── Deploy attack (attacker's SELECT turn — always targets next alive) ─────
  if (type === 'deploy_cards' || type === 'deploy_attack') {
    if (!isTurn) return { ok: false, error: 'Not your turn' };
    if (state.turnPhase !== 'select') return { ok: false, error: 'Wrong phase' };

    const { cardUids, spyValue } = payload;
    if (!cardUids?.length || cardUids.length > 3) return { ok: false, error: 'Deploy 1–3 cards' };
    const cards = cardUids.map(uid => me.hand.find(c => c.uid === uid)).filter(Boolean);
    if (cards.length !== cardUids.length) return { ok: false, error: 'Invalid card selection' };

    const onlyCard = cards.length === 1 ? cards[0] : null;

    // Call Reinforcements — standalone
    if (onlyCard?.id === 'call_reinforce') {
      me.hand.splice(me.hand.findIndex(c => c.uid === onlyCard.uid), 1);
      drawCard(state, myIdx, 2);
      addLog(state, `📦 ${me.name} calls reinforcements — draws 2 cards.`);
      state.turnPhase = 'select';
      state.turnPlayerIndex = nextAliveIndex(state, myIdx);
      state.playZone = [];
      return { ok: true };
    }

    // Block Communications — standalone
    if (onlyCard?.id === 'block_comms') {
      me.hand.splice(me.hand.findIndex(c => c.uid === onlyCard.uid), 1);
      state.blockCommsNextPlayer = true;
      addLog(state, `📡 ${me.name} blocks communications! Next deployed cards are hidden.`);
      state.turnPhase = 'select';
      state.turnPlayerIndex = nextAliveIndex(state, myIdx);
      state.playZone = [];
      return { ok: true };
    }

    // Spy Operation — targets next player automatically
    if (onlyCard?.id === 'spy_operation') {
      const sv = parseInt(spyValue) || 3;
      if (sv < 2 || sv > 5) return { ok: false, error: 'Spy value must be 2–5' };
      const targetIdx = nextAliveIndex(state, myIdx);
      const spyChances = { 2:15,3:25,4:40,5:55 };
      me.hand.splice(me.hand.findIndex(c => c.uid === onlyCard.uid), 1);
      state.pendingSpy = { senderIdx:myIdx, targetIdx, value:sv, spyChance:spyChances[sv] };
      addLog(state, `🕵️ ${me.name} sends Spy Operation to ${state.players[targetIdx].name}!`);
      state.turnPhase = 'spy_pending';
      state.turnPlayerIndex = nextAliveIndex(state, myIdx);
      state.playZone = [];
      return { ok: true };
    }

    // Normal attack — must include at least one unit card
    const unitCards = cards.filter(c => c.type === 'unit');
    if (unitCards.length === 0) return { ok: false, error: 'Need at least one unit card to attack' };

    for (const card of unitCards) {
      const idx = me.hand.findIndex(c => c.uid === card.uid);
      me.hand.splice(idx, 1);
    }
    const targetIdx = nextAliveIndex(state, myIdx); // ALWAYS next alive — no manual picking
    state.playZone = unitCards.map(c => ({ ...c, hidden: !!state.blockCommsNextPlayer }));
    state.blockCommsNextPlayer = false;
    state.attackTotal = unitCards.reduce((s, c) => s + c.atk, 0);
    state.targetPlayerIndex = targetIdx;
    state.defenseTotal = 0;

    if (state.attackTotal > 9 && me.hand.length > 0) {
      me.hand.splice(Math.floor(Math.random() * me.hand.length), 1);
      addLog(state, `⚠️ ${me.name} overextended! Discards 1 card.`);
    }
    addLog(state, `⚔️ ${me.name} attacks ${state.players[targetIdx].name} with ATK ${state.attackTotal}!`);
    state.turnPhase = 'defending';
    state.defenseDeadline = new Date(Date.now() + 30000).toISOString();
    return { ok: true };
  }

  // ── Deploy defense (ordered slots: DEF1, DEF2, COUNTER-ATK) ───────────────
  if (type === 'defend' || type === 'deploy_defense') {
    if (state.turnPhase !== 'defending') return { ok: false, error: 'Not defense phase' };
    if (myIdx !== state.targetPlayerIndex) return { ok: false, error: 'Not the defender' };

    const { cardUids } = payload;
    const cards = (cardUids || []).map(uid => me.hand.find(c => c.uid === uid)).filter(Boolean);

    // Divert Attack — use as solo special
    if (cards.length === 1 && cards[0].id === 'divert_attack') {
      me.hand.splice(me.hand.findIndex(c => c.uid === cards[0].uid), 1);
      const newTarget = nextAliveIndex(state, myIdx); // redirect to next next
      if (newTarget === state.turnPlayerIndex)
        return { ok: false, error: 'Cannot redirect back to attacker' };
      state.targetPlayerIndex = newTarget;
      state.defenseDeadline = new Date(Date.now() + 30000).toISOString();
      addLog(state, `↩️ ${me.name} diverts attack to ${state.players[newTarget].name}!`);
      return { ok: true };
    }

    // Ordered slots:
    // Slot 0 + 1 → defense   (DEF values)
    // Slot 2     → counter-attack (ATK value, attacks next player after me)
    const defCards     = cards.slice(0, 2).filter(c => c.type === 'unit' || c.type === 'special');
    const counterCard  = cards.length >= 3 ? cards[2] : null;

    // Remove from hand
    for (const uid of cardUids) {
      const idx = me.hand.findIndex(c => c.uid === uid);
      if (idx >= 0) me.hand.splice(idx, 1);
    }

    const defTotal  = defCards.reduce((s, c) => s + (c.def || 0), 0);
    const damage    = Math.max(0, state.attackTotal - defTotal);

    if (damage > 0) {
      const dc = Math.min(damage, me.hand.length);
      me.hand.splice(0, dc);
      addLog(state, `💥 ${me.name} takes ${damage} damage! Discards ${dc} cards.`);
    } else {
      addLog(state, `🛡️ ${me.name}'s defense holds! (DEF ${defTotal} vs ATK ${state.attackTotal})`);
    }

    // Attacker draws 1 card
    drawCard(state, state.turnPlayerIndex, 1);

    if (me.hand.length === 0) {
      me.eliminated = true;
      addLog(state, `💀 ${me.name} is eliminated!`);
    }

    // Counter-attack — slot 3 card attacks the NEXT player after me
    if (counterCard && !me.eliminated && counterCard.atk > 0) {
      const nextTarget = nextAliveIndex(state, myIdx);
      // Don't counter if nextTarget is the original attacker AND only 2 players left (would infinite loop)
      if (!state.players[nextTarget].eliminated) {
        state.attackTotal    = counterCard.atk;
        state.defenseTotal   = 0;
        state.playZone       = [counterCard];
        state.turnPlayerIndex = myIdx; // Me as the new "attacker"
        state.targetPlayerIndex = nextTarget;
        state.defenseDeadline = new Date(Date.now() + 30000).toISOString();
        addLog(state, `⚡ ${me.name} counter-attacks ${state.players[nextTarget].name} with ATK ${counterCard.atk}!`);
        if (!checkWin(state)) state.turnPhase = 'defending';
        return { ok: true };
      }
    }

    // End of this attack chain — advance to next select turn
    state.playZone        = [];
    state.attackTotal     = 0;
    state.defenseTotal    = 0;
    state.targetPlayerIndex = null;
    state.defenseDeadline = null;

    if (!checkWin(state)) {
      state.turnPhase = 'select';
      // Next turn: the DEFENDER becomes the new attacker (circular)
      state.turnPlayerIndex = me.eliminated
        ? nextAliveIndex(state, myIdx)
        : myIdx;
    }
    return { ok: true };
  }

  // ── Skip / pass defense ───────────────────────────────────────────────────
  if (type === 'skip_defense') {
    if (state.turnPhase !== 'defending') return { ok: false, error: 'Not defense phase' };
    if (myIdx !== state.targetPlayerIndex) return { ok: false, error: 'Not the defender' };
    const dc = Math.min(state.attackTotal, me.hand.length);
    me.hand.splice(0, dc);
    addLog(state, `💥 ${me.name} takes ${state.attackTotal} damage (no defense)! Discards ${dc} cards.`);
    if (me.hand.length === 0) { me.eliminated = true; addLog(state, `💀 ${me.name} is eliminated!`); }
    drawCard(state, state.turnPlayerIndex, 1);
    state.playZone = []; state.attackTotal = 0; state.defenseTotal = 0;
    state.targetPlayerIndex = null; state.defenseDeadline = null;
    if (!checkWin(state)) {
      state.turnPhase = 'select';
      state.turnPlayerIndex = me.eliminated ? nextAliveIndex(state, myIdx) : myIdx;
    }
    return { ok: true };
  }

  return { ok: false, error: 'Unknown action' };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

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
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.body;
    const mem = await pool.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'`,
      [groupId, req.user.id]
    );
    if (mem.rows.length === 0) return res.status(403).json({ error: 'Not a group member' });
    const { rows: [me] } = await pool.query(
      `SELECT COALESCE(nickname, split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [req.user.id]
    );
    const { rows: [grp] } = await pool.query(`SELECT name FROM groups WHERE id=$1`, [groupId]);
    const initState = {
      status: 'waiting', turnPhase: 'waiting', turnPlayerIndex: 0,
      players: [{ userId: req.user.id, name: me.name, hand: [], seatIndex: 0, eliminated: false, spectating: false }],
      deck: [], playZone: [], attackTotal: 0, defenseTotal: 0,
      targetPlayerIndex: null, blockCommsNextPlayer: false,
      pendingSpy: null, log: [], chat: [], winner: null, defenseDeadline: null,
      groupName: grp?.name || '', createdBy: req.user.id, createdAt: new Date().toISOString(),
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
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
});

router.post('/:id/join', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [game] } = await client.query(
      `SELECT * FROM trump_card_games WHERE id=$1 FOR UPDATE`, [req.params.id]
    );
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.status !== 'waiting') { await client.query('COMMIT'); return res.json({ message: 'Game already started — spectating' }); }
    const state = game.game_state;
    if (state.players.find(p => p.userId === req.user.id)) {
      await client.query('COMMIT'); return res.json({ message: 'Already in game' });
    }
    if (state.players.length >= 9) return res.status(400).json({ error: 'Game is full' });
    const mem = await client.query(
      `SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'`,
      [game.group_id, req.user.id]
    );
    if (mem.rows.length === 0) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Not a group member' }); }
    const { rows: [me] } = await client.query(
      `SELECT COALESCE(nickname, split_part(full_name,' ',1)) AS name FROM users WHERE id=$1`, [req.user.id]
    );
    const seatIndex = state.players.length;
    state.players.push({ userId: req.user.id, name: me.name, hand: [], seatIndex, eliminated: false, spectating: false });
    addLog(state, `${me.name} joined the lobby.`);
    await client.query(
      `UPDATE trump_card_games SET game_state=$1, updated_at=NOW() WHERE id=$2`, [JSON.stringify(state), req.params.id]
    );
    await client.query(
      `INSERT INTO trump_card_players (game_id, user_id, seat_index) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id, seatIndex]
    );
    await client.query('COMMIT');
    res.json({ message: 'Joined!' });
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err.message); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

router.post('/:id/start', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [game] } = await client.query(
      `SELECT * FROM trump_card_games WHERE id=$1 AND created_by=$2 FOR UPDATE`, [req.params.id, req.user.id]
    );
    if (!game) return res.status(403).json({ error: 'Not found or not creator' });
    if (game.status !== 'waiting') return res.status(400).json({ error: 'Already started' });
    const state = game.game_state;
    if (state.players.length < 2) return res.status(400).json({ error: 'Need at least 2 players' });
    state.deck = buildDeck();
    state.status = 'playing';
    state.turnPhase = 'select';
    state.turnPlayerIndex = 0;
    for (let i = 0; i < state.players.length; i++)
      for (let j = 0; j < 7; j++)
        if (state.deck.length > 0) state.players[i].hand.push(state.deck.pop());
    addLog(state, `🃏 Game started! ${state.players.length} players. ${state.deck.length} cards in deck.`);
    addLog(state, `${state.players[0].name} attacks first.`);
    await client.query(
      `UPDATE trump_card_games SET game_state=$1, status='playing', updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(state), req.params.id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Game started!' });
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err.message); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

router.get('/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: [game] } = await client.query(
      `SELECT tcg.*, g.name AS group_name FROM trump_card_games tcg JOIN groups g ON g.id = tcg.group_id WHERE tcg.id=$1`,
      [req.params.id]
    );
    if (!game) return res.status(404).json({ error: 'Game not found' });

    // Auto-expire waiting lobbies after 2 minutes
    if (game.status === 'waiting' && Date.now() - new Date(game.created_at).getTime() > 120000) {
      await client.query(`UPDATE trump_card_games SET status='ended', updated_at=NOW() WHERE id=$1`, [req.params.id]);
      return res.json({ status: 'ended', expired: true, groupName: game.group_name,
        turnPhase: 'ended', players: [], myPlayerIndex: -1, myHand: [], playZone: [],
        deckCount: 0, log: [{ text: 'Lobby expired.', ts: Date.now() }], chat: [], winner: null });
    }

    const state = game.game_state;
    state.groupName = game.group_name;
    const view = playerView(state, req.user.id);
    view.createdBy = game.created_by;
    view.createdAt = game.created_at;
    res.json(view);
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

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
      await client.query(`UPDATE trump_card_games SET status='ended', updated_at=NOW() WHERE id=$1`, [req.params.id]);
      await client.query('COMMIT');
      return res.json({ closed: true });
    } else {
      const state = game.game_state;
      state.players = state.players.filter(p => p.userId !== req.user.id);
      await client.query(
        `UPDATE trump_card_games SET game_state=$1, updated_at=NOW() WHERE id=$2`, [JSON.stringify(state), req.params.id]
      );
      await client.query(`DELETE FROM trump_card_players WHERE game_id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
      await client.query('COMMIT');
      return res.json({ left: true });
    }
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err.message); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

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
    res.json({ ...result, state: playerView(state, req.user.id) });
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err.message); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

export default router;
