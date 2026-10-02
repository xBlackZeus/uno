/**
 * End-to-end: two real WebSocket clients, a real HTTP server, the real protocol.
 *
 * The engine tests prove the rules; this proves the wiring — that a browser can
 * create a room, a second browser can join by code, moves travel both ways,
 * hands stay hidden, and the link survives a reconnect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WebSocket } from 'ws';

import {
  createRoom,
  getRoom,
  addPlayer,
  applyAction,
  viewForSeat,
  startIfReady,
  sweep,
  removeSeat,
} from '../server/rooms.js';
import { isPlayable } from '../server/game.js';

// ── A tiny scripted client ─────────────────────────────
function client(roomCode, name) {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  const waiters = [];

  sock.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) waiters.splice(i, 1)[0].resolve(msg);
    }
  });

  const api = {
    sock,
    name,
    inbox,
    send: (m) => sock.send(JSON.stringify(m)),
    /** Waits for the newest message matching a predicate. */
    next(match, label = 'message') {
      for (let i = inbox.length - 1; i >= 0; i--) {
        if (match(inbox[i])) return Promise.resolve(inbox.splice(i, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 4000);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    /** Throws away anything already queued, so the next wait() is for a NEW message. */
    drain() {
      inbox.length = 0;
    },
    joined: () => api.next((m) => m.t === 'joined', 'joined'),
    state: () => api.next((m) => m.t === 'state', 'state'),
    error: () => api.next((m) => m.t === 'error', 'error'),
    async open() {
      if (sock.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => {
        sock.once('open', resolve);
        sock.once('error', reject);
      });
    },
    close: () => new Promise((resolve) => {
      if (sock.readyState === WebSocket.CLOSED) return resolve();
      sock.once('close', resolve);
      sock.close();
    }),
  };
  void roomCode;
  return api;
}

/** Plays a legal move for whoever is on turn. Returns what it did. */
function takeTurn(c, view) {
  const i = view.turn;
  if (view.unoOpen && view.unoOpen.includes(view.myIndex)) {
    c.send({ t: 'action', action: 'uno' });
    return 'uno';
  }
  if (view.pendingDraw && view.pendingDraw.targetIndex === i) {
    c.send({ t: 'action', action: 'accept' });
    return 'accept';
  }
  const card = chooseCard(view);
  if (card) {
    c.send({
      t: 'action',
      action: 'play',
      cardId: card.id,
      color: card.color === 'W' ? 'R' : undefined,
    });
    return 'play';
  }
  if (view.drawn) {
    c.send({ t: 'action', action: 'pass' });
    return 'pass';
  }
  c.send({ t: 'action', action: 'draw' });
  return 'draw';
}


/**
 * Picks a card the way a person does: if two different colours are playable,
 * switch colour rather than feeding the same pile forever. Playing one colour
 * for 400 turns in a row is what makes a round stall.
 */
function chooseCard(view) {
  const playable = view.hand.filter((x) => view.playable.includes(x.id));
  if (playable.length === 0) return null;
  const tableColour = view.top?.color === 'W' ? view.top?.chosen : view.top?.color;
  const different = playable.find((c) => (c.color === 'W' ? null : c.color) !== tableColour);
  return different ?? playable[0];
}

const PORT = 3101;
let base;

test.before(async () => {
  process.env.PORT = String(PORT);
  const mod = await import('../server/index.js');
  base = `http://127.0.0.1:${PORT}`;
  await new Promise((resolve) => setTimeout(resolve, 150));
  void mod;
});

test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.exit(0);
});

test('the server serves the client shell', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /UNO/);
});

test('the friendly /room/CODE path redirects to the working invite URL', async () => {
  const res = await fetch(`${base}/room/ABCD`, { redirect: 'manual' });
  assert.equal(res.status, 302, 'it redirects rather than serving HTML in place');
  assert.equal(res.headers.get('location'), '/?room=ABCD', 'the code survives the redirect');

  // Following it must land on the shell with its assets reachable from the root.
  const page = await fetch(`${base}/room/ABCD`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="joinForm"/);
  assert.equal((await fetch(`${base}/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
});

test('unknown routes fall back to the shell instead of 404', async () => {
  const res = await fetch(`${base}/some/deep/path`);
  assert.equal(res.status, 200);
});

test('server sources are never web-readable', async () => {
  const attempts = [
    '/server/game.js',
    '/../server/game.js',
    '/%2e%2e%2fserver%2fgame.js',
    '/..%2fserver/game.js',
    '/public/../server/rooms.js',
  ];
  for (const attempt of attempts) {
    const res = await fetch(base + attempt, { redirect: 'manual' });
    const body = await res.text();
    assert.doesNotMatch(body, /export function|createMatch|WebSocketServer/, `${attempt} leaked server source`);
    assert.doesNotMatch(body, /require\(|node:crypto/, `${attempt} leaked server source`);
  }
});

test('health endpoint reports ok', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, rooms: (await (await fetch(`${base}/healthz`)).json()).rooms });
});

test('a player can create a game and get a shareable code', async () => {
  const a = client('x', 'Ana');
  await a.open();
  a.send({ t: 'create', name: 'Ana' });
  const msg = await a.joined();

  assert.match(msg.code, /^[A-Z0-9]{4}$/, 'four unambiguous characters');
  assert.ok(msg.token, 'a resume token is issued');
  assert.equal(msg.view.waiting, true, 'no game until a second player arrives');
  await a.close();
});

test('a second player joins by code and the game deals', async () => {
  const a = client('x', 'Ana');
  const b = client('x', 'Bo');
  await a.open();
  await b.open();

  a.send({ t: 'create', name: 'Ana' });
  const joinedA = await a.joined();

  a.drain();
  b.send({ t: 'join', code: joinedA.code, name: 'Bo' });
  const joinedB = await b.joined();

  assert.equal(joinedB.code, joinedA.code);
  assert.notEqual(joinedB.you, joinedA.you, 'two distinct seats');
  assert.equal(joinedB.view.waiting, false, 'the game starts');
  assert.equal(joinedB.view.hand.length, 7, 'seven cards each');
  assert.ok(joinedB.view.top, 'there is a card on the table');
  assert.notEqual(joinedB.view.top.kind, 'wild', 'the flip is never a wild');

  // The host is told about the deal through a follow-up state.
  const hostView = await a.state();
  assert.equal(hostView.view.waiting, false);
  assert.equal(hostView.view.hand.length, 7, 'the host was dealt in too');
  assert.equal(hostView.view.top.id, joinedB.view.top.id, 'both see the same table card');

  await a.close();
  await b.close();
});

test('a third player is refused', async () => {
  const a = client('x', 'Ana');
  const b = client('x', 'Bo');
  const c = client('x', 'Cy');
  await Promise.all([a.open(), b.open(), c.open()]);

  a.send({ t: 'create', name: 'Ana' });
  const code = (await a.joined()).code;
  a.drain();
  b.send({ t: 'join', code, name: 'Bo' });
  await b.joined();
  c.send({ t: 'join', code, name: 'Cy' });
  const err = await c.error();
  assert.match(err.message, /two players/i);

  await Promise.all([a.close(), b.close(), c.close()]);
});

test('an unknown code is reported clearly', async () => {
  const a = client('x', 'Ana');
  await a.open();
  a.send({ t: 'join', code: 'ZZZZ', name: 'Ana' });
  assert.match((await a.error()).message, /No game with that code/);
  await a.close();
});

test('a name is trimmed, capped and stripped of control characters', async () => {
  const a = client('x', 'Ana');
  await a.open();
  a.send({ t: 'create', name: '  Ana   ' });
  const msg = await a.joined();
  assert.equal(msg.view.players[0].name, 'Ana');
  await a.close();
});

test('a very long name is truncated rather than rejected', async () => {
  const a = client('x', 'Ana');
  await a.open();
  a.send({ t: 'create', name: 'x'.repeat(200) });
  const msg = await a.joined();
  assert.equal(msg.view.players[0].name.length, 16);
  await a.close();
});

test('malformed JSON does not kill the connection', async () => {
  const a = client('x', 'Ana');
  await a.open();
  a.sock.send('this is not json');
  a.send({ t: 'create', name: 'Ana' });
  const msg = await a.joined();
  assert.ok(msg.code);
  await a.close();
});

test('actions are refused before joining a game', async () => {
  const a = client('x', 'Ana');
  await a.open();
  a.send({ t: 'action', action: 'play', cardId: 'nope' });
  assert.match((await a.error()).message, /Join a game first/);
  await a.close();
});

test('two clients play real moves against each other', async () => {
  const a = client('x', 'Ana');
  const b = client('x', 'Bo');
  await a.open();
  await b.open();

  a.send({ t: 'create', name: 'Ana' });
  const code = (await a.joined()).code;
  a.drain();
  b.send({ t: 'join', code, name: 'Bo' });
  await b.joined();

  let va = (await a.state()).view;
  let vb = (await b.state()).view;
  assert.equal(va.waiting, false, 'the host is in the game');
  assert.equal(vb.waiting, false);

  for (let step = 0; step < 16; step++) {
    const aMoves = va.turn === va.myIndex;
    const who = aMoves ? a : b;
    // Clear both inboxes: the only traffic left will be this move's broadcast.
    a.drain();
    b.drain();
    takeTurn(who, aMoves ? va : vb);

    const aUpdate = await a.state();
    const bUpdate = await b.state();
    va = aUpdate.view;
    vb = bUpdate.view;
    assert.equal(va.top.id, vb.top.id, `step ${step}: the clients disagree about the table`);
    assert.equal(va.turn, vb.turn, `step ${step}: the clients disagree about the turn`);
    assert.equal(va.drawCount, vb.drawCount, `step ${step}: the draw pile disagrees`);
  }

  // Nobody can read the other hand.
  for (const [view, name] of [[va, 'Ana'], [vb, 'Bo']]) {
    const other = view.players.find((p) => !p.isMe);
    assert.ok(other.hand.every((c) => c.hidden === true), `${name} can read the other hand`);
    assert.equal(other.hand.length, other.count, `${name} sees a wrong card count`);
    assert.equal(typeof other.total, 'number', 'the point value of a hidden hand is public');
  }

  await a.close();
  await b.close();
});

test('an opponent card id never crosses the wire', async () => {
  const a = client('x', 'Ana');
  const b = client('x', 'Bo');
  await a.open();
  await b.open();

  a.send({ t: 'create', name: 'Ana' });
  const code = (await a.joined()).code;
  a.drain();
  b.send({ t: 'join', code, name: 'Bo' });
  const joinedB = await b.joined();

  // Bo knows his own seven cards. Ana must learn nothing about them.
  const boCardIds = joinedB.view.hand.map((c) => c.id);
  assert.equal(boCardIds.length, 7);

  const update = await a.state();
  const wire = JSON.stringify(update);
  for (const id of boCardIds) {
    assert.equal(wire.includes(id), false, `Bo's card ${id} leaked to Ana`);
  }
  assert.equal(update.view.players.find((p) => !p.isMe).count, 7, 'but the count is public');

  await a.close();
  await b.close();
});

test('an illegal move is refused and changes nothing', async () => {
  const a = client('x', 'Ana');
  const b = client('x', 'Bo');
  await a.open();
  await b.open();

  a.send({ t: 'create', name: 'Ana' });
  const code = (await a.joined()).code;
  a.drain();
  b.send({ t: 'join', code, name: 'Bo' });
  const joinedB = await b.joined();

  // B is probably not on turn; playing anyway must be refused.
  const notMine = joinedB.view.hand.find((card) => !joinedB.view.playable.includes(card.id));
  if (notMine) {
    b.send({ t: 'action', action: 'play', cardId: notMine.id });
    const err = await b.error();
    assert.ok(err.message, 'the client is told why');
    const after = await a.state();
    assert.equal(after.view.players.find((p) => p.id === joinedB.you).count, joinedB.view.players.find((p) => p.id === joinedB.you).count);
  }

  // And a card id that is not in the hand at all.
  b.send({ t: 'action', action: 'play', cardId: 'definitely-not-a-card' });
  const err2 = await b.error();
  assert.match(err2.message, /not your turn|not in your hand/);

  await a.close();
  await b.close();
});

test('a dropped player keeps their seat and gets their hand back', async () => {
  const a = client('x', 'Ana');
  const b = client('x', 'Bo');
  await a.open();
  await b.open();

  a.send({ t: 'create', name: 'Ana' });
  const code = (await a.joined()).code;
  a.drain();
  b.send({ t: 'join', code, name: 'Bo' });
  const joinedB = await b.joined();
  const handBefore = joinedB.view.hand.map((c) => c.id).sort();
  await a.state(); // consume the post-join broadcast

  // B's connection drops. The server notices asynchronously, so poll briefly.
  await b.close();
  let bSeat = null;
  for (let tries = 0; tries < 25; tries++) {
    const after = await a.state();
    bSeat = after.view.players.find((p) => p.id === joinedB.you);
    if (bSeat.connected === false) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(bSeat.connected, false, 'A sees that their friend left');

  // B comes back with the token.
  const b2 = client('x', 'Bo');
  await b2.open();
  b2.send({ t: 'join', code, name: 'Bo', token: joinedB.token });
  const rejoined = await b2.joined();
  assert.equal(rejoined.rejoined, true, 'the seat was reclaimed');
  assert.equal(rejoined.you, joinedB.you, 'same seat, same identity');
  const handAfter = rejoined.view.hand.map((c) => c.id).sort();
  assert.deepEqual(handAfter, handBefore, 'their cards came back exactly');

  await a.close();
  await b2.close();
});

test('reopening in another tab replaces the old socket', async () => {
  const a = client('x', 'Ana');
  await a.open();
  a.send({ t: 'create', name: 'Ana' });
  const joined = await a.joined();

  const a2 = client('x', 'Ana');
  await a2.open();
  a2.send({ t: 'join', code: joined.code, name: 'Ana', token: joined.token });
  const again = await a2.joined();
  assert.equal(again.you, joined.you);
  assert.equal(again.rejoined, true);

  const replaced = await a.next((m) => m.t === 'replaced', 'replaced');
  assert.equal(replaced.t, 'replaced');

  await a2.close();
});

test('leaving removes the seat, and an empty room is deleted', async () => {
  const a = client('x', 'Ana');
  const b = client('x', 'Bo');
  await a.open();
  await b.open();

  a.send({ t: 'create', name: 'Ana' });
  const code = (await a.joined()).code;
  a.drain();
  b.send({ t: 'join', code, name: 'Bo' });
  await b.joined();

  a.send({ t: 'leave' });
  await a.close();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(getRoom(code).seats.length, 1, 'one seat left');

  b.send({ t: 'leave' });
  await b.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(getRoom(code), null, 'the room was cleaned up');
});

test('an unknown action is rejected without side effects', async () => {
  const a = client('x', 'Ana');
  const b = client('x', 'Bo');
  await a.open();
  await b.open();
  a.send({ t: 'create', name: 'Ana' });
  const code = (await a.joined()).code;
  a.drain();
  b.send({ t: 'join', code, name: 'Bo' });
  await b.joined();

  b.send({ t: 'action', action: 'teleport' });
  assert.match((await b.error()).message, /Unknown action/);

  await a.close();
  await b.close();
});

test('oversized messages are rejected by the socket', async () => {
  const a = client('x', 'Ana');
  await a.open();
  a.sock.send(JSON.stringify({ t: 'create', name: 'x'.repeat(50_000) }));
  // The socket is closed by the server for exceeding maxPayload.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(a.sock.readyState, WebSocket.CLOSED, 'the connection was dropped');
});

// ── Room manager units (no sockets needed) ────────────
test('a room holds at most two seats', () => {
  const room = createRoom({});
  assert.ok(addPlayer(room, { name: 'A' }).seat);
  assert.ok(addPlayer(room, { name: 'B' }).seat);
  assert.match(addPlayer(room, { name: 'C' }).error, /two players/);
  assert.equal(room.seats.length, 2);
});

test('a token reclaims the same seat instead of taking a new one', () => {
  const room = createRoom({});
  const first = addPlayer(room, { name: 'A' });
  const again = addPlayer(room, { name: 'A', token: first.seat.token });
  assert.equal(again.rejoined, true);
  assert.equal(again.seat.id, first.seat.id);
  assert.equal(room.seats.length, 1, 'no duplicate seat was created');
});

test('a bad token does not reclaim a seat', () => {
  const room = createRoom({});
  addPlayer(room, { name: 'A' });
  const stranger = addPlayer(room, { name: 'A', token: 'not-a-real-token' });
  assert.equal(stranger.rejoined, false);
  assert.equal(room.seats.length, 2);
});

test('codes are four characters and never collide with live rooms', () => {
  const rooms = Array.from({ length: 40 }, () => createRoom({}));
  const codes = rooms.map((r) => r.code);
  assert.equal(new Set(codes).size, codes.length, 'no duplicate codes handed out');
  for (const c of codes) {
    assert.equal(c.length, 4);
    assert.doesNotMatch(c, /[O0I1]/, 'no characters that are read wrong');
  }
});

test('the game does not start with one player', () => {
  const room = createRoom({});
  addPlayer(room, { name: 'A' });
  assert.equal(startIfReady(room), false);
  assert.equal(room.state, null);
  addPlayer(room, { name: 'B' });
  assert.equal(startIfReady(room), true);
  assert.equal(room.state.players.length, 2);
});

test('a re-seated player keeps their identity across a full sync', () => {
  const room = createRoom({});
  const a = addPlayer(room, { name: 'Ana' }).seat;
  addPlayer(room, { name: 'Bo' });
  startIfReady(room);

  const redacted = viewForSeat(room, a);
  const full = viewForSeat(room, a, { full: true });
  assert.ok(full.players.find((p) => !p.isMe).hand[0].id, 'full view shows every card');
  assert.ok(redacted.players.find((p) => !p.isMe).hand[0].hidden, 'normal view hides them');
});

test('sweeping drops expired seats but keeps live ones', () => {
  const room = createRoom({});
  const live = addPlayer(room, { name: 'Live' }).seat;
  const gone = addPlayer(room, { name: 'Gone' }).seat;
  room.seats.push(gone, { ...live }); // one live, one long-gone
  room.seats.splice(0, 1); // drop the first seat
  room.seats[1].droppedAt = Date.now() - 60 * 60 * 1000;
  sweep();
  assert.ok(getRoom(room.code), 'the room survives while someone is in it');
  assert.equal(room.seats.length, 1, 'only the live seat remains');
});

test('removing a seat empties the room and deletes it', () => {
  const room = createRoom({});
  const seat = addPlayer(room, { name: 'A' }).seat;
  removeSeat(room, seat);
  assert.equal(getRoom(room.code), null);
});

test('rounds keep going for as long as both players want', () => {
  const room = createRoom({});
  const a = addPlayer(room, { name: 'Ana' }).seat;
  const b = addPlayer(room, { name: 'Bo' }).seat;
  startIfReady(room);

  // Drive three complete rounds through the same seam the sockets use.
  for (let round = 1; round <= 3; round++) {
    let guard = 0;
    while (room.state.phase === 'playing' && guard++ < 900) {
      const seat = room.state.turn === 0 ? a : b;
      const view = viewForSeat(room, seat);
      // A person calls UNO. A bot that never calls it just feeds the penalties.
      if (view.unoOpen && view.unoOpen.includes(view.myIndex) && applyAction(room, seat, { action: 'uno' }).ok) continue;

      let msg;
      if (view.pendingDraw && view.pendingDraw.targetIndex === view.myIndex) {
        msg = { action: 'accept' };
      } else {
        const card = chooseCard(view);
        msg = card
          ? { action: 'play', cardId: card.id, color: card.color === 'W' ? 'R' : undefined }
          : { action: 'draw' };
        if (!card && view.drawn) msg = { action: 'pass' };
      }
      const result = applyAction(room, seat, msg);
      assert.ok(result.ok, `round ${round} move was refused: ${result.error}`);
    }
    assert.equal(room.state.phase, 'roundOver', `round ${round} finished`);
    assert.equal(room.state.roundNumber, round);
    assert.ok(applyAction(room, a, { action: 'nextRound' }).ok, 'the next round starts');
  }

  assert.ok(room.state.players.some((p) => p.score > 0), 'scores accumulated across rounds');
  assert.equal(room.state.players.every((p) => p.hand.length === 7), true, 'every round deals 7 again');
});

test('every card is accounted for after several rounds', () => {
  const room = createRoom({});
  const a = addPlayer(room, { name: 'Ana' }).seat;
  const b = addPlayer(room, { name: 'Bo' }).seat;
  startIfReady(room);

  for (let round = 0; round < 2; round++) {
    let guard = 0;
    while (room.state.phase === 'playing' && guard++ < 900) {
      const seat = room.state.turn === 0 ? a : b;
      const view = viewForSeat(room, seat);
      if (view.unoOpen && view.unoOpen.includes(view.myIndex) && applyAction(room, seat, { action: 'uno' }).ok) continue;

      let msg;
      if (view.pendingDraw && view.pendingDraw.targetIndex === view.myIndex) {
        msg = { action: 'accept' };
      } else {
        const card = chooseCard(view);
        msg = card
          ? { action: 'play', cardId: card.id, color: card.color === 'W' ? 'R' : undefined }
          : view.drawn
            ? { action: 'pass' }
            : { action: 'draw' };
      }
      const r = applyAction(room, seat, msg);
      assert.ok(r.ok, `a scripted move was refused: ${r.error}`);
      const all = [
        ...room.state.players.flatMap((p) => p.hand),
        room.state.top,
        ...room.state.draw,
        ...room.state.discard,
      ];
      assert.equal(all.length, 108, `round ${round}: a card went missing`);
      assert.equal(new Set(all.map((c) => c.id)).size, 108, `round ${round}: a card was cloned`);
    }
    applyAction(room, a, { action: 'nextRound' });
  }
});
