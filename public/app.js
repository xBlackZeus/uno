/* UNO client. Sends intents, renders whatever the server says is true. */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const COLOR_ORDER = ['R', 'Y', 'G', 'B'];
  const COLOR_LABEL = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Blue' };
  const KEYS = ['r', 'y', 'g', 'b'];

  const el = {
    home: $('#home'),
    waiting: $('#waiting'),
    game: $('#game'),
    name: $('#nameInput'),
    code: $('#codeInput'),
    codeEntry: $('#codeEntry'),
    homeError: $('#homeError'),
    joinForm: $('#joinForm'),
    roomCode: $('#roomCode'),
    shareLink: $('#shareLink'),
    waitingStatus: $('#waitingStatus'),
    scores: $('#scores'),
    roundChip: $('#roundChip'),
    codeChip: $('#codeChip'),
    opponent: $('#opponent'),
    drawPile: $('#drawPile'),
    drawCount: $('#drawCount'),
    topCard: $('#topCard'),
    turnBanner: $('#turnBanner'),
    logStrip: $('#logStrip'),
    hand: $('#hand'),
    actions: $('#actions'),
    colorPicker: $('#colorPicker'),
    colorGrid: $('#colorGrid'),
    roundBanner: $('#roundBanner'),
    roundTitle: $('#roundTitle'),
    roundBody: $('#roundBody'),
    tally: $('#tally'),
    nextRoundBtn: $('#nextRoundBtn'),
    linkBanner: $('#linkBanner'),
    toast: $('#toast'),
    conn: $('#conn'),
  };

  // ── Local session state ─────────────────────────────────
  let socket = null;
  let view = null;
  let me = null;
  let code = null;
  let token = null;
  let pendingCard = null; // card awaiting a colour choice
  let intent = null; // { kind: 'create' } or { kind: 'join', code, token }
  let autoRejoin = null; // set when we already hold a seat for this table
  let fromRoom = null; // code from the invite link, before joining
  let retryDelay = 600;
  let toastTimer = null;

  const serverOrigin = () => window.UNO_SERVER_URL || window.location.origin;

  function wsUrl() {
    const base = serverOrigin();
    const u = new URL(base, window.location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = '';
    u.hash = '';
    return u.toString();
  }

  /** Works under a GitHub Pages project sub-path, not just a domain root. */
  function basePath() {
    return window.location.pathname
      .replace(/\/room\/[A-Za-z0-9]{4}\/?$/, '')
      .replace(/\/$/, '');
  }

  /**
   * Invite links carry the code as a query parameter, not as a path. A query
   * string works on any static host (GitHub Pages included) without server
   * rewrites, and keeps relative asset URLs resolving correctly.
   */
  function inviteLink() {
    return `${window.location.origin}${basePath()}/?room=${code}`;
  }

  function roomCodeFromUrl() {
    const q = new URLSearchParams(window.location.search).get('room');
    if (q && /^[A-Za-z0-9]{4}$/.test(q)) return q.toUpperCase();
    const m = window.location.pathname.match(/^(?:.*\/)?room\/([A-Za-z0-9]{4})\/?$/);
    return m ? m[1].toUpperCase() : null;
  }

  function saveSession() {
    if (!code) return;
    try {
      localStorage.setItem(`uno:${code}`, JSON.stringify({ token, you: me, name: el.name.value.trim() }));
    } catch {
      /* private mode: session just will not survive a refresh */
    }
  }

  function loadSession(which) {
    try {
      const raw = localStorage.getItem(`uno:${which}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function show(screen) {
    for (const s of [el.home, el.waiting, el.game]) s.classList.add('hidden');
    screen.classList.remove('hidden');
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
  }

  function setConnected(ok) {
    el.conn.classList.toggle('hidden', ok);
  }

  // ── Socket ───────────────────────────────────────────
  function connect() {
    setConnected(false);
    socket = new WebSocket(wsUrl());

    socket.addEventListener('open', () => {
      retryDelay = 600;
      setConnected(true);
      if (intent) {
        const todo = intent;
        intent = null;
        dispatch(todo);
      } else if (autoRejoin) {
        const todo = autoRejoin;
        autoRejoin = null;
        joinRoom(todo.code, el.name.value.trim() || todo.name || '', todo.token);
      }
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(msg);
    });

    socket.addEventListener('close', () => {
      setConnected(false);
      if (code) {
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 1.6, 8000);
      }
    });

    socket.addEventListener('error', () => socket.close());
  }

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    } else {
      toast('Not connected — retrying…');
    }
  }

  const act = (action, extra = {}) => send({ t: 'action', action, ...extra });

  function handle(msg) {
    switch (msg.t) {
      case 'joined':
        code = msg.code;
        token = msg.token;
        me = msg.you;
        saveSession();
        history.replaceState(null, '', `${basePath()}/?room=${code}`);
        el.codeChip.textContent = code;
        el.shareLink.value = inviteLink();
        $('#shareLink2').value = inviteLink();
        el.roomCode.textContent = code;
        if (msg.view.waiting) {
          show(el.waiting);
          el.waitingStatus.textContent = `${el.name.value.trim() || 'Player'}, share the link above to start.`;
        } else {
          show(el.game);
          render(msg.view);
        }
        break;

      case 'state':
        view = msg.view;
        if (view.waiting) {
          show(el.waiting);
        } else {
          show(el.game);
          render(view);
        }
        break;

      case 'error':
        if (msg.message.includes('No game with that code')) {
          show(el.home);
          el.homeError.textContent = msg.message;
        } else {
          toast(msg.message);
        }
        break;

      case 'replaced':
        toast('That game was reopened in another tab.');
        break;
    }
  }

  function joinRoom(roomCode, name, resumeToken) {
    if (!roomCode) return;
    code = roomCode.toUpperCase();
    send({ t: 'join', code, name, token: resumeToken ?? undefined });
  }

  /** Carries out a create/join request, opening the socket first if needed. */
  function request(what) {
    intent = what;
    if (socket && socket.readyState === WebSocket.OPEN) {
      intent = null;
      dispatch(what);
    } else if (!socket) {
      connect();
    }
  }

  function dispatch(what) {
    const name = el.name.value.trim();
    if (what.kind === 'create') send({ t: 'create', name });
    else joinRoom(what.code, name, what.token);
  }

  // ── Card rendering ───────────────────────────────────
  function cardEl(card, { mini = false, hidden = false } = {}) {
    const node = document.createElement('div');
    node.className = 'card';
    if (mini) node.classList.add('mini');

    if (hidden) {
      node.classList.add('face-down');
      return node;
    }

    const colour = card.color === 'W' ? (card.chosen || 'W') : card.color;
    node.classList.add(colour.toLowerCase());
    node.dataset.color = colour;

    if (card.kind === 'wild' || card.kind === 'wild4') {
      node.classList.add('wild');
      const stripe = document.createElement('div');
      stripe.className = 'wild-stripe';
      const label = document.createElement('span');
      label.textContent = card.kind === 'wild4' ? 'WILD +4' : 'WILD';
      stripe.append(label);
      node.append(stripe);
      if (card.chosen) node.dataset.chosen = COLOR_LABEL[card.chosen];
      return node;
    }

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = COLOR_LABEL[colour].slice(0, 3).toUpperCase();
    const big = document.createElement('span');
    big.className = card.kind === 'num' ? 'num' : 'big';
    big.textContent =
      card.kind === 'num' ? card.num : card.kind === 'skip' ? '⊘' : card.kind === 'rev' ? '⇄' : '+2';
    node.append(mark, big);
    return node;
  }

  // ── Main render ──────────────────────────────────────
  function render(v) {
    view = v;
    const myIndex = v.myIndex;
    const mePlayer = v.players[myIndex];
    const other = v.players.find((p) => !p.isMe);

    $('#roundChip').textContent = `Round ${v.roundNumber}`;

    // Scoreboard
    el.scores.replaceChildren();
    for (const p of v.players) {
      const row = document.createElement('div');
      row.className = 'score';
      if (p.isTurn) row.classList.add('active-turn');
      if (!p.connected) row.classList.add('offline');

      const dot = document.createElement('span');
      dot.className = 'dot';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name + (p.isMe ? ' (you)' : '');
      const pts = document.createElement('span');
      pts.className = 'pts';
      pts.textContent = p.score;
      const cards = document.createElement('span');
      cards.className = 'cards';
      cards.textContent = `${p.count} card${p.count === 1 ? '' : 's'}`;
      row.append(dot, nm, pts, cards);
      el.scores.append(row);
    }

    // Opponent side
    el.opponent.replaceChildren();
    if (other) {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = other.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = other.connected ? `${other.count} cards · ${other.total} points in hand` : 'reconnecting…';
      el.opponent.append(who, meta);

      const fan = document.createElement('div');
      fan.className = 'fan';
      for (let i = 0; i < other.count; i++) fan.append(cardEl(null, { mini: true, hidden: true }));
      el.opponent.append(fan);

      if (v.unoOpen && v.unoOpen.includes(v.players.findIndex((p) => p.id === other.id))) {
        const warn = document.createElement('div');
        warn.className = 'meta warn';
        warn.style.color = '#ffb86b';
        warn.textContent = 'One card left — no UNO called!';
        el.opponent.append(warn);
      }
    }

    // Table card + draw pile
    el.topCard.replaceChildren();
    if (v.top) el.topCard.append(cardEl(v.top));
    el.drawCount.textContent = v.drawCount;
    const myTurn = v.turn === myIndex && v.phase === 'playing';
    el.drawPile.disabled = !myTurn || !v.legal.includes('draw');

    // Turn banner
    const banner = document.createElement('div');
    if (v.phase !== 'playing') {
      banner.textContent = 'Round over';
    } else if (v.pendingDraw && v.pendingDraw.targetIndex === myIndex) {
      banner.innerHTML = `<span class="warn">Wild Draw Four — take ${v.pendingDraw.n}, or challenge it.</span>`;
    } else if (myTurn) {
      banner.textContent = 'Your turn';
    } else {
      banner.textContent = `${other ? other.name : 'Waiting'} is thinking…`;
    }
    el.turnBanner.replaceChildren(banner);

    // Log
    const last = v.log[v.log.length - 1];
    el.logStrip.textContent = last || '';

    // Hand
    el.hand.replaceChildren();
    const playable = new Set(v.playable || []);
    for (const card of v.hand) {
      const node = cardEl(card);
      const can = myTurn && playable.has(card.id);
      if (!can) node.classList.add('dim');
      node.addEventListener('click', () => onCardClick(card, can));
      el.hand.append(node);
    }

    // Actions
    el.actions.replaceChildren();
    const button = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`;
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', fn);
      el.actions.append(b);
      return b;
    };

    if (v.phase === 'playing') {
      if (v.pendingDraw && v.pendingDraw.targetIndex === myIndex) {
        button('Take the cards', 'act-primary', () => act('accept'));
        if (v.pendingDraw.challengeable) button('Challenge!', 'act-catch', () => act('challenge'));
      } else {
        if (v.legal.includes('draw')) button('Draw', '', () => act('draw'));
        if (v.legal.includes('pass')) button('Keep the card, end turn', '', () => act('pass'));
      }
      if (v.unoOpen && v.unoOpen.includes(myIndex)) {
        button('UNO!', 'act-uno', () => act('uno'));
      }
      if (v.legal.includes('catch') && other) {
        const otherIndex = v.players.findIndex((p) => p.id === other.id);
        if (v.unoOpen && v.unoOpen.includes(otherIndex)) {
          button(`Caught you, ${other.name}!`, 'act-catch', () => act('catch', { target: otherIndex }));
        }
      }
    }

    if (v.phase === 'roundOver') showRoundBanner(v);
    else el.roundBanner.classList.add('hidden');

    el.nextRoundBtn.disabled = !v || v.phase === 'playing';
  }

  function showRoundBanner(v) {
    const winner = v.roundWinner;
    const title = $('#roundTitle');
    const body = $('#roundBody');

    if (winner === null) {
      title.textContent = 'Round abandoned';
      body.textContent = 'Nobody could finish that one. Fresh cards.';
    } else {
      const name = v.players[winner].name;
      title.textContent = winner === v.myIndex ? 'You took the round' : `${name} took the round`;
      body.textContent = `+${v.roundPoints} points from the cards left on the table.`;
    }

    el.tally.replaceChildren();
    for (const p of v.players) {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      a.textContent = p.name + (p.isMe ? ' (you)' : '');
      const b = document.createElement('td');
      b.textContent = `${p.score} pts · ${p.roundWins} round${p.roundWins === 1 ? '' : 'wins'}`;
      tr.append(a, b);
      el.tally.append(tr);
    }

    if (v.phase === 'roundOver' && el.roundBanner.classList.contains('hidden')) {
      el.roundBanner.classList.remove('hidden');
    }
  }

  // ── Interaction ──────────────────────────────────────
  function onCardClick(card, can) {
    if (!can) return;
    if (card.kind === 'wild' || card.kind === 'wild4') {
      pendingCard = card;
      el.colorPicker.classList.remove('hidden');
      return;
    }
    act('play', { cardId: card.id });
  }

  el.colorGrid.replaceChildren();
  COLOR_ORDER.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch ${c.toLowerCase()}`;
    b.textContent = COLOR_LABEL[c];
    b.addEventListener('click', () => {
      if (pendingCard) act('play', { cardId: pendingCard.id, color: c });
      pendingCard = null;
      el.colorPicker.classList.add('hidden');
    });
    el.colorGrid.append(b);
  });

  for (const node of document.querySelectorAll('[data-close]')) {
    node.addEventListener('click', () => {
      document.getElementById(node.dataset.close).classList.add('hidden');
    });
  }

  el.nextRoundBtn.addEventListener('click', () => {
    act('nextRound');
    el.roundBanner.classList.add('hidden');
  });

  $('#copyLinkBtn').addEventListener('click', () => {
    el.linkBanner.classList.remove('hidden');
    $('#shareLink2').value = inviteLink();
  });
  $('#copyBtn2').addEventListener('click', () => copy(inviteLink()));

  function copy(text) {
    const done = () => toast('Link copied — send it to your friend.');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else {
      fallback();
    }
    function fallback() {
      const input = $('#shareLink2');
      input.select();
      try {
        document.execCommand('copy');
        done();
      } catch {
        toast(text);
      }
    }
  }

  $('#copyBtn').addEventListener('click', () => {
    el.shareLink.select();
    copy(el.shareLink.value);
  });

  $('#leaveWaiting').addEventListener('click', () => {
    send({ t: 'leave' });
    code = null;
    token = null;
    me = null;
    history.replaceState(null, '', `${basePath()}/`);
    show(el.home);
  });

  // Home screen routing
  el.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    el.homeError.textContent = '';
    if (fromRoom) {
      const saved = loadSession(fromRoom);
      request({ kind: 'join', code: fromRoom, token: saved?.token ?? null });
    } else {
      request({ kind: 'create' });
    }
  });

  $('#joinBtn').addEventListener('click', () => {
    const value = el.code.value.trim().toUpperCase();
    if (value.length !== 4) {
      el.homeError.textContent = 'Codes are four letters and numbers.';
      return;
    }
    el.homeError.textContent = '';
    request({ kind: 'join', code: value, token: loadSession(value)?.token ?? null });
  });

  // ── Boot ─────────────────────────────────────────────
  fromRoom = roomCodeFromUrl();
  const saved = fromRoom ? loadSession(fromRoom) : null;

  if (fromRoom && saved?.token) {
    // Already holding a seat for this table (a refresh, or a dropped
    // connection): go straight back in without asking for a name again.
    if (saved.name) el.name.value = saved.name;
    autoRejoin = { code: fromRoom, token: saved.token, name: saved.name };
    connect();
  } else if (fromRoom) {
    // First time here: ask for a name, then join.
    if (saved?.name) el.name.value = saved.name;
    $('#createBtn').textContent = 'Join the game';
    el.codeEntry.classList.add('hidden');
    el.homeError.textContent = '';
    el.name.focus();
  } else {
    el.codeEntry.classList.remove('hidden');
    el.name.focus();
  }

  window.addEventListener('beforeunload', () => {
    saveSession();
  });
})();