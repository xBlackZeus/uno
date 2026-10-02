# UNO — play a friend online

Create a game, send your friend one link, and play as many rounds as you like.
Full UNO rules, two players, no accounts.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 74 tests: rules engine + real WebSocket clients
```

To try it with a friend on your network, give them `http://<your-ip>:3000`.

---

## How the pieces fit

| File | What it does |
|---|---|
| `server/game.js` | The rules. Pure functions, no I/O. This is the only place a legal move is decided. |
| `server/rooms.js` | Who is at which table, and the game behind it. |
| `server/index.js` | HTTP (serves the client) + WebSocket (`/ws`). |
| `public/` | The client. Sends intents, renders whatever the server says is true. |

**The server owns the game.** A browser only ever sends intents (`play`, `draw`,
`accept`, `challenge`, `uno`, `catch`, `nextRound`). It never decides what is
legal, so the two clients cannot drift apart or cheat. The server also decides
which of your cards are playable and names them in the view, so the UI cannot
disagree with the rules.

**Hands are never sent to the wrong player.** `viewFor()` gives you your own
cards and only a *count* for your opponent's hand. Three tests assert that no
opponent card id, and no draw-pile card id, ever appears in the payload you
receive.

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

## Reliability

- **Refreshing or losing connection keeps your seat** for 30 minutes. Your seat
  token lives in `localStorage`, so reopening the invite link walks you straight
  back to the table with your hand intact.
- Reopening the same game in a second tab replaces the first connection rather
  than duplicating your seat.
- Abandoned rooms are swept up after six hours.

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