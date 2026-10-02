import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeck,
  cardValue,
  createMatch,
  drawCard,
  playCard,
  passTurn,
  acceptPenalty,
  challengePenalty,
  callUno,
  catchUno,
  nextRound,
  unoTargets,
  isPlayable,
  effectiveColor,
  viewFor,
  describeCard,
} from '../server/game.js';

/** Marks a hand as already having called UNO, so no auto-penalty fires. */
function called(state, ...indices) {
  for (const i of indices) state.players[i].saidUno = true;
  return state;
}

const C = (color, kind, num = null, chosen = null) => ({
  id: `${color}${kind}${num ?? ''}`,
  color,
  kind,
  num,
  chosen,
});

/** A tiny scripted table: fixed hands, no shuffling, no surprises. */
function table({ top = C('R', 'num', 5), hands = [[], []], dir = 1, turn = 0, targetScore = null } = {}) {
  const seat = (id, name, hand) => ({
    id, name, hand, score: 0, roundWins: 0, caughtCount: 0, unoCalls: 0, saidUno: false, connected: true,
  });
  const state = {
    phase: 'playing',
    players: [seat('p0', 'Ana', hands[0]), seat('p1', 'Bo', hands[1])],
    draw: [],
    discard: [],
    top,
    dir,
    turn,
    drawn: null,
    pendingDraw: null,
    unoWindow: null,
    roundWinner: null,
    roundPoints: 0,
    roundNumber: 1,
    targetScore,
    dealer: 0,
    log: [],
  };
  // Stock the pile so a wild is always answerable.
  for (const c of ['R', 'Y', 'G', 'B']) {
    for (let n = 0; n <= 9; n++) state.draw.push(C(c, 'num', n));
  }
  return state;
}

test('deck is 108 cards with the official composition', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 108);
  const count = (kind, color) => deck.filter((c) => c.kind === kind && (color ? c.color === color : true)).length;
  assert.equal(count('num'), 76, 'numbers: 4 colours x (1 zero + 9 pairs)');
  assert.equal(count('wild'), 4);
  assert.equal(count('wild4'), 4);
  for (const kind of ['skip', 'rev', 'draw2']) assert.equal(count(kind), 8, `${kind} x8`);
  assert.equal(deck.filter((c) => c.color === 'W').length, 8, 'the 8 wilds are colourless');
  assert.equal(new Set(deck.map((c) => c.id)).size, 108, 'every card id is unique');
});

test('card values follow the scoring table', () => {
  assert.equal(cardValue(C('R', 'num', 7)), 7);
  assert.equal(cardValue(C('B', 'skip')), 20);
  assert.equal(cardValue(C('G', 'wild')), 50);
  assert.equal(cardValue(C('G', 'wild4')), 50);
});

test('playability: colour, number, and wilds-always', () => {
  const top = C('R', 'num', 5);
  assert.ok(isPlayable(C('R', 'num', 1), top), 'same colour');
  assert.ok(isPlayable(C('R', 'skip'), top), 'same colour action');
  assert.ok(isPlayable(C('B', 'num', 5), top), 'same number');
  assert.ok(!isPlayable(C('B', 'num', 4), top), 'neither colour nor number');
  assert.ok(!isPlayable(C('G', 'draw2'), top), 'an action needs the colour');
  assert.ok(isPlayable(C('W', 'wild'), top));
  assert.ok(isPlayable(C('W', 'wild4'), top));
});

test('a wild makes the table answer to its chosen colour', () => {
  const top = C('W', 'wild', null, 'G');
  assert.equal(effectiveColor(top), 'G');
  assert.ok(isPlayable(C('G', 'num', 3), top));
  assert.ok(!isPlayable(C('R', 'num', 3), top), 'the wilds own colour does not count');
});

test('a wild cannot be played without choosing a colour', () => {
  const s = table({ hands: [[C('W', 'wild'), C('G', 'num', 1)], []] });
  assert.equal(playCard(s, 0, 'Wwild').ok, false, 'no colour given');
  const r = playCard(s, 0, 'Wwild', 'B');
  assert.ok(r.ok);
  assert.equal(effectiveColor(s.top), 'B');
});

test('out-of-turn and out-of-hand plays are rejected', () => {
  const s = table({ hands: [[C('G', 'num', 3)], [C('R', 'num', 2)]], turn: 1 });
  assert.match(playCard(s, 0, 'Gnum3').error, /not your turn/);
  assert.match(playCard(s, 1, 'Rnum9').error, /not in your hand/);
});

test('turn moves to the opponent', () => {
  const s = table({ hands: [[C('R', 'num', 2), C('G', 'num', 1)], []] });
  assert.ok(playCard(s, 0, 'Rnum2').ok);
  assert.equal(s.turn, 1);
});

test('draw two costs the next player 2 cards and skips them', () => {
  const s = table({ hands: [[C('R', 'draw2'), C('G', 'num', 1)], [C('G', 'num', 1), C('Y', 'num', 2)]] });
  const before = s.players[1].hand.length;
  assert.ok(playCard(s, 0, 'Rdraw2').ok);
  assert.equal(s.players[1].hand.length, before + 2);
  assert.equal(s.turn, 0, 'the victim is skipped, turn comes back to the caller');
});

test('skip jumps over the next player', () => {
  const s = table({ hands: [[C('R', 'skip'), C('G', 'num', 1)], [], []] });
  s.players.push({ id: 'p2', name: 'Cy', hand: [], score: 0, roundWins: 0, caughtCount: 0, unoCalls: 0, saidUno: false, connected: true });
  assert.ok(playCard(s, 0, 'Rskip').ok);
  assert.equal(s.turn, 2, 'player 1 is skipped');
});

test('reverse flips direction and acts as a skip with two players', () => {
  const two = table({ hands: [[C('R', 'rev'), C('G', 'num', 1)], []] });
  assert.ok(playCard(two, 0, 'Rrev').ok);
  assert.equal(two.dir, -1);
  assert.equal(two.turn, 0, 'with two players reverse hands the turn back');

  const three = table({ hands: [[C('R', 'rev'), C('G', 'num', 1)], [], []] });
  three.players.push({ id: 'p2', name: 'Cy', hand: [], score: 0, roundWins: 0, caughtCount: 0, unoCalls: 0, saidUno: false, connected: true });
  assert.ok(playCard(three, 0, 'Rrev').ok);
  assert.equal(three.dir, -1);
  assert.equal(three.turn, 2, 'three players: the turn goes one seat backwards');
});

test('drawing a playable card lets you play exactly that card', () => {
  const s = table({ hands: [[C('R', 'num', 2), C('G', 'num', 1)], []] });
  s.draw = [C('R', 'num', 9)]; // red 9 goes down on a red 5
  const r = drawCard(s, 0);
  assert.ok(r.ok);
  assert.ok(r.playable, 'the drawn card is playable');
  assert.ok(s.drawn);
  assert.match(playCard(s, 0, 'Rnum2').error, /only play the card you drew/, 'the old card is locked out');
  assert.ok(playCard(s, 0, s.drawn).ok);
  assert.equal(s.turn, 1);
});

test('drawing an unplayable card ends the turn immediately', () => {
  const s = table({ hands: [[C('G', 'num', 1)], []] });
  s.draw.push(C('Y', 'num', 3)); // yellow 3 cannot go on a red 5
  const r = drawCard(s, 0);
  assert.equal(r.playable, false);
  assert.equal(s.turn, 1, 'turn passed without playing');
  assert.equal(s.drawn, null);
});

test('passTurn gives up the turn after drawing', () => {
  const s = table({ hands: [[C('G', 'num', 1), C('Y', 'num', 2)], []] });
  s.draw = [C('R', 'num', 9)];
  drawCard(s, 0);
  assert.ok(s.drawn);
  assert.ok(passTurn(s, 0).ok);
  assert.equal(s.turn, 1);
});

test('wild draw four: the target accepts and is skipped', () => {
  const s = table({ hands: [[C('W', 'wild4'), C('G', 'num', 1)], [C('G', 'num', 1)]] });
  assert.ok(playCard(s, 0, 'Wwild4', 'B').ok);
  assert.equal(s.turn, 1);
  assert.equal(s.pendingDraw.n, 4);
  assert.match(playCard(s, 1, 'Gnum1').error, /owe a draw/, 'cannot play while a penalty is pending');
  assert.match(drawCard(s, 1).error, /owe a draw/);
  const before = s.players[1].hand.length;
  assert.ok(acceptPenalty(s, 1).ok);
  assert.equal(s.players[1].hand.length, before + 4);
  assert.equal(s.turn, 0, 'the payer is skipped, the caller plays on');
});

test('wild draw four with three players skips to the third seat', () => {
  const s = table({ hands: [[C('W', 'wild4'), C('G', 'num', 1)], [C('G', 'num', 1), C('Y', 'num', 6)], [C('G', 'num', 2), C('B', 'num', 3)]] });
  s.players.push({ id: 'p2', name: 'Cy', hand: [C('G', 'num', 2), C('B', 'num', 3)], score: 0, roundWins: 0, caughtCount: 0, unoCalls: 0, saidUno: false, connected: true });
  playCard(s, 0, 'Wwild4', 'B');
  assert.equal(s.turn, 1, 'the victim must resolve it');
  acceptPenalty(s, 1);
  assert.equal(s.turn, 2, 'the victim paid and is skipped');
});

test('challenge fails when the caller really had no matching colour', () => {
  const s = table({ hands: [[C('W', 'wild4'), C('G', 'num', 1)], []] });
  playCard(s, 0, 'Wwild4', 'B'); // the caller is left holding only a green 1
  assert.equal(s.pendingDraw.callerColor, null, 'no blue in hand, so it was legal');
  const before = s.players[1].hand.length;
  const r = challengePenalty(s, 1);
  assert.ok(r.ok);
  assert.equal(r.illegal, false);
  assert.equal(s.players[1].hand.length, before + 4);
  assert.equal(s.turn, 0, 'still skipped');
});

test('challenge succeeds when the caller was holding the colour they called', () => {
  const s = table({ hands: [[C('W', 'wild4'), C('B', 'num', 2)], []] });
  playCard(s, 0, 'Wwild4', 'B');
  assert.equal(s.pendingDraw.callerColor, 'B', 'blue was in hand, so the +4 was illegal');
  const before = s.players[1].hand.length;
  const r = challengePenalty(s, 1);
  assert.equal(r.illegal, true);
  assert.equal(s.players[1].hand.length, before + 6, 'six cards, not four');
  assert.equal(s.turn, 0, 'the cheater gets the turn back');
  assert.equal(s.pendingDraw, null);
});

test('a draw two cannot be dodged or challenged', () => {
  const s = table({ hands: [[C('R', 'draw2'), C('G', 'num', 1)], [C('G', 'num', 1)]] });
  playCard(s, 0, 'Rdraw2');
  assert.equal(s.pendingDraw, null, 'a draw two resolves immediately, nothing to respond to');
  assert.equal(s.turn, 0);
});

test('UNO: playing down to one card opens the call for you', () => {
  const s = table({ hands: [[C('R', 'num', 2), C('R', 'num', 3)], [C('G', 'num', 1), C('G', 'num', 2)]] });
  playCard(s, 0, 'Rnum2');
  assert.deepEqual(unoTargets(s), [0], 'the player on one card owes a call');
  assert.deepEqual(viewFor(s, 'p0').unoOpen, [0]);
});

test('UNO: calling it clears the call', () => {
  const s = table({ hands: [[C('G', 'num', 3), C('Y', 'num', 4)], [C('G', 'num', 1)]] });
  assert.deepEqual(unoTargets(s), [1]);
  assert.ok(callUno(s, 1).ok);
  assert.deepEqual(unoTargets(s), []);
  assert.equal(s.players[1].unoCalls, 1);
});

test('UNO: you cannot call when you hold more than one card', () => {
  const s = table({ hands: [[C('G', 'num', 3), C('G', 'num', 4)], []] });
  assert.deepEqual(callUno(s, 0).ok, false);
});

test('UNO: failing to call it costs 2 cards when the next player acts', () => {
  const s = table({ hands: [[C('R', 'num', 2), C('R', 'num', 3)], [C('G', 'num', 1), C('G', 'num', 2)]] });
  playCard(s, 0, 'Rnum2');
  assert.deepEqual(unoTargets(s), [0], 'player 0 never called it');
  const before = s.players[0].hand.length;
  drawCard(s, 1);
  assert.equal(s.players[0].hand.length, before + 2, 'auto-penalty applied');
  assert.deepEqual(unoTargets(s), []);
});

test('UNO: calling it before they act prevents the penalty', () => {
  const s = table({ hands: [[C('R', 'num', 2), C('R', 'num', 3)], [C('G', 'num', 1), C('G', 'num', 2)]] });
  playCard(s, 0, 'Rnum2');
  callUno(s, 0);
  const before = s.players[0].hand.length;
  drawCard(s, 1);
  assert.equal(s.players[0].hand.length, before, 'no penalty after a proper call');
});

test('UNO: the catch button applies the same 2-card penalty', () => {
  const s = table({ hands: [[C('G', 'num', 3)], [C('G', 'num', 1), C('G', 'num', 2)]] });
  assert.deepEqual(unoTargets(s), [0]);
  const before = s.players[0].hand.length;
  assert.ok(catchUno(s, 1).ok);
  assert.equal(s.players[0].hand.length, before + 2);
  assert.equal(s.players[0].caughtCount, 1);
  assert.deepEqual(unoTargets(s), []);
});

test('you cannot catch your own hand', () => {
  const s = table({ hands: [[C('G', 'num', 3)], [C('G', 'num', 1), C('G', 'num', 2)]] });
  assert.equal(catchUno(s, 0).ok, false);
});

test('UNO: drawing your second card cancels the call, no penalty', () => {
  const s = table({ hands: [[C('G', 'num', 3)], [C('G', 'num', 1), C('G', 'num', 2)]] });
  s.draw = [C('Y', 'num', 1)];
  drawCard(s, 0);
  assert.deepEqual(unoTargets(s), [], 'two cards means no call is owed');
});

test('going out ends the round and scores the remaining cards', () => {
  const s = called(
    table({ hands: [[C('R', 'num', 2)], [C('G', 'num', 9), C('Y', 'skip'), C('W', 'wild')]] }),
    0,
  );
  assert.ok(playCard(s, 0, 'Rnum2').ok);
  assert.equal(s.phase, 'roundOver');
  assert.equal(s.roundWinner, 0);
  assert.equal(s.roundPoints, 9 + 20 + 50);
  assert.equal(s.players[0].score, 79);
  assert.equal(s.players[0].roundWins, 1);
});

test('the winner is not charged an UNO penalty', () => {
  const s = called(table({ hands: [[C('R', 'num', 2)], [C('G', 'num', 9), C('Y', 'num', 4)]] }), 0);
  playCard(s, 0, 'Rnum2');
  assert.equal(s.players[0].hand.length, 0, 'hand is empty, nobody is sitting on one card');
  assert.equal(s.phase, 'roundOver');
});

test('rounds chain endlessly and carry scores forward', () => {
  const m = createMatch({ players: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo' }] });
  assert.equal(m.players[0].hand.length, 7);
  assert.equal(m.players[1].hand.length, 7);
  assert.notEqual(m.top.kind, 'wild', 'the opening card is never a wild');
  assert.notEqual(m.top.kind, 'wild4');
  assert.equal(m.roundNumber, 1);
  m.players[0].score = 120;

  assert.ok(nextRound(m).ok);
  assert.equal(m.roundNumber, 2);
  assert.equal(m.players[0].score, 120, 'scores persist across rounds');
  assert.equal(m.players[0].hand.length, 7, 'fresh hands');
  assert.equal(m.dealer, 1, 'the dealer rotates');
  assert.equal(m.discard.length, 0);
  assert.equal(m.phase, 'playing');
});

test('the deal never creates or loses a card', () => {
  const m = createMatch({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  const all = [...m.players.flatMap((p) => p.hand), m.top, ...m.draw];
  assert.equal(all.length, 108);
  assert.equal(new Set(all.map((c) => c.id)).size, 108);
});

test('the draw pile recycles the discard when it runs out', () => {
  const s = table({ hands: [[C('R', 'num', 2), C('G', 'num', 1)], [C('G', 'num', 1), C('Y', 'num', 6)]] });
  s.draw = [];
  s.discard = [C('Y', 'num', 2), C('G', 'num', 3), C('B', 'num', 4)];
  playCard(s, 0, 'Rnum2'); // pushes the old top into the discard
  const before = s.players[1].hand.length;
  drawCard(s, 1);
  assert.ok(s.players[1].hand.length > before, 'drew from the recycled discard');
});

test('a wild is answered by every colour and always needs one', () => {
  for (const colour of ['R', 'Y', 'G', 'B']) {
    const s = table({ hands: [[C('W', 'wild'), C('G', 'num', 1)], []] });
    assert.ok(playCard(s, 0, 'Wwild', colour).ok, colour);
    assert.equal(effectiveColor(s.top), colour);
  }
});

test('descriptions are human-readable', () => {
  assert.equal(describeCard(C('R', 'num', 5)), 'Red 5');
  assert.equal(describeCard(C('B', 'skip')), 'Blue Skip');
  assert.equal(describeCard(C('G', 'rev')), 'Green Reverse');
  assert.equal(describeCard(C('W', 'wild')), 'Wild');
  assert.equal(describeCard(C('W', 'wild4')), 'Wild Draw Four');
});

test('hands are redacted in the wire view — only your own cards are readable', () => {
  const s = createMatch({ players: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo' }] });
  const view = viewFor(s, 'a');
  const opponent = view.players.find((p) => p.id === 'b');

  assert.equal(opponent.count, 7, 'you learn how many cards they hold');
  assert.ok(opponent.hand.every((c) => c.hidden === true), 'no card contents leak');
  assert.equal(JSON.stringify(opponent.hand).includes('"color"'), false);
  assert.equal(JSON.stringify(opponent.hand).includes('"num"'), false);

  const mine = view.players.find((p) => p.id === 'a');
  assert.ok(mine.hand.every((c) => c.id && c.color), 'you get your own cards in full');
  assert.equal(view.hand.length, 7);
});

test('no opponent card id ever appears in a player view', () => {
  const s = createMatch({ players: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo' }] });
  const boIds = s.players[1].hand.map((c) => c.id);
  const wire = JSON.stringify(viewFor(s, 'a'));
  for (const id of boIds) assert.equal(wire.includes(id), false, `leaked ${id}`);
});

test('the draw pile contents never leak through the view', () => {
  const s = createMatch({ players: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo' }] });
  const wire = JSON.stringify(viewFor(s, 'a'));
  for (const c of s.draw) assert.equal(wire.includes(c.id), false, `leaked deck card ${c.id}`);
});

test('a reconnecting player can be given the full table for recovery', () => {
  const s = createMatch({ players: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo' }] });
  const full = viewFor(s, 'a', { includeAllHands: true });
  assert.equal(full.players[1].hand[0].hidden, undefined, 'the full view un-redacts');
  assert.ok(full.players[1].hand[0].id);
});

test('legal actions reflect a pending penalty', () => {
  const s = table({ hands: [[C('W', 'wild4'), C('G', 'num', 1)], [C('G', 'num', 1), C('Y', 'num', 6)]] });
  playCard(s, 0, 'Wwild4', 'B');
  assert.deepEqual(viewFor(s, 'p1').legal, ['accept', 'challenge']);
  s.pendingDraw = null;
  s.turn = 1;
  assert.ok(viewFor(s, 'p1').legal.includes('draw'));
});

test('legal actions show only the drawn card is playable after drawing', () => {
  const s = table({ hands: [[C('R', 'num', 2), C('G', 'num', 1), C('Y', 'num', 4)], []] });
  s.draw = [C('R', 'num', 9)];
  drawCard(s, 0);
  assert.ok(s.drawn);
  assert.deepEqual(viewFor(s, 'p0').legal, ['play', 'pass']);
});

test('a match to a target score ends instead of looping forever', () => {
  const s = called(table({ hands: [[C('R', 'num', 2)], [C('W', 'wild')]], targetScore: 50 }), 0);
  assert.ok(playCard(s, 0, 'Rnum2').ok);
  assert.equal(s.phase, 'matchOver');
  assert.equal(nextRound(s).ok, false);
});

test('playing from the wrong seat never mutates the state', () => {
  const s = table({ hands: [[C('R', 'num', 2), C('G', 'num', 1)], [C('G', 'num', 1), C('Y', 'num', 6)]] });
  const snap = JSON.stringify(s.players.map((p) => p.hand.map((c) => c.id)));
  playCard(s, 1, 'Gnum1');
  drawCard(s, 1);
  acceptPenalty(s, 1);
  assert.equal(JSON.stringify(s.players.map((p) => p.hand.map((c) => c.id))), snap);
  assert.equal(s.turn, 0);
});

test('a legal game plays to completion with no stuck turns', () => {
  for (let trial = 0; trial < 25; trial++) {
    const m = createMatch({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    let guard = 0;
    while (m.phase === 'playing' && guard++ < 5000) {
      const i = m.turn;
      const me = m.players[i];
      let acted = false;
      if (m.pendingDraw) acted = acceptPenalty(m, i).ok;
      else if (unoTargets(m).includes(i)) acted = callUno(m, i).ok;
      if (!acted) {
        const playable = me.hand.filter((c) => isPlayable(c, m.top));
        const legal = playable.filter((c) => !m.drawn || c.id === m.drawn);
        if (legal.length) {
          const card = legal[0];
          if (playCard(m, i, card.id, card.color === 'W' ? 'R' : null).ok) acted = true;
        } else if (!m.drawn && drawCard(m, i).ok) acted = true;
        else if (passTurn(m, i).ok) acted = true;
      }
      assert.ok(acted, `player ${i} had no legal move but the game was still live`);
    }
    assert.ok(guard < 5000, `trial ${trial} never terminated`);
    assert.ok(m.phase === 'roundOver' || m.phase === 'matchOver', `trial ${trial} ended in ${m.phase}`);
    if (m.roundWinner !== null) {
      assert.ok(m.players[m.roundWinner].score > 0, `trial ${trial} had a winner but no score`);
    }
    assert.ok(m.players.every((p) => p.hand.length >= 0));
  }
});

test('hands stay consistent: every card is in exactly one place', () => {
  const m = createMatch({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  for (let step = 0; step < 300 && m.phase === 'playing'; step++) {
    const i = m.turn;
    const me = m.players[i];
    if (m.pendingDraw) acceptPenalty(m, i);
    else if (unoTargets(m).some((t) => t !== i)) catchUno(m, i);
    else {
      const playable = me.hand.filter((c) => isPlayable(c, m.top));
      const legal = playable.filter((c) => !m.drawn || c.id === m.drawn);
      if (legal.length) playCard(m, i, legal[0].id, legal[0].color === 'W' ? 'B' : null);
      else if (!m.drawn) drawCard(m, i);
      else passTurn(m, i);
    }

    const all = [...m.players.flatMap((p) => p.hand), m.top, ...m.draw, ...m.discard];
    assert.equal(all.length, 108, `step ${step}: card count drifted`);
    assert.equal(new Set(all.map((c) => c.id)).size, 108, `step ${step}: a card was duplicated`);
  }
});