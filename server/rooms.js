/**
 * Rooms: who is sitting where, and the live game behind them.
 *
 * The rules live in game.js. This file owns identity, membership, chat and
 * relaying. Nothing here decides what a legal move is.
 */

import { randomInt, randomUUID } from 'node:crypto';

import {
  createMatch,
  viewFor,
  playCard,
  drawCard,
  passTurn,
  acceptPenalty,
  challengePenalty,
  callUno,
  catchUno,
  nextRound,
} from './game.js';

// No 0/O/1/I: these codes get read aloud and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MIN_SEATS = 2;
export const MAX_SEATS = 6;
const CHAT_HISTORY = 40;
const RECONNECT_GRACE_MS = 30 * 60 * 1000; // keep the seat for 30 minutes
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // drop forgotten rooms after 6 hours
const MSG = { MAX_LEN: 400, MAX_STICKER_LEN: 8 };

/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(code, maxPlayers) {
    this.code = code;
    this.maxPlayers = maxPlayers; // seats at this table
    this.seats = []; // { id, token, name, socket, connected, droppedAt, voice }
    this.state = null;
    this.hostId = null;
    this.chat = []; // recent messages, bounded
    this.chatSeq = 0;
    this.createdAt = Date.now();
    this.touchedAt = Date.now();
  }

  seatFor(id) {
    return this.seats.find((s) => s.id === id) || null;
  }

  get liveSeats() {
    return this.seats.filter((s) => !s.droppedAt);
  }

  get isFull() {
    return this.liveSeats.length >= this.maxPlayers;
  }
}

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  } while (rooms.has(code)); // do not hand out a live code
  return code;
}

export function createRoom({ maxPlayers = MIN_SEATS } = {}) {
  const seats = clampSeats(maxPlayers);
  const room = new Room(makeCode(), seats);
  rooms.set(room.code, room);
  return room;
}

function clampSeats(n) {
  const wanted = Number.isFinite(Number(n)) ? Math.round(Number(n)) : MIN_SEATS;
  return Math.min(MAX_SEATS, Math.max(MIN_SEATS, wanted));
}

export function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase()) || null;
}

export function roomCount() {
  return rooms.size;
}

/** Adds a player. Reclaims a dropped seat if the token matches. */
export function addPlayer(room, { name, token }) {
  // Reconnect: same token means same seat, even if the socket is new.
  if (token) {
    const seat = room.seats.find((s) => s.token === token);
    if (seat) {
      seat.droppedAt = null;
      seat.connected = true;
      room.touchedAt = Date.now();
      return { seat, rejoined: true };
    }
  }

  if (room.seats.length >= MAX_SEATS) {
    return { error: 'That table is full.' };
  }
  if (room.isFull) {
    return { error: `That table is set for ${room.maxPlayers} players.` };
  }

  const seat = {
    id: randomUUID(),
    token: randomUUID(),
    name,
    socket: null,
    connected: false,
    droppedAt: null,
    voice: false, // opt in; off until someone asks for the microphone
  };
  room.seats.push(seat);
  if (room.hostId === null) room.hostId = seat.id;
  room.touchedAt = Date.now();
  return { seat, rejoined: false };
}

/** True once there are enough players to deal. */
export function canStart(room) {
  return room.liveSeats.length >= MIN_SEATS;
}

/** Deals the hand. Called when the table fills, or when the host starts early. */
export function startIfReady(room, { force = false } = {}) {
  if (room.state) return true;
  const seats = room.liveSeats;
  if (seats.length < MIN_SEATS) return false;
  if (!force && seats.length < room.maxPlayers) return false;

  room.state = createMatch({
    players: seats.map((s) => ({ id: s.id, name: s.name })),
    dealer: 0,
  });
  room.touchedAt = Date.now();
  return true;
}

export function detachSeat(room, seat) {
  if (!seat) return;
  seat.socket = null;
  seat.connected = false;
  seat.droppedAt = Date.now();
  room.touchedAt = Date.now();
  if (room.state) {
    const p = room.state.players.find((x) => x.id === seat.id);
    if (p) p.connected = false;
  }
  // Keep the game playable: hand the turn on rather than stalling on a ghost.
  if (room.state && room.state.phase === 'playing') {
    const idx = room.state.players.findIndex((x) => x.id === seat.id);
    if (idx >= 0 && room.state.turn === idx) {
      room.state.turn = (idx + 1) % room.state.players.length;
    }
  }
  // Pass the host role on if the host left.
  if (room.hostId === seat.id) {
    const next = room.liveSeats[0];
    room.hostId = next ? next.id : null;
  }
}

/**
 * Applies a player's intent to the room's state.
 * Everything is validated by the engine; a rejected move changes nothing and
 * the caller is told why.
 */
export function applyAction(room, seat, msg) {
  // Table-level intents that do not need a live match.
  if (msg.action === 'start') {
    if (room.state) return { error: 'The game has already started.' };
    if (room.hostId !== seat.id) return { error: 'Only the host can start the game.' };
    if (!startIfReady(room, { force: true })) return { error: 'Need at least two players.' };
    return { ok: true, started: true };
  }

  if (msg.action === 'voice') {
    seat.voice = Boolean(msg.enabled);
    room.touchedAt = Date.now();
    return { ok: true, voiceOnly: true }; // presence change, no board change
  }

  if (msg.action === 'addSeats') {
    if (room.hostId !== seat.id) return { error: 'Only the host can change the table size.' };
    if (room.state) return { error: 'The game has already started.' };
    room.maxPlayers = clampSeats(msg.maxPlayers);
    return { ok: true, seatsOnly: true };
  }

  if (!room.state) return { error: 'Waiting for the game to start.' };
  const index = room.state.players.findIndex((p) => p.id === seat.id);
  if (index < 0) return { error: 'You are not in this game.' };

  switch (msg.action) {
    case 'play':
      return playCard(room.state, index, String(msg.cardId ?? ''), msg.color ?? null);
    case 'draw':
      return drawCard(room.state, index);
    case 'pass':
      return passTurn(room.state, index);
    case 'accept':
      return acceptPenalty(room.state, index);
    case 'challenge':
      return challengePenalty(room.state, index);
    case 'uno':
      return callUno(room.state, index);
    case 'catch':
      return catchUno(room.state, index, Number.isInteger(msg.target) ? msg.target : null);
    case 'nextRound':
      // Only meaningful when the round is over.
      if (room.state.phase === 'playing') return { error: 'Finish the round first.' };
      return nextRound(room.state);
    case 'rematch':
      return restartMatch(room);
    case 'leave':
      return { ok: true, leaving: true };
    default:
      return { error: 'Unknown action.' };
  }
}

/** Wipes the scoreboard and deals round one again. */
export function restartMatch(room) {
  room.state = createMatch({
    players: room.liveSeats.map((s) => ({ id: s.id, name: s.name })),
  });
  return { ok: true };
}

/**
 * Adds a chat line or sticker. Kept small and bounded: this is the one message
 * type that must stay cheap, since every player receives every line.
 */
export function addChat(room, seat, msg) {
  if (room.chat.length >= CHAT_HISTORY) room.chat.shift();
  const isSticker = msg.sticker !== undefined && msg.sticker !== null;
  const body = isSticker
    ? String(msg.sticker).slice(0, MSG.MAX_STICKER_LEN)
    : String(msg.text ?? '').slice(0, MSG.MAX_LEN);

  if (!isSticker && !body.trim()) return { error: 'Say something first.' };

  const entry = {
    seq: ++room.chatSeq,
    from: seat.id,
    name: seat.name,
    sticker: isSticker ? body : null,
    text: isSticker ? null : body,
    at: Date.now(),
  };
  room.chat.push(entry);
  room.touchedAt = Date.now();
  return { ok: true, entry };
}

/** Removes the player, and the room if nobody is left to play it. */
export function removeSeat(room, seat) {
  const i = room.seats.indexOf(seat);
  if (i >= 0) room.seats.splice(i, 1);
  if (room.state) {
    room.state.players = room.state.players.filter((p) => p.id !== seat.id);
  }
  if (room.hostId === seat.id) {
    const next = room.liveSeats[0];
    room.hostId = next ? next.id : null;
  }
  room.touchedAt = Date.now();
  if (room.seats.length === 0) rooms.delete(room.code);
}

/** Seats plus lobby flags, sent on every view so presence stays current. */
export function lobbyFor(room, seat) {
  return {
    waiting: true,
    code: room.code,
    maxPlayers: room.maxPlayers,
    minPlayers: MIN_SEATS,
    you: seat.id,
    isHost: room.hostId === seat.id,
    canStart: canStart(room),
    isFull: room.isFull,
    players: room.seats.map((s) => ({
      id: s.id,
      name: s.name,
      connected: s.connected,
      voice: s.voice,
      isMe: s.id === seat.id,
      isHost: s.id === room.hostId,
    })),
  };
}

/** The wire view for one seat. */
export function viewForSeat(room, seat, { full = false } = {}) {
  const lobby = lobbyFor(room, seat);
  if (!room.state) return { ...lobby, chat: room.chat };

  const base = viewFor(room.state, seat.id, { includeAllHands: full });

  // Fold seat-level presence (microphone on, host) into the per-player list so
  // the table UI has everything in one place while a game is running.
  base.players = base.players.map((p) => {
    const s = room.seatFor(p.id);
    return { ...p, voice: Boolean(s?.voice), isHost: p.id === room.hostId };
  });

  return {
    ...base,
    waiting: false,
    code: room.code,
    maxPlayers: room.maxPlayers,
    isHost: room.hostId === seat.id,
    you: seat.id,
    seats: room.seats.map((s) => ({
      id: s.id,
      name: s.name,
      connected: s.connected,
      voice: s.voice,
      isHost: s.id === room.hostId,
    })),
    chat: room.chat,
  };
}

/** Called on an interval: forget expired seats and abandoned rooms. */
export function sweep() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    for (const seat of [...room.seats]) {
      if (seat.droppedAt && now - seat.droppedAt > RECONNECT_GRACE_MS) {
        removeSeat(room, seat);
      }
    }
    if (rooms.has(room.code) && room.seats.length === 0) rooms.delete(room.code);
    else if (now - room.touchedAt > ROOM_TTL_MS && room.liveSeats.length === 0) rooms.delete(room.code);
  }
  return rooms.size;
}