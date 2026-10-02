/**
 * Rooms: who is sitting where, and the live game behind them.
 *
 * The rules live in game.js. This file only owns identity, membership and
 * broadcasting. Nothing here decides what a legal move is.
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
const MAX_SEATS = 2;
const RECONNECT_GRACE_MS = 30 * 60 * 1000; // keep the seat for 30 minutes
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // drop forgotten rooms after 6 hours

/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(code, targetScore = null) {
    this.code = code;
    this.seats = []; // { id, token, name, socket, connected, droppedAt }
    this.state = null;
    this.targetScore = targetScore;
    this.createdAt = Date.now();
    this.touchedAt = Date.now();
  }

  seatFor(id) {
    return this.seats.find((s) => s.id === id) || null;
  }

  get liveSeats() {
    return this.seats.filter((s) => !s.droppedAt);
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

export function createRoom({ targetScore = null } = {}) {
  const room = new Room(makeCode(), targetScore);
  rooms.set(room.code, room);
  return room;
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
    return { error: 'That game already has two players.' };
  }

  const seat = {
    id: randomUUID(),
    token: randomUUID(),
    name,
    socket: null,
    connected: false,
    droppedAt: null,
  };
  room.seats.push(seat);
  room.touchedAt = Date.now();
  return { seat, rejoined: false };
}

/** Deals the first hand once both seats are filled. */
export function startIfReady(room) {
  if (room.state) return true;
  const seats = room.liveSeats;
  if (seats.length < 2) return false;
  room.state = createMatch({
    players: seats.map((s) => ({ id: s.id, name: s.name })),
    targetScore: room.targetScore,
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
}

/**
 * Applies a player's intent to the room's state.
 * Everything is validated by the engine; a rejected move changes nothing and
 * the caller is told why.
 */
export function applyAction(room, seat, msg) {
  if (!room.state) return { error: 'Waiting for a second player.' };
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
    targetScore: room.targetScore,
  });
  return { ok: true };
}

/** Removes the player, and the room if nobody is left to play it. */
export function removeSeat(room, seat) {
  const i = room.seats.indexOf(seat);
  if (i >= 0) room.seats.splice(i, 1);
  if (room.state) {
    room.state.players = room.state.players.filter((p) => p.id !== seat.id);
  }
  room.touchedAt = Date.now();
  if (room.seats.length === 0) rooms.delete(room.code);
}

/** The wire view for one seat. */
export function viewForSeat(room, seat, { full = false } = {}) {
  if (!room.state) {
    return {
      waiting: true,
      code: room.code,
      players: room.seats.map((s) => ({ id: s.id, name: s.name, connected: s.connected, isMe: s.id === seat.id })),
      you: seat.id,
    };
  }
  const base = viewFor(room.state, seat.id, { includeAllHands: full });
  return {
    ...base,
    waiting: false,
    code: room.code,
    targetScore: room.targetScore ?? null,
    you: seat.id,
    seats: room.seats.map((s) => ({ id: s.id, name: s.name, connected: s.connected })),
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