/**
 * HTTP + WebSocket entry point.
 *
 * Serves the client from ./public and speaks the game protocol on /ws.
 * Every rule decision happens on this side; the browser only sends intents.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

import {
  createRoom,
  getRoom,
  addPlayer,
  startIfReady,
  detachSeat,
  removeSeat,
  applyAction,
  addChat,
  viewForSeat,
  sweep,
  roomCount,
  MIN_SEATS,
  MAX_SEATS,
} from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_MESSAGE_BYTES = 8 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: roomCount() }));
      return;
    }

    // /room/ABCD is a friendlier way to write the invite. Redirect it to the
    // query-string form rather than serving the shell in place, otherwise the
    // browser resolves style.css against /room/ and gets HTML instead of CSS.
    if (/^\/room\/[A-Za-z0-9]{4}\/?$/.test(url.pathname)) {
      res.writeHead(302, { location: `${url.pathname.replace(/\/room\/[A-Za-z0-9]{4}\/?$/, '')}/?room=${url.pathname.split('/').pop().toUpperCase()}` });
      res.end();
      return;
    }

    const pathname = decodeURIComponent(url.pathname);

    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(PUBLIC_DIR, safe === '/' ? 'index.html' : safe);
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let stat = await fsp.stat(file).catch(() => null);
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fsp.stat(file).catch(() => null);
    }
    if (!stat) {
      // Single page app: unknown paths fall back to the shell.
      file = path.join(PUBLIC_DIR, 'index.html');
      stat = await fsp.stat(file).catch(() => null);
      if (!stat) {
        res.writeHead(404).end('not found');
        return;
      }
    }

    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': path.basename(file) === 'config.js' ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500).end('server error');
    console.error('http error', err);
  }
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES,
  // Chat and card state are highly repetitive, so they compress very well.
  // Chat is the only chatty traffic this server sees, so this is most of the
  // data saving available without changing the protocol.
  perMessageDeflate: { threshold: 256, zlibDeflateLevel: 6 },
});

function send(socket, payload) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '') // strip control characters
    .trim()
    .slice(0, 16);
  return name || 'Player';
}

function broadcastRoom(room) {
  for (const seat of room.seats) {
    if (!seat.socket) continue;
    send(seat.socket, { t: 'state', view: viewForSeat(room, seat) });
  }
}

/** Cheaper than broadcastRoom when the board has not changed. */
function broadcastLobby(room) {
  for (const seat of room.seats) {
    if (!seat.socket) continue;
    send(seat.socket, { t: 'state', view: viewForSeat(room, seat) });
  }
}

/**
 * Chat goes to everyone as its own small message. It deliberately does not carry
 * the board: text is the most frequent traffic here and would otherwise make
 * every sentence cost a full state push.
 */
function broadcastChat(room, entry) {
  for (const seat of room.seats) {
    if (!seat.socket) continue;
    send(seat.socket, { t: 'chat', entry });
  }
}

/** A socket is bound to exactly one seat in one room. */
const sessions = new WeakMap();

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(socket, { t: 'error', message: 'Bad message.' });
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'create' || msg.t === 'join') {
      return handleJoin(socket, msg);
    }
    if (msg.t === 'action') {
      return handleAction(socket, msg);
    }
    if (msg.t === 'chat') {
      return handleChat(socket, msg);
    }
    if (msg.t === 'voice') {
      return handleVoice(socket, msg);
    }
    if (msg.t === 'ping') {
      return send(socket, { t: 'pong' });
    }
    if (msg.t === 'leave') {
      return handleLeave(socket);
    }
  });

  socket.on('close', () => {
    const session = sessions.get(socket);
    if (!session) return;
    sessions.delete(socket);
    const room = getRoom(session.roomCode);
    const seat = room?.seatFor(session.playerId);
    if (room && seat) {
      detachSeat(room, seat);
      broadcastRoom(room);
    }
  });

  socket.on('error', () => socket.terminate());
});

function handleJoin(socket, msg) {
  const name = cleanName(msg.name);
  let room;
  let seat;
  let rejoined = false;

  if (msg.t === 'create') {
    room = createRoom({ maxPlayers: msg.maxPlayers });
    const res = addPlayer(room, { name });
    if (res.error) return send(socket, { t: 'error', message: res.error });
    seat = res.seat;
  } else {
    room = getRoom(msg.code);
    if (!room) return send(socket, { t: 'error', message: 'No game with that code. Check the link?' });
    const res = addPlayer(room, { name, token: msg.token });
    if (res.error) return send(socket, { t: 'error', message: res.error });
    seat = res.seat;
    rejoined = res.rejoined;
  }

  // One socket per seat: kick the old connection so state is not duplicated.
  if (seat.socket && seat.socket !== socket) {
    send(seat.socket, { t: 'replaced' });
    seat.socket.close();
  }
  seat.socket = socket;
  seat.connected = true;
  seat.droppedAt = null;
  if (seat.name !== name) seat.name = name;

  sessions.set(socket, { roomCode: room.code, playerId: seat.id });

  startIfReady(room);
  if (room.state) {
    const p = room.state.players.find((x) => x.id === seat.id);
    if (p) {
      p.name = seat.name;
      p.connected = true;
    }
  }

  send(socket, {
    t: 'joined',
    code: room.code,
    you: seat.id,
    token: seat.token,
    rejoined,
    view: viewForSeat(room, seat, { full: rejoined }), // full hand resync on reconnect
  });
  broadcastRoom(room);
}

function handleAction(socket, msg) {
  const session = sessions.get(socket);
  if (!session) return send(socket, { t: 'error', message: 'Join a game first.' });
  const room = getRoom(session.roomCode);
  const seat = room?.seatFor(session.playerId);
  if (!room || !seat) return send(socket, { t: 'error', message: 'Your seat is gone.' });

  const result = applyAction(room, seat, msg);

  // Anything that is not an explicit success is reported back to the player who
  // tried it — including the engine's refusals and our own validation errors.
  if (!result || result.ok !== true) {
    if (result?.leaving) return handleLeave(socket);
    if (result?.error) send(socket, { t: 'error', message: result.error });
  }
  // Voice presence and table-size changes do not move the board, so sending the
  // full state to everyone would be pure waste.
  if (result?.voiceOnly || result?.seatsOnly) return broadcastLobby(room);
  // A rejected move leaves the state untouched; resend so the client re-syncs.
  broadcastRoom(room);
}

function handleChat(socket, msg) {
  const session = sessions.get(socket);
  if (!session) return send(socket, { t: 'error', message: 'Join a game first.' });
  const room = getRoom(session.roomCode);
  const seat = room?.seatFor(session.playerId);
  if (!room || !seat) return send(socket, { t: 'error', message: 'Your seat is gone.' });

  const result = addChat(room, seat, msg);
  if (!result.ok) return send(socket, { t: 'error', message: result.error });
  broadcastChat(room, result.entry);
}

/**
 * WebRTC signalling relay. The server passes offer/answer/ICE blobs between two
 * players and stores nothing — it never touches the audio itself. Relaying SDP
 * is a few hundred bytes, once per peer, so voice costs no server data beyond
 * that handshake; the audio goes peer to peer.
 */
function handleVoice(socket, msg) {
  const session = sessions.get(socket);
  if (!session) return;
  const room = getRoom(session.roomCode);
  const from = room?.seatFor(session.playerId);
  if (!room || !from) return;
  if (!from.voice) return; // only players who asked for the microphone may signal

  const to = room.seatFor(String(msg.to || ''));
  if (!to || !to.socket) return;
  if (to.id === from.id) return;

  // Only relay the three things WebRTC negotiation needs.
  const kind = ['offer', 'answer', 'ice', 'bye'].includes(msg.kind) ? msg.kind : null;
  if (!kind) return;

  send(to.socket, { t: 'voice', from: from.id, kind, payload: msg.payload ?? null });
}

function handleLeave(socket) {
  const session = sessions.get(socket);
  if (!session) return;
  sessions.delete(socket);
  const room = getRoom(session.roomCode);
  const seat = room?.seatFor(session.playerId);
  if (!room || !seat) return socket.close();
  removeSeat(room, seat);
  broadcastRoom(room);
  socket.close();
}

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

const sweeper = setInterval(() => sweep(), 60_000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(sweeper);
});

server.listen(PORT, () => {
  console.log(`UNO server on http://localhost:${PORT}`);
  console.log(`Players per table: ${MIN_SEATS}-${MAX_SEATS}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));