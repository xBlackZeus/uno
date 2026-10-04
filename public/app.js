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
    voiceBtn: $('#voiceBtn'),
    voiceIcon: $('#voiceIcon'),
    voiceLabel: $('#voiceLabel'),
    voiceStatus: $('#voiceStatus'),
    soundBtn: $('#soundBtn'),
    soundIcon: $('#soundIcon'),
    soundLabel: $('#soundLabel'),
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
  let retryDelay = 600;
  let toastTimer = null;
  let chatSeen = 0; // how many chat lines have been drawn
  let lastDealRound = -1;

  // Selected-but-not-yet-played card. Null when nothing is chosen.
  let selectedCardId = null;
  // Where the last card we played was on screen, so the play can be animated
  // after the server confirms it. The DOM node is gone by then.
  let lastPlay = null;

  // Snapshots used to notice what changed between two server states, which is
  // how the client knows an animation is warranted rather than guessing.
  let prevTopId = null;
  let prevHandIds = [];
  let prevUnoOpen = [];
  let prevRound = -1;
  let prevRoundWinner = undefined;
  let prevTurn = -1;
  let prevPlayerIds = [];

  // A missing element used to fail silently much later, as a blank screen.
  for (const [key, node] of Object.entries(el)) {
    if (!node) throw new Error(`client is missing #${key} — markup and app.js have drifted apart`);
  }

  const sfx = window.UNOSfx;
  const motion = window.UNOMotion;
  const particles = new window.UNOParticles($('#fx'));

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
    motion.replay(el.toast, 'toast-pop');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2800);
    // The toast is the only place a transient message exists, so screen readers
    // get it too — otherwise a deaf player never learns why a move was refused.
    announce(message);
  }

  /** Pushes a message to assistive tech without showing anything on screen. */
  function announce(message) {
    if (!message) return;
    el.voiceStatus.textContent = '';
    // A tick apart, or repeated identical strings are not re-announced.
    setTimeout(() => {
      el.voiceStatus.textContent = message;
    }, 60);
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
        voice.setTurn(msg.turn || null);
        chatSeen = 0;
        lastDealRound = -1;
        prevTopId = null;
        prevHandIds = [];
        prevUnoOpen = [];
        prevRound = -1;
        prevRoundWinner = undefined;
        prevTurn = -1;
        prevPlayerIds = [];
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
    if (!hidden) {
      // Kept on the node so selection survives a re-render and the announcement
      // can name the card without holding a second copy of the hand.
      node.dataset.cardId = card.id;
      node.dataset.cardJson = JSON.stringify({ color: card.color, kind: card.kind, num: card.num, chosen: card.chosen });
    }
    return node;
  }

  // ── Render ────────────────────────────────────────────
  function render(v) {
    view = v;
    // Follow whoever is talking, so a fresh joiner is not left mid-wait.
    if (v.waiting) {
      prevPlayerIds = (v.players || []).map((p) => p.id);
      announcePlayerChanges(prevPlayerIds);
      return renderWaiting(v);
    }

    show(el.game);
    voice.setVoicePeers((v.players || []).filter((p) => p.voice).map((p) => p.id));

    const myIndex = v.myIndex;
    const others = v.players.filter((p) => !p.isMe);
    const mePlayer = v.players[myIndex];

    // Anything that changed since the last state gets a reaction, decided here
    // by comparing snapshots rather than by guessing from the DOM.
    reactToChange(v, myIndex);

    // A new deal gets a card-dealing flourish, but only once per round.
    if (v.phase === 'playing' && v.roundNumber !== lastDealRound) {
      lastDealRound = v.roundNumber;
      motion.replay(el.table, 'dealing');
      sfx.deal();
    }

    $('#roundChip').textContent = `Round ${v.roundNumber}`;

    // The table itself carries the turn state, so the current card can pulse
    // without anyone having to read a word.
    const myTurn = v.turn === myIndex && v.phase === 'playing';
    el.table.classList.toggle('my-turn', myTurn);

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
      if (other.voice) box.classList.add('has-voice');
      if (voice.isSpeaking?.(other.id)) box.classList.add('is-speaking');

      const who = document.createElement('div');
      who.className = 'who';
      who.append(
        textNode('span', 'nm', other.name),
        textNode('span', 'mic', other.voice ? '🎙' : '🔇'),
      );
      // The mic glyph is decorative; the state has to be in the text too.
      who.querySelector('.mic').setAttribute('aria-label', other.voice ? 'microphone on' : 'microphone off');
      if (voice.isSpeaking?.(other.id)) {
        who.querySelector('.mic').setAttribute('aria-label', 'speaking');
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = other.connected
        ? `${other.count} card${other.count === 1 ? '' : 's'} · ${other.total} pts`
        : 'reconnecting…';

      const fan = document.createElement('div');
      fan.className = 'fan';
      fan.setAttribute('aria-hidden', 'true');
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
      el.topCard.append(cardEl(v.top, { animate: motion.reduced ? '' : 'play-in' }));
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

    el.drawPile.disabled = !myTurn || !v.legal.includes('draw');
    el.drawPile.setAttribute(
      'aria-label',
      el.drawPile.disabled ? 'Draw a card (not your turn)' : `Draw a card, ${v.drawCount} left`,
    );

    // Turn banner
    const banner = document.createElement('div');
    if (v.phase !== 'playing') banner.textContent = 'Round over';
    else if (v.pendingDraw && v.pendingDraw.targetIndex === myIndex) {
      banner.innerHTML = '<span class="warn">Wild Draw Four — take the cards, or challenge it.</span>';
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
      const node = cardEl(card, { animate: motion.reduced ? '' : 'deal-in' });
      const can = myTurn && playable.has(card.id);
      if (!can) node.classList.add('dim');
      // Selection survives a re-render, otherwise every state push would drop
      // the highlight the player is in the middle of acting on.
      if (selectedCardId === card.id) node.classList.add('is-selected');
      node.dataset.playable = String(can);

      // Every card gets a handler, including unplayable ones: tapping a card
      // that cannot be played has to say so, not silently do nothing. Hanging
      // the handler only on playable cards is what made that feedback missing.
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      node.setAttribute(
        'aria-label',
        `${window.UNOCards.describe(card)} — ${can ? 'play this' : myTurn ? 'not playable now' : "player's turn is not yours"}`,
      );
      node.addEventListener('click', () => onCardClick(card, can, node));
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCardClick(card, can, node);
        }
      });
      el.hand.append(node);
    }

    // Actions
    el.actions.replaceChildren();
    if (v.phase === 'playing') {
      if (v.pendingDraw && v.pendingDraw.targetIndex === myIndex) {
        button('Take the cards', 'act-primary', () => act('accept'));
        if (v.pendingDraw.challengeable) button('Challenge!', 'act-catch', () => act('challenge'));
      } else {
        if (v.legal.includes('draw')) button('Draw', '', () => onDrawClick());
        if (v.legal.includes('pass')) button('Keep the card, end turn', '', () => act('pass'));
      }
      if (v.unoOpen && v.unoOpen.includes(myIndex)) {
        button('UNO!', 'act-uno', () => onUnoClick());
      }
      if (v.legal.includes('catch')) {
        for (const other of others) {
          const idx = v.players.findIndex((p) => p.id === other.id);
          if (v.unoOpen && v.unoOpen.includes(idx)) {
            button(`Caught you, ${other.name}!`, 'act-catch', () => onCatchClick(idx, other.name));
          }
        }
      }
    }

    if (v.phase === 'roundOver') showRoundBanner(v);
    else $('#roundBanner').classList.add('hidden');

    drawChat(v.chat || []);

    prevTopId = v.top?.id ?? null;
    prevHandIds = (v.hand || []).map((c) => c.id);
    prevUnoOpen = [...(v.unoOpen || [])];
    prevRound = v.roundNumber;
    prevRoundWinner = v.roundWinner;
    prevTurn = v.turn;
    prevPlayerIds = v.players.map((p) => p.id);
  }

  /**
   * Compares the incoming state with the last one and fires exactly the
   * reactions the change calls for. Every branch is a state *difference*, so
   * nothing fires spuriously when the server re-sends an unchanged view.
   */
  function reactToChange(v, myIndex) {
    const topId = v.top?.id ?? null;

    // Someone played a card.
    if (prevRound === v.roundNumber && topId && topId !== prevTopId) {
      const mine = lastPlay && lastPlay.round === v.roundNumber;
      if (mine && lastPlay.rect) {
        // Our own card: replay it flying from where the finger was.
        motion.flyFromRect(lastPlay.rect, el.topCard, { html: lastPlay.html, rotate: -7 });
      } else {
        sfx.play();
      }
      lastPlay = null;
    }

    // A card arrived in our hand.
    const handIds = (v.hand || []).map((c) => c.id);
    const gained = prevRound === v.roundNumber && handIds.length > prevHandIds.length;
    if (gained) {
      const newest = el.hand.lastElementChild;
      if (newest) motion.flyFromPile(el.drawPile, newest);
      sfx.draw();
    }

    // Somebody called UNO: they left the "has not called" list.
    const unoNow = new Set(v.unoOpen || []);
    for (const idx of prevUnoOpen) {
      if (!unoNow.has(idx)) celebrateUno(v.players[idx], idx === myIndex);
    }

    // Turn moved to us.
    if (prevTurn !== v.turn && v.turn === myIndex && v.phase === 'playing' && prevRound === v.roundNumber) {
      sfx.turn();
      announce('Your turn.');
    }

    // Round decided.
    if (prevRoundWinner === undefined && v.roundWinner !== null && v.roundWinner !== undefined) {
      celebrateWin(v, v.roundWinner === myIndex);
    }

    announcePlayerChanges(v.players.map((p) => p.id));
  }

  /** Join and leave cues, from the seat list alone. */
  function announcePlayerChanges(ids) {
    if (!prevPlayerIds.length) {
      prevPlayerIds = ids;
      return;
    }
    for (const id of ids) {
      if (!prevPlayerIds.includes(id)) sfx.join();
    }
    for (const id of prevPlayerIds) {
      if (!ids.includes(id)) sfx.leave();
    }
  }

  /** The UNO moment: a word, a flash and a burst from whoever called it. */
  function celebrateUno(player, isMe) {
    if (!player) return;
    if (isMe) {
      sfx.uno();
      announce('You called UNO.');
    } else {
      announce(`${player.name} called UNO.`);
    }

    if (motion.reduced) return;

    const anchor = isMe
      ? el.table.getBoundingClientRect()
      : el.opponents.querySelector('.is-speaking, .is-turn')?.getBoundingClientRect();
    const rect = anchor ?? el.table.getBoundingClientRect();

    const flash = document.createElement('div');
    flash.className = 'uno-flash';
    flash.textContent = 'UNO!';
    flash.setAttribute('aria-hidden', 'true');
    Object.assign(flash.style, {
      position: 'fixed',
      left: `${rect.left + rect.width / 2}px`,
      top: `${rect.top + rect.height / 2}px`,
      zIndex: '55',
      pointerEvents: 'none',
    });
    document.body.append(flash);
    flash.addEventListener('animationend', () => flash.remove(), { once: true });
    setTimeout(() => flash.remove(), 1200);

    particles.burst(rect.left + rect.width / 2, rect.top + rect.height / 2, { n: 30 });
  }

  /** Round won: confetti, a fanfare, and a clear statement of who won. */
  function celebrateWin(v, iWon) {
    sfx.win();
    if (iWon) announce(`You took the round. +${v.roundPoints} points.`);
    else announce(`${v.players[v.roundWinner]?.name ?? 'Someone'} took the round.`);

    if (motion.reduced) return;
    // Confetti from both top corners: reads as a celebration without hiding
    // the table, which the round banner is sitting on top of.
    particles.confetti({ originY: 0.18 });
    setTimeout(() => particles.confetti({ originY: 0.1 }), 260);
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
      const iWon = winner === v.myIndex;
      title.textContent = iWon ? 'You took the round' : `${name} took the round`;
      body.textContent = `+${v.roundPoints} points from the cards left on the table.`;
      title.classList.toggle('is-win', iWon);
    }

    $('#tally').replaceChildren();
    for (const p of v.players) {
      const tr = document.createElement('tr');
      if (p.isMe) tr.classList.add('is-me');
      tr.append(
        textNode('td', '', p.name + (p.isMe ? ' (you)' : '')),
        textNode('td', '', `${p.score} pts · ${p.roundWins} round${p.roundWins === 1 ? '' : 'wins'}`),
      );
      $('#tally').append(tr);
    }

    const banner = $('#roundBanner');
    if (banner.classList.contains('hidden')) {
      banner.classList.remove('hidden');
      $('#nextRoundBtn').focus();
    }
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

  /**
   * What to tell someone whose microphone will not start, per cause.
   *
   * The old single message ("This browser cannot do voice chat") was wrong for
   * the overwhelmingly common case, which is a page served over plain http from
   * a LAN address: the browser is fine, the transport is not. Saying so, with
   * the fix, is the entire difference between a useful error and a dead end.
   */
  const VOICE_HELP = {
    insecure_context: {
      title: 'Voice needs a secure connection',
      body:
        'Browsers only hand out the microphone over https, or on a computer at localhost. ' +
        'This page is on plain http, so the microphone is not available at all — this is not a ' +
        'problem with your phone or browser.',
      fix: 'To fix it, serve the game over https. See "Voice chat over a LAN" in the README.',
    },
    denied: {
      title: 'Microphone permission needed',
      body:
        'Your browser blocked the microphone. Tap the icon in the address bar, allow the microphone ' +
        'for this site, then try again.',
      fix: 'On iOS: Settings → Safari → Microphone. On Android: the padlock icon → Permissions.',
    },
    blocked: {
      title: 'Microphone blocked by the browser',
      body: 'This page is not allowed to use the microphone. A private or incognito window often does this.',
      fix: 'Try a normal window.',
    },
    no_device: {
      title: 'No microphone found',
      body: 'The browser opened but there is no microphone attached, or none that this browser can use.',
      fix: 'Check that a microphone is connected and not disabled in the system sound settings.',
    },
    device_busy: {
      title: 'Microphone is in use',
      body: 'Another app or tab is holding the microphone. Close the other one and try again.',
      fix: 'A video call in another tab is the usual culprit.',
    },
    device_lost: {
      title: 'Microphone disconnected',
      body: 'The microphone stopped mid-game — unplugged, or revoked by the system.',
      fix: 'Reconnect it and turn the microphone on again.',
    },
    autoplay_blocked: {
      title: 'Tap to hear the other players',
      body: 'Your browser will not play incoming sound until you interact with the page.',
      fix: 'Tap anywhere on the page once.',
    },
    no_api: {
      title: 'This browser has no microphone API',
      body: 'The browser genuinely does not implement getUserMedia. Voice chat cannot work here.',
      fix: 'Try a current version of Chrome, Safari or Firefox.',
    },
    no_webrtc: {
      title: 'This browser has no WebRTC',
      body: 'The browser cannot make peer-to-peer connections, which is how voice works here.',
      fix: 'Try a current version of Chrome, Safari or Firefox.',
    },
    negotiation_failed: {
      title: 'Voice connection failed',
      body: 'The connection to the other players could not be set up.',
      fix: 'Check your network and try turning the microphone off and on again.',
    },
    unknown: {
      title: 'Voice could not start',
      body: 'Something went wrong that this browser did not describe.',
      fix: 'Try turning the microphone off and on again.',
    },
  };

  function showVoiceHelp(code, detail) {
    const help = VOICE_HELP[code] ?? VOICE_HELP.unknown;
    $('#voiceHelpTitle').textContent = help.title;
    $('#voiceHelpBody').textContent = `${help.body} ${help.fix}`;
    $('#voiceHelpTech').textContent = [
      `code: ${code}`,
      `isSecureContext: ${window.isSecureContext}`,
      `origin: ${location.origin}`,
      `navigator.mediaDevices: ${navigator.mediaDevices ? 'present' : 'undefined'}`,
      detail ? `error: ${detail}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    $('#voiceHelp').classList.remove('hidden');
    $('#voiceHelpOk').focus();
    sfx.error();
  }

  /** Maps the voice state machine onto the dock button. */
  function renderVoice(s) {
    const btn = el.voiceBtn;
    if (s.error && s.error.code !== 'autoplay_blocked') showVoiceHelp(s.error.code, s.error.detail);

    const connected = (s.peers || []).filter((p) => p.connected).length;
    const peerTotal = (s.peers || []).length;

    btn.classList.toggle('is-live', s.status === 'live' && !s.muted);
    btn.classList.toggle('is-muted', s.status === 'live' && s.muted);
    btn.classList.toggle('is-connecting', s.status === 'starting' || s.status === 'reconnecting');
    btn.classList.toggle('is-error', s.status === 'error');

    let icon = '🎙';
    let label = 'Voice';
    let title = 'Talk to the other players. Uses data, off by default.';

    switch (s.status) {
      case 'starting':
        icon = '⏳';
        label = 'Starting';
        title = 'Waiting for microphone permission…';
        break;
      case 'reconnecting':
        icon = '🔄';
        label = 'Reconnecting';
        title = 'Lost the other players. Retrying…';
        break;
      case 'live':
        if (s.muted) {
          icon = '🔇';
          label = 'Muted';
          title = 'Tap to unmute';
        } else {
          icon = '🎙';
          label = peerTotal ? `Live ${connected}/${peerTotal}` : 'Live';
          title = connected ? `${connected} player(s) connected` : 'Waiting for others to turn their mic on';
        }
        break;
      case 'error':
        icon = '⚠️';
        label = 'No mic';
        title = (VOICE_HELP[s.error?.code] ?? VOICE_HELP.unknown).title;
        break;
      default:
        icon = '🎙';
        label = 'Voice';
    }

    el.voiceIcon.textContent = icon;
    el.voiceLabel.textContent = label;
    btn.title = title;
    // The visible label is short; the accessible name carries the detail.
    btn.setAttribute('aria-label', `Voice: ${label}. ${title}`);

    // The disconnect control only exists while there is something to disconnect.
    $('#voiceOff').classList.toggle('hidden', !s.enabled);

    const status = s.enabled ? (s.muted ? 'muted' : 'live') : s.status;
    if (el.voiceStatus.textContent !== status) el.voiceStatus.textContent = status;
  }

  el.voiceBtn.addEventListener('click', () => {
    sfx.unlock();
    sfx.tap();
    if (voice.enabled) {
      voice.setMuted(!voice.muted);
      return;
    }
    // Fail before showing the consent dialog if the browser simply cannot.
    const verdict = window.UNOVoice.diagnose();
    if (!verdict.ok) {
      showVoiceHelp(verdict.code, verdict.detail);
      return;
    }
    $('#voiceBanner').classList.remove('hidden');
  });

  $('#voiceGo').addEventListener('click', async () => {
    $('#voiceBanner').classList.add('hidden');
    const marks = (view?.players || []).filter((p) => p.voice).map((p) => p.id);
    sfx.unlock();
    const ok = await voice.enable();
    if (ok) act('voice', { enabled: true });
    voice.setVoicePeers(marks);
  });

  $('#voiceHelpOk').addEventListener('click', () => $('#voiceHelp').classList.add('hidden'));

  // Fully disconnect: stops the tracks, tells the server, and hides itself.
  $('#voiceOff').addEventListener('click', () => {
    sfx.unlock();
    sfx.tap();
    voice.disable();
    if (voice.enabled === false) act('voice', { enabled: false });
    toast('Voice off. The microphone has been released.');
    announce('Voice turned off.');
  });


  // ── Interaction ───────────────────────────────────────

  /**
   * Tapping a card selects it; tapping the selected card plays it. Selection is
   * explicit rather than hover-based because hover does not exist on a phone,
   * and it gives a stray tap somewhere harmless a way to cancel.
   */
  function onCardClick(card, can, node) {
    if (!can) {
      sfx.reject();
      motion.shake(el.hand);
      node?.classList.add('is-nope');
      const mine = view?.turn === view?.myIndex;
      const why = mine
        ? `${window.UNOCards.describe(card)} does not match the ${describeTop()}.`
        : `It is not your turn — ${view?.players[view?.turn]?.name ?? 'someone else'} is playing.`;
      toast(why);
      announce(why);
      setTimeout(() => node?.classList.remove('is-nope'), 500);
      return;
    }
    sfx.unlock();
    sfx.tap();

    if (card.color === 'W') {
      // A wild needs a colour before it can go, so selection stops here.
      selectedCardId = card.id;
      markSelected(card.id);
      lastPlay = rememberCard(node, card);
      $('#colorPicker').classList.remove('hidden');
      const first = $('#colorGrid button');
      first?.focus();
      return;
    }

    // Same card again means "yes, play it".
    if (selectedCardId === card.id) {
      commitPlay(card, node);
      return;
    }

    selectedCardId = card.id;
    markSelected(card.id);
  }

  /** Names the card on the table, so "why can't I play this" has an answer. */
  function describeTop() {
    const top = view?.top;
    if (!top) return 'card on the table';
    const name = window.UNOCards.describe(top);
    return top.color === 'W' && top.chosen ? `${name} (called ${window.UNOCards.NAME[top.chosen]})` : name;
  }

  function markSelected(id) {
    for (const node of el.hand.children) {
      node.classList.toggle('is-selected', node.dataset.cardId === id);
    }
    const chosen = [...el.hand.children].find((n) => n.dataset.cardId === id);
    if (chosen) announce(`${window.UNOCards.describe(JSON.parse(chosen.dataset.cardJson))} selected. Tap again to play it.`);
  }

  /** Snapshot where a card sits and what it looks like, for the play animation. */
  function rememberCard(node, card) {
    if (!node) return null;
    return {
      round: view?.roundNumber ?? -1,
      rect: node.getBoundingClientRect(),
      html: node.innerHTML,
    };
  }

  function commitPlay(card, node) {
    selectedCardId = null;
    lastPlay = rememberCard(node, card);
    act('play', { cardId: card.id });
  }

  function onDrawClick() {
    sfx.unlock();
    sfx.tap();
    motion.replay(el.drawPile, 'bump');
    act('draw');
  }

  function onUnoClick() {
    sfx.unlock();
    sfx.uno();
    act('uno');
  }

  function onCatchClick(idx, name) {
    sfx.caught();
    motion.shake(el.actions);
    toast(`Caught ${name} without calling UNO — two cards.`);
    act('catch', { target: idx });
  }

  $('#colorGrid').replaceChildren();
  for (const c of COLOR_ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch ${c.toLowerCase()}`;
    b.textContent = COLOR_LABEL[c];
    b.addEventListener('click', () => {
      const card = (view?.hand || []).find((x) => x.id === selectedCardId);
      selectedCardId = null;
      $('#colorPicker').classList.add('hidden');
      if (!card) return;
      sfx.unlock();
      sfx.tap();
      lastPlay = lastPlay || { round: view?.roundNumber ?? -1, rect: null, html: null };
      act('play', { cardId: card.id, color: c });
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
    if (el.drawPile.disabled) {
      sfx.reject();
      motion.shake(el.drawPile);
      return;
    }
    onDrawClick();
  });

  $('#soundBtn').addEventListener('click', () => {
    const next = !sfx.enabled;
    sfx.unlock(); // the click is the gesture the autoplay policy wants
    sfx.setEnabled(next);
    renderSound();
    if (next) sfx.tap();
  });

  function renderSound() {
    const on = sfx.enabled;
    el.soundBtn.setAttribute('aria-pressed', String(on));
    el.soundIcon.textContent = on ? '🔊' : '🔇';
    el.soundLabel.textContent = on ? 'Sound' : 'Muted';
    el.soundBtn.title = on ? 'Sound on — tap to mute' : 'Sound muted — tap to unmute';
    el.soundBtn.setAttribute('aria-label', on ? 'Sound on' : 'Sound muted');
  }

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
    act('voice', { enabled: false });
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

  renderSound();

  // Audio can only start inside a real user gesture. Arm it on the first one of
  // any kind — clicking a card, the page itself — and never before.
  const unlockOnce = () => {
    sfx.unlock();
    window.removeEventListener('pointerdown', unlockOnce);
    window.removeEventListener('keydown', unlockOnce);
  };
  window.addEventListener('pointerdown', unlockOnce, { once: false });
  window.addEventListener('keydown', unlockOnce, { once: false });

  // If the player turns reduced motion on mid-session, re-render so anything
  // relying on it settles into the new setting immediately.
  motion.onPreferenceChange(() => {
    if (view && !view.waiting) render(view);
  });

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