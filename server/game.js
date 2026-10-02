/**
 * UNO rules engine.
 *
 * Pure logic: no I/O, no network, no timers. Every rule decision is made here,
 * on the server, so two browsers can never disagree about the game.
 *
 * The state object is plain JSON (structured-clone safe) so it can be
 * serialised, snapshotted, and diffed by tests.
 */

import { randomInt } from 'node:crypto';

/** A round must end somehow, even when both seats refuse to call UNO. */
export const MAX_PLAYS = 400;

export const COLORS = ['R', 'Y', 'G', 'B'];

export const COLOR_NAMES = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Blue', W: 'Wild' };

export const COLOR_HEX = { R: '#e63946', Y: '#f4a300', G: '#2a9d5c', B: '#2f6fd0', W: '#2a2f3a' };

/** Full UNO scoring: face cards are worth their number, actions 20, wilds 50. */
export function cardValue(card) {
  if (card.kind === 'num') return card.num;
  if (card.kind === 'wild' || card.kind === 'wild4') return 50;
  return 20;
}

/**
 * Builds the 108-card deck: 4 colours x (one 0, two each of 1-9, two each of
 * skip/reverse/draw-two) = 100, plus 4 wilds and 4 wild draw-fours.
 */
export function buildDeck(tag = 'c') {
  const cards = [];
  let i = 0;
  // Zero-padded so no card id is a prefix of another (r1-1 vs r1-10).
  const card = (color, kind, num = null) =>
    cards.push({ id: `${tag}${String(i++).padStart(3, '0')}`, color, kind, num, chosen: null });

  for (const color of COLORS) {
    card(color, 'num', 0);
    for (let n = 1; n <= 9; n++) {
      card(color, 'num', n);
      card(color, 'num', n);
    }
    for (const kind of ['skip', 'rev', 'draw2']) {
      card(color, kind);
      card(color, kind);
    }
  }
  for (let w = 0; w < 4; w++) {
    card('W', 'wild');
    card('W', 'wild4');
  }
  return cards;
}

/** Fisher-Yates with a CSPRNG. Cheating at cards is a real concern, not a joke. */
export function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/** The colour a card counts as on the table. Wilds answer to their chosen colour. */
export function effectiveColor(card) {
  return card.color === 'W' ? card.chosen : card.color;
}

export function isPlayable(card, top) {
  if (!top) return true;
  if (card.kind === 'wild' || card.kind === 'wild4') return true;
  if (effectiveColor(card) === effectiveColor(top)) return true;
  if (card.kind === 'num' && top.kind === 'num' && card.num === top.num) return true;
  return false;
}

/**
 * Applies a pending draw penalty to a player.
 * Keeps the deck topped up by recycling discards when the draw pile runs dry.
 */
function takeFromDeck(state, count) {
  const drawn = [];
  for (let n = 0; n < count; n++) {
    if (state.draw.length === 0) {
      if (state.discard.length === 0) return drawn; // nothing left anywhere
      state.draw = shuffle(state.discard);
      state.discard = [];
    }
    drawn.push(state.draw.pop());
  }
  return drawn;
}

export function createMatch({ players, targetScore = null, dealerIndex = 0 }) {
  if (!Array.isArray(players) || players.length < 2) {
    throw new Error('need at least two players');
  }
  const state = {
    phase: 'playing', // playing | roundOver | matchOver
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      hand: [],
      score: 0,
      roundWins: 0,
      caughtCount: 0,
      unoCalls: 0,
      saidUno: false,
      connected: true,
    })),
    draw: [],
    discard: [],
    top: null,
    dir: 1,
    turn: 0,
    drawn: null, // card id drawn this turn; only it may be played
    pendingDraw: null, // { n, callerIndex, targetIndex, challengeable, callerColor }
    roundWinner: null,
    roundPoints: 0,
    roundNumber: 1,
    targetScore,
    dealer: dealerIndex,
    log: [],
  };

  dealRound(state);
  return state;
}

export function dealRound(state) {
  const deck = shuffle(buildDeck(`r${state.roundNumber}-`));
  state.draw = deck;
  state.discard = [];
  state.drawn = null;
  state.pendingDraw = null;
  state.roundWinner = null;
  state.roundPoints = 0;
  state.dir = 1;
  state.playsThisRound = 0;
  state.log = [];

  for (const p of state.players) p.hand = []; // fresh deal, previous cards are gone
  for (let i = 0; i < 7; i++) {
    for (const p of state.players) p.hand.push(state.draw.pop());
  }

  // The opening card may not be a wild; put it back and flip again.
  let flip = state.draw.pop();
  while (flip.kind === 'wild' || flip.kind === 'wild4') {
    state.draw.unshift(flip);
    flip = state.draw.pop();
  }
  state.top = flip;
  state.turn = state.dealer % state.players.length;

  note(state, `Round ${state.roundNumber} — ${state.players[state.turn].name} leads.`);
  return state;
}

export function note(state, message) {
  state.log.push(message);
  if (state.log.length > 40) state.log.shift();
}

/** True when `index` is the player whose turn it is. */
export function isTurn(state, index) {
  return state.phase === 'playing' && state.turn === index;
}

export function current(state) {
  return state.players[state.turn];
}

/**
 * What the player whose turn it is is allowed to do right now.
 * A pending draw penalty suspends all normal play until it is paid or challenged.
 */
export function legalActions(state, index) {
  if (state.phase !== 'playing' || state.turn !== index) return [];
  if (state.pendingDraw && state.pendingDraw.targetIndex === index) return ['accept', 'challenge'];
  const acts = [];
  const hand = state.players[index].hand;
  const playable = hand.some((c) => isPlayable(c, state.top));
  if (state.drawn) {
    const c = hand.find((x) => x.id === state.drawn);
    if (c && isPlayable(c, state.top)) acts.push('play', 'pass');
  } else {
    if (playable) acts.push('play');
    acts.push('draw');
  }
  if (unoTargets(state).some((i) => i !== index)) acts.push('catch');
  return acts;
}

/**
 * Plays a card from the player's hand. `chosen` is required for wilds.
 * Returns { ok } or { ok:false, error }.
 */
export function playCard(state, index, cardId, chosen = null) {
  const fail = (error) => ({ ok: false, error });

  if (state.phase !== 'playing') return fail('the round is over');
  if (state.turn !== index) return fail('it is not your turn');

  const penalty = state.pendingDraw;
  if (penalty) return fail('you owe a draw first');

  const player = state.players[index];
  const card = player.hand.find((c) => c.id === cardId);
  if (!card) return fail('that card is not in your hand');

  if (state.drawn && card.id !== state.drawn) return fail('you may only play the card you drew');
  if (!isPlayable(card, state.top)) return fail('that card does not match');

  const isWild = card.kind === 'wild' || card.kind === 'wild4';
  if (isWild) {
    if (!COLORS.includes(chosen)) return fail('pick a colour');
  }

  settleUno(state); // acting before they called it? they pay
  state.playsThisRound++;

  player.hand = player.hand.filter((c) => c.id !== card.id);
  touched(state, index);
  state.drawn = null;
  state.discard.push(state.top);
  state.top = card;
  if (isWild) card.chosen = chosen;

  const label = describeCard(card);
  note(state, `${player.name} played ${label}.`);

  if (player.hand.length === 0) return endRound(state, index);

  const n = state.players.length;
  const next = (i) => ((i + state.dir) % n + n) % n;

  if (state.playsThisRound > MAX_PLAYS) {
    note(state, `Round abandoned after ${MAX_PLAYS} plays — nobody could finish.`);
    return endRound(state, null);
  }

  if (card.kind === 'skip') {
    note(state, `${player.name} skips ${state.players[next(index)].name}.`);
    state.turn = advance(state, 2);
  } else if (card.kind === 'rev') {
    state.dir *= -1;
    if (n === 2) {
      note(state, `Reverse — ${player.name} goes again.`);
      state.turn = index;
    } else {
      note(state, `Reversed. Now ${COLOR_NAMES[chosen] ?? ''} runs the table.`);
      state.turn = advance(state, 1);
    }
  } else if (card.kind === 'draw2') {
    const victim = next(index);
    const got = takeFromDeck(state, 2);
    state.players[victim].hand.push(...got);
    note(state, `${state.players[victim].name} draws 2.`);
    state.turn = advance(state, 2);
  } else if (card.kind === 'wild4') {
    const victim = next(index);
    state.pendingDraw = {
      n: 4,
      callerIndex: index,
      targetIndex: victim,
      challengeable: true,
      // Snapshot: if the caller held the chosen colour, the +4 was illegal.
      callerColor: player.hand.some((c) => effectiveColor(c) === chosen) ? chosen : null,
    };
    state.turn = victim;
    note(state, `${player.name} hit ${state.players[victim].name} with a Wild Draw Four.`);
  } else {
    state.turn = advance(state, 1);
  }

  return { ok: true };
}

/** Draws a single card on your normal turn. */
export function drawCard(state, index) {
  const fail = (error) => ({ ok: false, error });
  if (state.phase !== 'playing') return fail('the round is over');
  if (state.turn !== index) return fail('it is not your turn');
  if (state.pendingDraw) return fail('you owe a draw first');
  if (state.drawn) return fail('you already drew — play that card or end your turn');

  settleUno(state);

  const [card] = takeFromDeck(state, 1);
  if (!card) {
    note(state, 'The draw pile is empty.');
    return endRound(state, null); // nobody can draw; call it a draw
  }

  state.players[index].hand.push(card);
  touched(state, index);
  note(state, `${state.players[index].name} drew a card.`);

  if (state.playsThisRound >= MAX_PLAYS) {
    note(state, `Round abandoned after ${MAX_PLAYS} plays — nobody could finish.`);
    return endRound(state, null);
  }

  if (isPlayable(card, state.top)) {
    state.drawn = card.id; // they may play it, then the turn ends
  } else {
    state.turn = advance(state, 1); // not playable, turn is over
    state.drawn = null;
  }
  return { ok: true, drawn: card.id, playable: state.drawn === card.id };
}

/** Ends your turn after drawing a playable card you chose not to play. */
export function passTurn(state, index) {
  if (state.phase !== 'playing') return { ok: false, error: 'the round is over' };
  if (state.turn !== index) return { ok: false, error: 'it is not your turn' };
  if (!state.drawn) return { ok: false, error: 'you have not drawn' };
  settleUno(state);
  state.drawn = null;
  state.turn = advance(state, 1);
  return { ok: true };
}

/** Accepts a pending draw-two / draw-four penalty. */
export function acceptPenalty(state, index) {
  const pen = state.pendingDraw;
  if (!pen || pen.targetIndex !== index || state.turn !== index) {
    return { ok: false, error: 'no penalty to accept' };
  }
  settleUno(state);
  const got = takeFromDeck(state, pen.n);
  state.players[index].hand.push(...got);
  touched(state, index);
  note(state, `${state.players[index].name} draws ${pen.n}.`);
  state.pendingDraw = null;
  // The turn is already on the payer, so skipping them is one seat onward.
  state.turn = advance(state, 1);
  return { ok: true };
}

/**
 * Challenges a Wild Draw Four.
 * If it was illegal (caller held the chosen colour) the challenger draws 6 and
 * the caller gets the turn back; otherwise the challenger draws 4 and is skipped.
 */
export function challengePenalty(state, index) {
  const pen = state.pendingDraw;
  if (!pen || !pen.challengeable || pen.targetIndex !== index || state.turn !== index) {
    return { ok: false, error: 'nothing to challenge' };
  }
  settleUno(state);
  const challenger = state.players[index];
  const illegal = Boolean(pen.callerColor);

  if (illegal) {
    const got = takeFromDeck(state, 6);
    challenger.hand.push(...got);
    touched(state, index);
    note(state, `Challenge succeeds — ${pen.callerColor} was in hand. ${challenger.name} draws 6.`);
    state.pendingDraw = null;
    state.turn = pen.callerIndex; // caller must now play a legal card
  } else {
    const got = takeFromDeck(state, pen.n);
    challenger.hand.push(...got);
    touched(state, index);
    note(state, `Challenge fails — the +4 was legal. ${challenger.name} draws ${pen.n}.`);
    state.pendingDraw = null;
    state.turn = advance(state, 1); // they paid, so they are skipped
  }
  return { ok: true, illegal };
}

/** The player left holding one card calls UNO before the next player acts. */
export function callUno(state, index) {
  if (state.phase !== 'playing') return { ok: false, error: 'the round is over' };
  if (!unoTargets(state).includes(index)) return { ok: false, error: 'nothing to call' };
  state.players[index].saidUno = true;
  state.players[index].unoCalls++;
  note(state, `${state.players[index].name} called UNO.`);
  return { ok: true };
}

/**
 * The opponent catches you not calling it. Two cards, same as a draw two.
 * With both hands on one card, `targetIndex` says which one you mean.
 */
export function catchUno(state, index, targetIndex = null) {
  if (state.phase !== 'playing') return { ok: false, error: 'the round is over' };
  const targets = unoTargets(state).filter((i) => i !== index);
  if (targets.length === 0) return { ok: false, error: 'nothing to catch' };

  const target = targetIndex === null ? targets[0] : targets[0] === targetIndex ? targetIndex : null;
  if (target === null) return { ok: false, error: 'that player already called it' };

  const guilty = state.players[target];
  guilty.hand.push(...takeFromDeck(state, 2));
  guilty.saidUno = true;
  guilty.caughtCount++;
  note(state, `${state.players[index].name} caught ${guilty.name} — draw 2.`);
  return { ok: true, target };
}

/**
 * Players who are down to a single card and have not called it yet.
 * Derived from the hands rather than tracked by hand, so nobody can slip
 * through by playing into a wildcard edge case.
 */
export function unoTargets(state) {
  if (state.phase !== 'playing') return [];
  const out = [];
  state.players.forEach((p, i) => {
    if (p.hand.length === 1 && !p.saidUno) out.push(i);
  });
  return out;
}

/**
 * Penalty for failing to call UNO: charged the moment somebody acts.
 * Covers both calling late and never calling at all.
 */
function settleUno(state) {
  for (const i of unoTargets(state)) {
    const guilty = state.players[i];
    guilty.hand.push(...takeFromDeck(state, 2));
    guilty.saidUno = true;
    note(state, `${guilty.name} never called it — draw 2.`);
  }
}

/** Any hand change reopens the call requirement. */
function touched(state, index) {
  state.players[index].saidUno = false;
}

function advance(state, steps) {
  const n = state.players.length;
  return ((state.turn + state.dir * steps) % n + n) % n;
}

function endRound(state, winnerIndex) {
  // Nobody can be trusted to keep the turn moving forever: UNO penalties add
  // cards back to the table. Cap the round so a table cannot soft-lock.
  if (winnerIndex === null) {
    state.phase = 'roundOver';
    state.roundWinner = null;
    state.pendingDraw = null;
    note(state, 'Round ends with no winner — the deck ran dry.');
    return { ok: true, winner: null };
  }
  let points = 0;
  for (let i = 0; i < state.players.length; i++) {
    if (i === winnerIndex) continue;
    points += state.players[i].hand.reduce((sum, c) => sum + cardValue(c), 0);
  }
  state.players[winnerIndex].score += points;
  state.players[winnerIndex].roundWins++;
  state.phase = 'roundOver';
  state.roundWinner = winnerIndex;
  state.roundPoints = points;
  state.pendingDraw = null;
  note(state, `${state.players[winnerIndex].name} wins the round and scores ${points}.`);

  if (state.targetScore && state.players[winnerIndex].score >= state.targetScore) {
    state.phase = 'matchOver';
  }
  return { ok: true, winner: winnerIndex, points };
}

/** Deals the next round, rotating the dealer. Cumulative scores carry over. */
export function nextRound(state) {
  if (state.phase === 'matchOver') return { ok: false, error: 'the match is over' };
  state.phase = 'playing';
  state.roundNumber++;
  state.dealer = (state.dealer + 1) % state.players.length;
  dealRound(state);
  return { ok: true };
}

export function describeCard(card) {
  if (card.kind === 'num') return `${COLOR_NAMES[card.color]} ${card.num}`;
  if (card.kind === 'wild') return 'Wild';
  if (card.kind === 'wild4') return 'Wild Draw Four';
  if (card.kind === 'skip') return `${COLOR_NAMES[card.color]} Skip`;
  if (card.kind === 'rev') return `${COLOR_NAMES[card.color]} Reverse`;
  if (card.kind === 'draw2') return `${COLOR_NAMES[card.color]} Draw Two`;
  return 'Card';
}

export function handTotal(player) {
  return player.hand.reduce((sum, c) => sum + cardValue(c), 0);
}

/**
 * The per-player view sent over the wire.
 * Hands are redacted: you get your own cards, everyone else gets only a count.
 * A player who has dropped gets the full list back on reconnect so the table
 * is not a pile of face-down holes after a refresh.
 */
export function viewFor(state, playerId, { includeAllHands = false } = {}) {
  const me = state.players.findIndex((p) => p.id === playerId);
  const myHand = me >= 0 ? state.players[me].hand : [];
  // The server names the legal cards so the UI can never drift from the rules.
  const playable =
    state.phase === 'playing' && state.turn === me && !state.pendingDraw
      ? myHand
          .filter((c) => (!state.drawn || c.id === state.drawn) && isPlayable(c, state.top))
          .map((c) => c.id)
      : [];

  return {
    phase: state.phase,
    roundNumber: state.roundNumber,
    dir: state.dir,
    turn: state.turn,
    top: state.top,
    playable,
    drawn: state.drawn,
    drawCount: state.draw.length,
    discardCount: state.discard.length,
    pendingDraw: state.pendingDraw
      ? { n: state.pendingDraw.n, targetIndex: state.pendingDraw.targetIndex, challengeable: state.pendingDraw.challengeable }
      : null,
    unoOpen: unoTargets(state),
    roundWinner: state.roundWinner,
    roundPoints: state.roundPoints,
    targetScore: state.targetScore,
    myIndex: me,
    legal: me >= 0 ? legalActions(state, me) : [],
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      roundWins: p.roundWins,
      connected: p.connected,
      count: p.hand.length,
      total: handTotal(p),
      isMe: i === me,
      isTurn: i === state.turn,
      canChallengeMe: state.pendingDraw?.callerIndex === i,
      hand:
        i === me || includeAllHands
          ? p.hand.map(serialiseCard)
          : p.hand.map(() => ({ hidden: true })),
    })),
    hand: me >= 0 ? state.players[me].hand.map(serialiseCard) : [],
    log: state.log.slice(-12),
  };
}

export function serialiseCard(card) {
  return { id: card.id, color: card.color, kind: card.kind, num: card.num, chosen: card.chosen };
}