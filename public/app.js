/* UNO client. Sends intents, renders whatever the server says is true. */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const COLOR_ORDER = ['R', 'Y', 'G', 'B'];
  const COLOR_LABEL = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Blue' };

  const el = {
    home: $('#home'),
    waiting: $('#waiting'),
    game: $('#game'),
    name: $('#nameInput'),
    code: $('#codeInput'),
    joinForm: $('#joinForm'),
    playerCount: $('#playerCount'),
    codeEntry: $('#codeEntry'),
    homeError: $('#homeError'),
    roomCode: $('#roomCode'),
    waitingSub: $('#waitingSub'),
    seatList: $('#seatList'),
    shareLink: $('#shareLink'),
    scores: $('#scores'),
    roundChip: $('#roundChip'),
    codeChip: $('#codeChip'),
    table: $('#table'),
    opponents: $('#opponents'),
    drawPile: $('#drawPile'),
    drawCount: $('#drawCount'),
    drawPileArt: $('#drawPileArt'),
    topCard: $('#topCard'),
    turnBanner: $('#turnBanner'),
    logStrip: $('#logStrip'),
    hand: $('#hand'),
    actions: $('#actions'),
    chatPanel: $('#chatPanel'),
    chatLog: $('#chatLog'),
    chatForm: $('#chatForm'),
    chatInput: $('#chatInput'),
    stickerTray: $('#stickerTray'),
    toast: $('#toast'),
    conn: $('#conn'),
  };

  // ── Local state ──────────────────────────────────────
  let socket = null;
  let view = null;
  let me = null;
  let code = null;
  let token = null;
  let seatsWanted = 2;
  let intent = null; // { kind: 'create' } | { kind: 'join', code, token }
  let autoRejoin = null;
  let pendingCard = null;
  let retryDelay = 600;
  let toastTimer = null;
  let chatSeen = 0; // how many chat lines have been drawn
  let lastDealRound = -1;

  // A missing element used to fail silently much later, as a blank screen.
  for (const [key, node] of Object.entries(el)) {
    if (!node) throw new Error(`client is missing #${key} — markup and app.js have drifted apart`);
  }

  const voice = new window.UNOVoice.Voice({
    send: (kind, to, payload) => send({ t: 'voice', to, kind, payload }),
    onState: (s) => renderVoice(s),
  });

  const serverOrigin = () => window.UNO_SERVER_URL || window.location.origin;

  function wsUrl() {
    const u = new URL(serverOrigin(), window.location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = '';
    u.hash = '';
    return u.toString();
  }

  function basePath() {
    return window.location.pathname.replace(/\/room\/[A-Za-z0-9]{4}\/?$/, '').replace(/\/$/, '');
  }

  /**
   * Invite links carry the code as a query parameter, not a path: a query string
   * works on any static host without server rewrites.
   */
  function inviteLink() {
    return `${window.location.origin}${basePath()}/?room=${code}`;
  }

  function saveSession() {
    if (!code) return;
    try {
      localStorage.setItem(`uno:${code}`, JSON.stringify({ token, you: me, name: el.name.value.trim() }));
    } catch {
      /* private mode: the seat just will not survive a refresh */
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
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2800);
  }

  function setConnected(ok) {
    el.conn.classList.toggle('hidden', ok);
  }

  // ── Socket ────────────────────────────────────────────
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
        voice.setMe(me);
        chatSeen = 0;
        lastDealRound = -1;
        saveSession();
        history.replaceState(null, '', `${basePath()}/?room=${code}`);
        el.codeChip.textContent = code;
        el.shareLink.value = inviteLink();
        $('#shareLink2').value = inviteLink();
        el.roomCode.textContent = code;
        render(msg.view);
        break;

      case 'state':
        render(msg.view);
        break;

      case 'chat':
        appendChat([msg.entry]);
        break;

      case 'voice':
        voice.handle(msg.from, msg.kind, msg.payload);
        break;

      case 'error':
        if (/No game with that code/.test(msg.message)) {
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
    if (what.kind === 'create') send({ t: 'create', name, maxPlayers: what.maxPlayers });
    else joinRoom(what.code, name, what.token);
  }

  // ── Cards ─────────────────────────────────────────────
  function cardEl(card, { mini = false, hidden = false, animate = '' } = {}) {
    const node = document.createElement('div');
    node.className = hidden ? 'card face-down' : 'card';
    if (mini) node.classList.add('mini');
    if (animate) node.classList.add(animate);
    node.append(hidden ? window.UNOCards.backSvg() : window.UNOCards.cardSvg(card, { mini }));
    if (!hidden && card.color === 'W' && card.chosen) node.dataset.chosen = window.UNOCards.NAME[card.chosen];
    return node;
  }

  // ── Render ────────────────────────────────────────────
  function render(v) {
    view = v;
    // Follow whoever is talking, so a fresh joiner is not left mid-wait.
    if (v.waiting) return renderWaiting(v);

    show(el.game);
    voice.setVoicePeers((v.players || []).filter((p) => p.voice).map((p) => p.id));

    const myIndex = v.myIndex;
    const others = v.players.filter((p) => !p.isMe);
    const mePlayer = v.players[myIndex];

    // A new deal gets a card-dealing flourish, but only once per round.
    if (v.phase === 'playing' && v.roundNumber !== lastDealRound) {
      lastDealRound = v.roundNumber;
      el.table.classList.remove('dealing');
      void el.table.offsetWidth; // restart the animation
      el.table.classList.add('dealing');
    }

    $('#roundChip').textContent = `Round ${v.roundNumber}`;

    // Scoreboard
    el.scores.replaceChildren();
    for (const p of v.players) {
      const row = document.createElement('div');
      row.className = 'score';
      if (p.isTurn) row.classList.add('active-turn');
      if (!p.connected) row.classList.add('offline');

      row.title = `${p.name}: ${p.score} points, ${p.count} cards${p.connected ? '' : ' (disconnected)'}`;
      row.append(
        dot(p),
        textNode('span', 'nm', p.name + (p.isMe ? ' (you)' : '') + (p.isHost ? ' 👑' : '')),
        textNode('span', 'pts', `${p.score} pts`),
        textNode('span', 'sep', '·'),
        textNode('span', 'cards', `${p.count} cards`),
      );
      el.scores.append(row);
    }

    // Opponents around the table
    el.opponents.replaceChildren();
    others.forEach((other, i) => {
      const idx = v.players.findIndex((p) => p.id === other.id);
      const box = document.createElement('div');
      box.className = 'opponent';
      if (other.isTurn) box.classList.add('is-turn');
      if (!other.connected) box.classList.add('offline');
      box.style.setProperty('--slot', String(i + 1));

      const who = document.createElement('div');
      who.className = 'who';
      who.append(
        textNode('span', 'nm', other.name),
        ...(other.voice ? [textNode('span', 'mic', '🎙')] : []),
      );

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = other.connected
        ? `${other.count} card${other.count === 1 ? '' : 's'} · ${other.total} pts`
        : 'reconnecting…';

      const fan = document.createElement('div');
      fan.className = 'fan';
      for (let n = 0; n < other.count; n++) fan.append(cardEl(null, { mini: true, hidden: true, animate: 'deal-in' }));

      box.append(who, meta, fan);

      if (v.unoOpen && v.unoOpen.includes(idx)) {
        const warn = document.createElement('div');
        warn.className = 'warn-uno';
        warn.textContent = 'one card — no UNO called!';
        box.append(warn);
      }
      el.opponents.append(box);
    });

    // Table card and draw pile
    el.topCard.replaceChildren();
    if (v.top) {
      el.topCard.append(cardEl(v.top, { animate: 'play-in' }));
      if (v.top.color === 'W' && v.top.chosen) {
        const chip = document.createElement('span');
        chip.className = 'chosen-chip';
        chip.textContent = window.UNOCards.NAME[v.top.chosen];
        el.topCard.append(chip);
      }
    }
    el.drawCount.textContent = v.drawCount;
    if (el.drawPileArt && !el.drawPileArt.childElementCount) {
      el.drawPileArt.append(window.UNOCards.backSvg());
    }

    const myTurn = v.turn === myIndex && v.phase === 'playing';
    el.drawPile.disabled = !myTurn || !v.legal.includes('draw');

    // Turn banner
    const banner = document.createElement('div');
    if (v.phase !== 'playing') banner.textContent = 'Round over';
    else if (v.pendingDraw && v.pendingDraw.targetIndex === myIndex) {
      banner.innerHTML = `<span class="warn">Wild Draw Four — take ${v.pendingDraw.n}, or challenge it.</span>`;
    } else if (myTurn) banner.textContent = 'Your turn';
    else {
      const taker = v.players[v.turn];
      banner.textContent = `${taker ? taker.name : 'Someone'} is thinking…`;
    }
    el.turnBanner.replaceChildren(banner);

    el.logStrip.textContent = v.log[v.log.length - 1] || '';

    // Hand
    el.hand.replaceChildren();
    const playable = new Set(v.playable || []);
    for (const card of v.hand) {
      const node = cardEl(card, { animate: 'deal-in' });
      const can = myTurn && playable.has(card.id);
      if (!can) node.classList.add('dim');
      node.addEventListener('click', () => onCardClick(card, can));
      el.hand.append(node);
    }

    // Actions
    el.actions.replaceChildren();
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
      if (v.legal.includes('catch')) {
        for (const other of others) {
          const idx = v.players.findIndex((p) => p.id === other.id);
          if (v.unoOpen && v.unoOpen.includes(idx)) {
            button(`Caught you, ${other.name}!`, 'act-catch', () => act('catch', { target: idx }));
          }
        }
      }
    }

    if (v.phase === 'roundOver') showRoundBanner(v);
    else $('#roundBanner').classList.add('hidden');

    drawChat(v.chat || []);
  }

  function dot(p) {
    const d = document.createElement('span');
    d.className = 'dot';
    void p;
    return d;
  }

  function textNode(tag, cls, content) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.textContent = content;
    return n;
  }

  function button(label, cls, fn) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    el.actions.append(b);
    return b;
  }

  // ── Lobby ─────────────────────────────────────────────
  function renderWaiting(v) {
    show(el.waiting);
    el.roomCode.textContent = v.code;
    el.shareLink.value = inviteLink();
    $('#shareLink2').value = inviteLink();
    el.waitingSub.textContent =
      v.maxPlayers === v.players.length
        ? 'Table full — dealing now.'
        : `Send this link. The game starts at ${v.maxPlayers} players (or when the host starts early).`;

    el.seatList.replaceChildren();
    for (let i = 0; i < v.maxPlayers; i++) {
      const seat = v.players[i];
      const li = document.createElement('li');
      li.className = `seat${seat ? ' taken' : ' empty'}${seat?.isMe ? ' mine' : ''}`;
      li.append(
        textNode('span', 'seat-dot', ''),
        textNode('span', 'seat-name', seat ? seat.name + (seat.isHost ? ' 👑' : '') : 'waiting…'),
        seat ? textNode('span', 'seat-flag', seat.connected ? 'here' : 'away') : null,
      );
      el.seatList.append(li);
    }

    const start = $('#startBtn');
    start.classList.toggle('hidden', !(v.isHost && v.canStart));
    start.textContent = v.isFull ? 'Deal' : `Start with ${v.players.length}`;
    $('#resizeBtn').classList.toggle('hidden', !v.isHost);
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

    $('#tally').replaceChildren();
    for (const p of v.players) {
      const tr = document.createElement('tr');
      tr.append(
        textNode('td', '', p.name + (p.isMe ? ' (you)' : '')),
        textNode('td', '', `${p.score} pts · ${p.roundWins} round${p.roundWins === 1 ? '' : 'wins'}`),
      );
      $('#tally').append(tr);
    }
    if ($('#roundBanner').classList.contains('hidden')) $('#roundBanner').classList.remove('hidden');
  }

  // ── Chat ──────────────────────────────────────────────
  function appendChat(entries) {
    const log = el.chatLog;
    for (const entry of entries) {
      if (entry.seq <= chatSeen) continue; // skip lines already drawn
      chatSeen = entry.seq;

      const line = document.createElement('div');
      line.className = `chat-line${entry.from === me ? ' mine' : ''}`;
      line.append(textNode('span', 'chat-name', `${entry.name}: `));

      if (entry.sticker) {
        const s = document.createElement('span');
        s.className = 'sticker';
        s.textContent = window.UNOStickers.glyph(entry.sticker);
        s.title = entry.sticker;
        line.append(s);
      } else {
        line.append(textNode('span', 'chat-text', entry.text));
      }
      log.append(line);
      if (!el.chatPanel.classList.contains('hidden') || entry.from === me) {
        log.scrollTop = log.scrollHeight;
      } else {
        // Flag it rather than opening the panel over the table, which would
        // cover the cards and can sit on top of the Draw button.
        $('#chatToggle').classList.add('has-new');
        if (!entry.sticker) toast(`${entry.name}: ${entry.text}`);
        else toast(`${entry.name} sent a sticker`);
      }
    }
    while (log.childElementCount > 60) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  function drawChat(history) {
    const fresh = (history || []).filter((e) => e.seq > chatSeen);
    if (fresh.length) appendChat(fresh);
  }

  // ── Voice ─────────────────────────────────────────────
  function renderVoice(s) {
    const btn = $('#voiceBtn');
    if (s.error) toast(s.error);
    btn.classList.toggle('on', Boolean(s.enabled));
    btn.classList.toggle('muted', Boolean(s.enabled && s.muted));
    $('#voiceIcon').textContent = s.enabled ? (s.muted ? '🔇' : '🎙') : '🎙';
    $('#voiceLabel').textContent = s.enabled ? (s.muted ? 'Muted' : 'Live') : 'Voice';
    btn.title = s.enabled
      ? `${(s.peers || []).filter((p) => p.connected).length} connected. Voice uses data.`
      : 'Voice uses data — off by default';
  }

  $('#voiceBtn').addEventListener('click', () => {
    if (voice.enabled) {
      voice.setMuted(!voice.muted);
      return;
    }
    $('#voiceBanner').classList.remove('hidden');
  });

  $('#voiceGo').addEventListener('click', async () => {
    $('#voiceBanner').classList.add('hidden');
    const marks = (view?.players || []).filter((p) => p.voice).map((p) => p.id);
    await voice.enable();
    if (voice.enabled) act('voice', { enabled: true });
    voice.setVoicePeers(marks);
  });

  // ── Interaction ───────────────────────────────────────
  function onCardClick(card, can) {
    if (!can) return;
    if (card.color === 'W') {
      pendingCard = card;
      $('#colorPicker').classList.remove('hidden');
      return;
    }
    act('play', { cardId: card.id });
  }

  $('#colorGrid').replaceChildren();
  for (const c of COLOR_ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch ${c.toLowerCase()}`;
    b.textContent = COLOR_LABEL[c];
    b.addEventListener('click', () => {
      if (pendingCard) act('play', { cardId: pendingCard.id, color: c });
      pendingCard = null;
      $('#colorPicker').classList.add('hidden');
    });
    $('#colorGrid').append(b);
  }

  for (const node of document.querySelectorAll('[data-close]')) {
    node.addEventListener('click', () => document.getElementById(node.dataset.close).classList.add('hidden'));
  }

  $('#nextRoundBtn').addEventListener('click', () => {
    act('nextRound');
    $('#roundBanner').classList.add('hidden');
  });

  $('#drawPile').addEventListener('click', () => {
    el.drawPile.classList.remove('bump');
    void el.drawPile.offsetWidth;
    el.drawPile.classList.add('bump');
    act('draw');
  });

  $('#copyLinkBtn').addEventListener('click', () => {
    $('#shareLink2').value = inviteLink();
    $('#linkBanner').classList.remove('hidden');
  });
  $('#copyBtn2').addEventListener('click', () => copy(inviteLink()));
  $('#copyBtn').addEventListener('click', () => {
    el.shareLink.select();
    copy(el.shareLink.value);
  });

  function copy(text) {
    const done = () => toast('Link copied — send it to your friends.');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else {
      fallback();
    }
    function fallback() {
      $('#shareLink2').select();
      try {
        document.execCommand('copy');
        done();
      } catch {
        toast(text);
      }
    }
  }

  // ── Chat UI ───────────────────────────────────────────
  $('#chatToggle').addEventListener('click', () => {
    el.chatPanel.classList.toggle('hidden');
    $('#chatToggle').classList.remove('has-new');
    if (!el.chatPanel.classList.contains('hidden')) el.chatInput.focus();
  });
  $('#chatClose').addEventListener('click', () => el.chatPanel.classList.add('hidden'));

  el.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    send({ t: 'chat', text });
    el.chatInput.value = '';
  });

  el.stickerTray.replaceChildren();
  for (const sticker of window.UNOStickers.STICKERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sticker-btn';
    b.textContent = sticker.glyph;
    b.title = sticker.name;
    b.addEventListener('click', () => send({ t: 'chat', sticker: sticker.id }));
    el.stickerTray.append(b);
  }

  // ── Player count picker ───────────────────────────────
  for (const b of el.playerCount.querySelectorAll('.count')) {
    b.addEventListener('click', () => {
      seatsWanted = Number(b.dataset.seats);
      for (const other of el.playerCount.querySelectorAll('.count')) {
        other.setAttribute('aria-checked', String(other === b));
      }
    });
  }

  el.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    el.homeError.textContent = '';
    if (fromRoom) {
      const saved = loadSession(fromRoom);
      request({ kind: 'join', code: fromRoom, token: saved?.token ?? null });
    } else {
      request({ kind: 'create', maxPlayers: seatsWanted });
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

  $('#startBtn').addEventListener('click', () => act('start'));

  $('#resizeBtn').addEventListener('click', () => {
    const next = seatsWanted >= 6 ? 2 : seatsWanted + 1;
    seatsWanted = next;
    for (const other of el.playerCount.querySelectorAll('.count')) {
      other.setAttribute('aria-checked', String(Number(other.dataset.seats) === next));
    }
    act('addSeats', { maxPlayers: next });
  });

  $('#leaveWaiting').addEventListener('click', () => {
    send({ t: 'leave' });
    voice.disable();
    code = token = me = null;
    history.replaceState(null, '', `${basePath()}/`);
    show(el.home);
  });

  function roomCodeFromUrl() {
    const q = new URLSearchParams(window.location.search).get('room');
    if (q && /^[A-Za-z0-9]{4}$/.test(q)) return q.toUpperCase();
    const m = window.location.pathname.match(/^(?:.*\/)?room\/([A-Za-z0-9]{4})\/?$/);
    return m ? m[1].toUpperCase() : null;
  }

  // ── Boot ──────────────────────────────────────────────
  let fromRoom = null;
  fromRoom = roomCodeFromUrl();
  const saved = fromRoom ? loadSession(fromRoom) : null;

  if (fromRoom && saved?.token) {
    // Already holding a seat for this table: go straight back in.
    if (saved.name) el.name.value = saved.name;
    autoRejoin = { code: fromRoom, token: saved.token, name: saved.name };
    connect();
  } else if (fromRoom) {
    if (saved?.name) el.name.value = saved.name;
    $('#createBtn').textContent = 'Join the game';
    el.codeEntry.classList.add('hidden');
    el.home.focus?.();
    el.name.focus();
  } else {
    el.name.focus();
  }

  window.addEventListener('beforeunload', saveSession);
})();