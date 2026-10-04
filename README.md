# UNO — play your friends online

Create a game, send one link, and play as many rounds as you like. Up to six
players, with chat, stickers and optional voice. Full UNO rules, no accounts.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 88 tests: rules engine + real WebSocket clients
```

To try it with friends on your network, give them `http://<your-ip>:3000`.
Voice chat needs HTTPS in production: browsers only grant microphone access on
a secure origin (or localhost).

---

## How the pieces fit

| File | What it does |
|---|---|
| `server/game.js` | The rules. Pure functions, no I/O. This is the only place a legal move is decided. |
| `server/rooms.js` | Who is at which table, and the game behind it. |
| `server/index.js` | HTTP or HTTPS (serves the client) + WebSocket (`/ws`). |
| `public/cards.js` | Card artwork, drawn as inline SVG. |
| `public/stickers.js` | The built-in sticker set (glyphs, not images). |
| `public/voice.js` | WebRTC mesh, capability diagnostics, and reconnection. |
| `public/motion.js` | Every animation, with one timing table and a reduced-motion gate. |
| `public/sfx.js` | Sound effects, synthesised — no audio files. |
| `public/particles.js` | Confetti and bursts on one canvas. |
| `public/app.js` | The client. Sends intents, renders whatever the server says is true. |


**The server owns the game.** A browser only ever sends intents (`play`, `draw`,
`accept`, `challenge`, `uno`, `catch`, `nextRound`). It never decides what is
legal, so the two clients cannot drift apart or cheat. The server also decides
which of your cards are playable and names them in the view, so the UI cannot
disagree with the rules.

**Hands are never sent to the wrong player.** `viewFor()` gives you your own
cards and only a *count* for your opponent's hand. Three tests assert that no
opponent card id, and no draw-pile card id, ever appears in the payload you
receive.

## How the interface is put together

The client is plain DOM — no framework — and that is a deliberate choice rather
than a leftover: the whole UI is a re-render of one small view object, and a
virtual DOM would add a build step and a bundle to solve a problem this app does
not have.

**Animations react to differences between two states, not to guesses.** The
server re-sends the full view on every change, so the client keeps a snapshot of
the last one and compares. A card flies to the table because `top.id` actually
changed, and a UNO burst fires because a player left `unoOpen` — not because a
DOM node happened to appear. That is why effects cannot fire spuriously, and why
they still fire when the change came from another player.

**One timing table, mirrored in two places.** `UNOMotion.duration` and the
`--t-*` custom properties in `style.css` hold the same values, so a CSS
transition and a JS animation of the same effect cannot drift apart.

**Only `transform` and `opacity` are animated.** Those are compositor-only
properties and never trigger layout, which is what keeps a mid-range Android
from dropping frames mid-turn. Confetti is one `<canvas>` with one
`requestAnimationFrame` loop that stops when the particles are gone — a burst of
150 `<div>`s would cost 150 paint objects at the exact moment the player is
watching.

**Selection is a real state, not a hover.** `.is-selected` is applied by the
client and survives a re-render, because otherwise every state push would drop
the highlight the player is in the middle of acting on. All hover styling is
inside `@media (hover: hover)` — on a touchscreen `:hover` sticks after a tap,
which makes a card look selected when it is not.

**Reduced motion removes movement, never feedback.** Under
`prefers-reduced-motion` a card still appears, a turn still highlights and a
toast still shows; they simply arrive at once, and selection keeps its ring
rather than its lift.

## The rules

Standard 108-card deck: four colours, one `0` and two of each `1`–`9` per colour,
two each of skip / reverse / draw-two, plus four wilds and four wild draw-fours.

- Match the colour or the number; wilds and wild draw-fours always playable.
- **Skip** jumps a seat. **Reverse** turns the direction — and, with two players,
  hands the turn straight back.
- **Draw Two** costs the next player two cards and skips them.
- **Wild** — you pick the colour. **Wild Draw Four** — you pick the colour and
  the next player draws four and is skipped.
- **Challenge** on a wild draw four. The server remembers whether you were
  actually holding the colour you called. If you were, the challenger draws six
  and you get the turn back. If you were not, the challenger draws four.
- **Draw** and you may only play the card you just drew; if it does not fit, the
  turn passes.
- **UNO** — call it when you are down to one card. Say it late and you draw two
  automatically. Your opponent can also catch you and make you draw two. Both
  come from the same rule, so nobody escapes it.
- Scoring: numbers are worth their face, actions 20, wilds 50. The winner of a
  round scores everything left in the other hands. Scores carry over and rounds
  keep being dealt until you both stop.
- A round that somehow runs past 400 plays is abandoned so a table cannot
  soft-lock. In practice you would have to refuse to call UNO the whole time.

Two deliberate simplifications, both to keep the rules unambiguous: draw twos
cannot be stacked (the penalty is mandatory), and a round is not capped at 500
points — it just keeps going, as asked.

## More than two players

Pick 2–6 when you create the game. The deal starts when the table fills, or
sooner if the host presses **Start now** — handy when you would rather not wait
for a sixth person. The host can resize the table any time before the deal, and
the crown in the scoreboard shows who that is.

Everything else is unchanged: hands stay hidden, the server still decides every
move, and the turn passes properly around a table of any size. If someone drops
mid-turn, the turn is handed on rather than stalling on a ghost seat, and their
seat is kept for 30 minutes.

## Chat, stickers and voice

**Chat** is its own small message type. It deliberately does *not* carry the
board — text is the most frequent traffic in the app, and bundling the game
state with every sentence would make "ok" cost a full state push.

**Stickers** are a built-in set of glyphs, not uploaded images. An image sticker
is tens of kilobytes that every player downloads; a sticker here is a few bytes
of a short id, so a table can spam them all day for almost nothing. Uploaded
images would also need somewhere to live — there is no storage in this project.
Messages are capped at 400 characters and the last 40 lines are kept.

**Voice** is peer-to-peer WebRTC. The server relays the offer/answer/ICE
handshake between two players and stores none of it — it never sees or forwards
a byte of audio. Each player holds a connection to each other player, which is
fine for six and would not scale to a hundred.

### Voice chat over a LAN

**Voice needs a secure context, and that is the whole story.** Browsers only
expose `navigator.mediaDevices` on an `https://` origin — or on `http://localhost`
and `http://127.0.0.1`, which they treat as trustworthy. Open the game from a
phone at `http://192.168.1.10:3000` and `navigator.mediaDevices` is not merely
unusable, it is **absent**, so there is no microphone to ask for. The game still
plays perfectly; only voice is unreachable.

This is not a phone problem and not a browser bug. It is a transport problem, and
it is worth being precise about because the symptom looks exactly like a
browser limitation:

| Origin | `isSecureContext` | `navigator.mediaDevices` | Voice |
| --- | --- | --- | --- |
| `http://localhost:3000` | `true` | present | works |
| `http://192.168.1.10:3000` | `false` | **undefined** | impossible |
| `https://192.168.1.10:3000` | `true` | present | works |

The client no longer reports this as "this browser cannot do voice chat". It
checks `isSecureContext` separately from the API check and names the real cause,
with the fix, in a dialog — see `VOICE_HELP` in `public/app.js`.

To make voice work from another device, serve over TLS. The server switches to
HTTPS automatically when it finds a certificate and key, and the WebSocket
upgrade rides along as `wss://`:

```bash
mkdir -p certs
mkcert -install                       # install the local CA once
mkcert -cert-file certs/cert.pem -key-file certs/key.pem \
       localhost 127.0.0.1 192.168.1.10 # list every address players will use
npm start                              # now on https://
```

Then open `https://192.168.1.10:3000` and install the mkcert CA on each phone
(Chrome: settings → install certificate; iOS: install the profile, then enable
it under Settings → General → About → Certificate Trust). Once the CA is
trusted there is no browser warning.

Point at certificates somewhere else with `TLS_CERT` and `TLS_KEY` instead of
using `./certs`. Both are needed; with only one the server says so and stays on
plain HTTP rather than failing mysteriously.

A bare `openssl req -x509` self-signed certificate does technically restore a
secure context once the player clicks past the warning, but every device has to
be told to trust it individually, which is worse than the mkcert route. On iOS
it tends to fail outright rather than degrade.

**TURN, if direct connections do not work.** STUN is enough on most home
networks. Two players behind symmetric NAT, or on carriers that block
peer-to-peer traffic, will need a relay. Set these and the server hands the
credentials to each client when it joins, so nothing is baked into the bundle:

```bash
TURN_URL=turn:your-turn-host:3478 TURN_USERNAME=… TURN_CREDENTIAL=… npm start
```

### The honest part about data

Voice is the only thing here that costs real bandwidth, and it costs far more
than everything else combined: roughly **24 kbps per player** while talking, on
top of a few hundred bytes of signalling once per peer. So:

- Voice is **opt-in and off by default**, and the UI says what it costs before
  you allow the microphone.
- The dock button shows whether your mic is live or muted, and who else is on
  voice. A player's ring pulses while their audio level is actually above the
  noise floor, measured from the stream rather than assumed from "they have a
  mic on".
- Muting disables the audio track without tearing down the connection, so
  un-muting is instant and costs nothing to set up again. The separate **End**
  button is what releases the microphone completely.
- Voice reconnects on its own with a capped backoff if a phone sleeps, changes
  Wi-Fi or loses signal, which show up as `disconnected` rather than `failed`.
- If nobody turns it on, the app uses no more data than before voice existed.


Everything else is deliberately cheap:

- `permessage-deflate` is on for the WebSocket, which suits chat and card state
  because both are highly repetitive.
- Chat and stickers do not trigger a board broadcast.
- Voice presence changes and table resizes send only the lobby, never the cards.
- Animations are entirely local — they cost no data at all, only frame rate.

## Reliability

- **Refreshing or losing connection keeps your seat** for 30 minutes. Your seat
  token lives in `localStorage`, so reopening the invite link walks you straight
  back to the table with your hand intact.
- Reopening the same game in a second tab replaces the first connection rather
  than duplicating your seat.
- Abandoned rooms are swept up after six hours.
- **A port already in use is a sentence, not a stack trace.** Starting a second
  copy tells you how to find and stop the first one, or how to use another port.
- Audio preferences survive a reload, and sound only begins after a real user
  gesture, so nothing ever trips the autoplay policy.

## Configuration

All optional. With none of them set the server runs plain HTTP on port 3000 and
everything except voice works.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. All interfaces by default. |
| `TLS_CERT` | `./certs/cert.pem` | Certificate. Its presence switches the server to HTTPS. |
| `TLS_KEY` | `./certs/key.pem` | Private key. Both are required to enable TLS. |
| `TURN_URL` | — | TURN relay for voice, e.g. `turn:host:3478`. |
| `TURN_USERNAME` | — | TURN username. |
| `TURN_CREDENTIAL` | — | TURN credential. |

Nothing secret is ever committed: TURN credentials are read from the
environment and handed to clients at join time, so they stay out of the
JavaScript bundle.

## Deploying

GitHub Pages serves static files only, so it cannot host a live game. The two
halves are deployed separately, both from this one repository.

**1. Push to GitHub**, then turn Pages on: *Settings → Pages → Source: GitHub
Actions*. The workflow in `.github/workflows/deploy.yml` runs the test suite and
publishes `public/` to `https://<you>.github.io/<repo>/`.

**2. Host the server.** The free tier of Render reads `render.yaml` directly:
*New → Blueprint → your repository*. Any host that runs `npm start` and exposes
`/healthz` works the same way. Note that a free service sleeps when idle, so the
first game after a quiet spell waits for it to wake.

**3. Connect them.** Add a repository secret `UNO_SERVER_URL` set to your server
address, e.g. `https://uno-server.onrender.com`. The workflow writes it into
`public/config.js` at build time.

Invite links carry the code as `?room=ABCD` rather than as a path, because a
query string works on any static host — no server rewrites, and relative asset
URLs keep resolving. `/room/ABCD` still works if someone types it.

To skip Pages entirely, just open the Node server's own URL: it serves the client
too, so there is one link to share and nothing to configure.