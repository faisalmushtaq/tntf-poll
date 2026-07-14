# ⚽ Tuesday Night Total Football

A mobile-first web app for picking who plays each week — built to fix the
problems with the WhatsApp poll:

- **The poll appears at random times** → whoever's looking at their phone grabs
  a spot. People on the pitch, driving, or busy miss out.
- **First-come-first-served isn't fair** → it rewards fast tappers, not regulars.
- **Last-minute dropouts aren't penalised** → the game gets left short.
- **7-a-side vs 8-a-side** was never settled.

## How it fixes each one

| Problem | Fix |
|---|---|
| Random poll timing | Organiser opens the game at a **consistent time** each week (defaults to the next game-day + kickoff). |
| Race to tap first | When oversubscribed, the squad is the **top N by loyalty score**, not sign-up order. A regular who signs up late still ranks above a casual who got in early — so there's no need to hover over your phone. |
| No reward for regulars | You earn **+2 loyalty** every game you actually play. Higher loyalty = higher priority. |
| Unpunished dropouts | **Time-weighted penalty**: pulling out 2+ days ahead is free; same-day and last-minute cost loyalty (as Tom suggested). The app shows you the cost *before* you confirm. |
| Squad size | Configurable per game — default **14 (7-a-side)**, set 16 or anything else when you open the game. |
| People who miss out | An automatic **waitlist** — if someone drops, the next player by loyalty is promoted. |

## Screens

- **This week** — the live squad, the waitlist, and your one-tap *I'm in* /
  *Withdraw* (with the penalty shown up front).
- **Table** — the loyalty leaderboard, so the pecking order is transparent.
- **Rules** — a plain-English explainer of the system and the penalty scale.
- **Organiser** — PIN-protected: open/lock/complete the game, manage the roster,
  nudge loyalty by hand, and change all the settings (game day, kickoff, squad
  size, penalty scale, PIN).

## Run it

No dependencies, no build step — just Node 18+:

```bash
node server.js
# ⚽ TNTF running at http://localhost:3000
```

Open it on your phone (same Wi-Fi: `http://<your-computer-ip>:3000`).

Data is stored in a single `data.json` file (created on first run, git-ignored).
The roster is seeded from the group so it's usable immediately — edit it in the
Organiser tab.

### Organiser PIN

Default PIN is **`1234`** — change it in **Organiser → Settings** straight away.

## Deploy

It's a single Node process with a JSON file, so it runs anywhere that runs Node:

- **Render / Railway / Fly.io / Cyclic** — point at this repo, start command
  `node server.js`. Set a persistent disk (or volume) so `data.json` survives
  restarts. `PORT` is read from the environment.
- **A Raspberry Pi / spare box on your network** — `node server.js` and share
  the local URL in the group chat.

Then just drop the link in the WhatsApp group.

## The loyalty model (tweakable in Settings)

- **Play a game:** `+2` loyalty.
- **Withdraw** (penalty scales with how close to kickoff):
  - `2+ days before` → free
  - `1–2 days before` → `-1`
  - `same day` → `-3`
  - `last minute / no-show` → `-5`
- **Selection:** active sign-ups are ranked by loyalty (desc), ties broken by who
  signed up first. Top `capacity` are confirmed; the rest waitlist.

Everything above is editable by the organiser without touching code.
