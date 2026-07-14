# ⚽ Tuesday Night Total Football

A mobile-first web app for picking who plays each week — it runs **entirely on
GitHub**. The app is static (hosted free on **GitHub Pages**) and the shared data
lives in **Firebase Firestore**. No server to run or pay for.

It's built to fix the problems with the WhatsApp poll:

- **The poll appears at random times** → whoever's looking at their phone grabs
  a spot. People on the pitch, driving, or busy miss out.
- **First-come-first-served isn't fair** → it rewards fast tappers, not regulars.
- **Last-minute dropouts aren't penalised** → the game gets left short.
- **7-a-side vs 8-a-side** was never settled.

## How it fixes each one

| Problem | Fix |
|---|---|
| Random poll timing | The organiser opens the game at a **consistent time** each week (defaults to the next game-day + kickoff). |
| Race to tap first | When oversubscribed, the squad is the **top N by loyalty score**, not sign-up order. A regular who signs up late still ranks above a casual who got in early — so there's no need to hover over your phone. |
| No reward for regulars | You earn **+2 loyalty** every game you actually play. Higher loyalty = higher priority. |
| Unpunished dropouts | **Time-weighted penalty**: pulling out 2+ days ahead is free; same-day and last-minute cost loyalty (as Tom suggested). The app shows the cost *before* you confirm. |
| Squad size | Configurable per game — default **14 (7-a-side)**, set 16 or anything else when you open the game. |
| People who miss out | An automatic **waitlist** — if someone drops, the next player by loyalty is promoted, live. |

## Screens

- **This week** — the live squad, the waitlist, and your one-tap *I'm in* /
  *Withdraw* (with the penalty shown up front).
- **Table** — the loyalty leaderboard, so the pecking order is transparent.
- **Rules** — a plain-English explainer of the system and the penalty scale.
- **Organiser** — PIN-protected: open/lock/complete the game, manage the roster,
  nudge loyalty by hand, and change every setting.

---

## Setup (one-time, ~10 minutes)

You need two free things: a Firebase project (the database) and GitHub Pages
turned on (the hosting). This repo already contains all the code.

### 1. Create the Firebase database

1. Go to <https://console.firebase.google.com> → **Add project** (the free
   *Spark* plan is plenty).
2. **Build → Firestore Database → Create database** → *Start in production
   mode* → pick a region near you.
3. **Firestore → Rules** tab → paste the contents of [`firestore.rules`](./firestore.rules)
   → **Publish**.
4. **Project settings** (gear icon) → **Your apps** → Web (**`</>`**) → register
   an app → copy the `firebaseConfig` values it shows you.

### 2. Add your config to the app

Edit [`public/firebase-config.js`](./public/firebase-config.js) and paste your
values into the `firebaseConfig` object. Commit and push:

```bash
git add public/firebase-config.js
git commit -m "Add Firebase config"
git push
```

(These values are **not secret** — Firebase web config is meant to be public.
Access is controlled by `firestore.rules`, not by hiding the keys.)

### 3. Turn on GitHub Pages

In the repo on GitHub: **Settings → Pages → Build and deployment → Source:
GitHub Actions**. That's it — the included workflow
([`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml))
deploys `public/` on every push to `main`.

Your app goes live at `https://<your-username>.github.io/tntf-poll/`. Drop that
link in the WhatsApp group.

### 4. First run

- Open the app, go to **Organiser**, unlock with the default PIN **`1234`**, and
  **change the PIN** in Settings straight away.
- The roster is pre-seeded from the group — edit names / add players in the
  Organiser tab.
- After each game, open **Organiser → Mark as played** to bank everyone's
  loyalty, then **Open the game** for next week.

---

## Try it locally first (optional)

Without any Firebase config, the app runs in **demo mode** using your browser's
`localStorage` — fully working, but single-device (not shared). Good for a
look before you wire up Firebase.

```bash
npm run serve      # static preview at http://localhost:3000
npm test           # runs the selection/penalty logic checks
```

## The loyalty model (all editable in Settings)

- **Play a game:** `+2` loyalty.
- **Withdraw** — penalty scales with how close to kickoff you pull out:
  | When you drop | Penalty |
  |---|---|
  | 2+ days before | free |
  | 1–2 days before | −1 |
  | same day | −3 |
  | last minute / no-show | −5 |
- **Selection:** active sign-ups ranked by loyalty (desc), ties broken by who
  signed up first. Top `capacity` confirmed, the rest waitlist.

## How it's built

- `public/` — the whole app: `index.html`, `styles.css`, and three ES modules:
  - `logic.js` — pure selection/penalty maths (unit-tested in `test/`).
  - `db.js` — data layer: Firestore when configured, `localStorage` otherwise.
  - `app.js` — the mobile UI.
- No build step, no framework, no bundler. What's in `public/` is what ships.

## A note on security

This is a private link shared in one group chat, so the rules let anyone with
the link read and register, and the organiser PIN is a *soft* gate (it stops
accidental taps, not a determined tinkerer). For proper admin lock-down, enable
Firebase Authentication and restrict the admin paths to your account — there's a
commented recipe at the bottom of [`firestore.rules`](./firestore.rules).
