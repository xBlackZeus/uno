/**
 * HTTP(S) + WebSocket entry point.
 *
 * Serves the client from ./public and speaks the game protocol on /ws.
 * Every rule decision happens on this side; the browser only sends intents.
 *
 * ── TLS ─────────────────────────────────────────────────────────────────────
 *
 * Voice chat needs a *secure context*, and browsers only treat https:// origins
 * as one (plus http://localhost). Serving the game from a phone via
 * http://192.168.x.x:3000 therefore has no `navigator.mediaDevices` at all and
 * the microphone is unreachable — not a phone quirk, a transport one.
 *
 * So the server can speak TLS. Drop a certificate and key in ./certs (or point
 * TLS_CERT/TLS_KEY at them) and it switches to https automatically; the
 * WebSocket upgrade rides along as wss. With no certificate it stays plain http,
 * which is still fine for playing — only voice needs the upgrade.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
const HOST = process.env.HOST || '0.0.0.0';
const MAX_MESSAGE_BYTES = 8 * 1024;

/**
 * Finds a usable certificate/key pair, if one has been provided.
 * Explicit env vars win; otherwise ./certs/cert.pem + ./certs/key.pem is picked
 * up automatically so `npm start` does the right thing with no extra flags.
 */
function findTls() {
  // Explicit opt-out. Serving over TLS because a file happens to exist is a
  // surprise waiting to happen: drop a cert in ./certs for one afternoon and
  // every saved bookmark silently stops working. TLS=off pins plain HTTP.
  if (process.env.TLS === 'off') return null;

  const cert = process.env.TLS_CERT;
  const key = process.env.TLS_KEY;
  const certPath = cert || path.join(__dirname, '..', 'certs', 'cert.pem');
  const keyPath = key || path.join(__dirname, '..', 'certs', 'key.pem');

  const hasCert = cert ? fs.existsSync(cert) : fs.existsSync(certPath);
  const hasKey = key ? fs.existsSync(key) : fs.existsSync(keyPath);

  if (hasCert && hasKey) {
    return { cert: fs.readFileSync(cert || certPath), key: fs.readFileSync(key || keyPath) };
  }
  // Half a configuration is a mistake worth shouting about rather than silently
  // falling back to http and leaving voice mysteriously broken.
  if (hasCert !== hasKey) {
    console.warn(
      `[tls] found only ${hasCert ? 'a certificate' : 'a key'} — ignoring TLS and serving plain http. ` +
        'Voice chat needs both. See README "Voice chat over a LAN".',
    );
  }
  return null;
}

const TLS = findTls();

/**
 * Optional TURN relay for voice, handed to each client when it joins.
 *
 * STUN alone connects most home networks, but two players behind symmetric NAT
 * or restrictive mobile carriers will never find a direct path — that is what
 * TURN is for. It is opt-in via environment so no credential is ever committed,
 * and the client only uses it if all three parts are present.
 */
function turnConfig() {
  const urls = process.env.TURN_URL;
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (!urls || !username || !credential) return null;
  return { urls, username, credential };
}

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

const server = (TLS ? https.createServer(TLS, handler) : http.createServer(handler));

function handler(req, res) {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500).end('server error');
    console.error('http error', err);
  });
}

async function handleRequest(req, res) {
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
    if (!res.headersSent) res.writeHead(500).end('server error');
    console.error('http error', err);
  }
}

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
    turn: turnConfig(),
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

/** Addresses worth showing a human: never 0.0.0.0, which is not dialable. */
function shareableUrls() {
  const scheme = TLS ? 'https' : 'http';
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      addrs.push(`${scheme}://${ni.address}:${PORT}`);
    }
  }
  if (HOST !== '0.0.0.0' && HOST !== '::') addrs.unshift(`${scheme}://${HOST}:${PORT}`);
  else addrs.unshift(`${scheme}://localhost:${PORT}`);
  return [...new Set(addrs)];
}

server.listen(PORT, HOST, () => {
  console.log(`UNO server listening on ${HOST}:${PORT} — players per table: ${MIN_SEATS}-${MAX_SEATS}`);
  for (const url of shareableUrls()) console.log(`  ${url}`);
  if (TLS) {
    console.log('  TLS on. Voice chat is available on these addresses.');
  } else {
    console.log('  Plain http. Playing works; voice chat needs https (see README).');
  }
});

// A busy port is an ordinary situation — usually a second copy already running —
// so say what happened in a sentence a human can act on instead of dumping an
// unhandled 'error' event and a stack.
//
// The handler has to be on the WebSocketServer as well as the http/https
// server: `ws` re-emits the underlying server's error on itself, and whichever
// listener is attached first is the one that sees it. Without both, this throws
// an unhandled 'error' and prints the raw stack — which is exactly the
// behaviour this is meant to replace.
let reportedFatal = false;
function reportFatal(err) {
  if (reportedFatal) return;
  reportedFatal = true;
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use — another copy of the UNO server is probably still running.\n` +
        `  find it:  lsof -ti tcp:${PORT}\n` +
        `  stop it:  kill $(lsof -ti tcp:${PORT})\n` +
        `  or use another port:  PORT=${PORT + 1} npm start\n`,
    );
  } else {
    console.error('server error', err);
  }
  process.exit(1);
}

server.on('error', reportFatal);
wss.on('error', reportFatal);

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));