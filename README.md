# ⚽ Tuesday Night Total Football

A mobile-first web app for picking who plays each week — it runs **entirely on
GitHub**. The app is static (hosted free on **GitHub Pages**), the shared data
lives in **Firebase Firestore**, and a scheduled **GitHub Action** sends the
email / push notifications. No server to run or pay for.

An editorial look — near-white paper, one serif (Newsreader), hairline rules
and the **club crest** in the masthead and on your profile. A custom icon set
carries throughout: bib/vest markers on every team column, weather glyphs at
kickoff, and goal / own-goal / man-of-the-match marks on the match report. The
icons live in [`public/assets/`](./public/assets/) (source SVGs) with the crest
also exported as the PWA/app icon.

## What it solves

| Problem (from the group chat) | Fix |
|---|---|
| The poll appears at random times; people on the pitch or driving miss out | The organiser opens the game at a **consistent time**; there's a real window, not a race. |
| First-come-first-served rewards fast tappers, not regulars | When oversubscribed, the squad is the **top N by loyalty score**, not sign-up order. A regular who signs up late still ranks above a casual. |
| No reward for turning up regularly | **+2 loyalty** every game you play. |
| Late dropouts go unpunished | **Time-weighted penalty**: free before 5pm Monday, scaling to −10 in the last 3 hours (Tom's point). Shown before you confirm. |
| Chasing people who already know they're out | One-tap **Can't make it this week** — a no-penalty opt-out that shows on the list, so nobody gets pestered. |
| People never know if they're in or out | **Email + push notifications** when your status changes, plus a public list everyone can see. |
| 5-, 7- or 8-a-side, week to week | Squad size is set per game with one-tap **a-side** presets (or a custom number) — right when you open it *and* live afterwards, so a format change re-picks the squad and reserves instantly. |

## Screens

A responsive top bar carries the navigation — inline links on the web, a
hamburger menu on mobile. **Anyone's name is tappable** — in a line-up, the
league table, the Performances page or a match report — and opens their public
profile (form, record and performance), with a **← Back** button that returns
you exactly where you were.

- **This week** — the live squad (two-column, by loyalty) and the reserves,
  visible to everyone. *I'm in* / *Withdraw* each take a quick **tap-to-confirm**
  (so it's never a misfire), with the penalty shown up front, plus *Can't make
  it this week* — a no-penalty way to say you're out so
  nobody chases you; the out list shows for all to see (and you can undo it).
- **Join / You** — one nav slot: **Join** (onboarding) when signed out, your
  **You** profile (attendance, games, record, history, notifications, account)
  once you're in.
- **History** — every logged result. Tap into a game for the line-ups, the
  score, goalscorers and embedded highlights (see below).
- **Table** — the leaderboard. Ranked by loyalty; **tap a heading to sort, tap
  again to reverse**. Shows **TG** (team goals — a team metric) but deliberately
  **not** personal goals, so it never nudges anyone towards chasing individual
  numbers over the team.
- **Performances** — the individual side, kept separate from the league table.
  A sortable record of each player's match stats — **goals, assists, MOTM
  awards, average rating, saves, shots, tackles, blocks, passes** and own goals
  — from the games we've logged them for. Realistically it's mostly goals each
  week; the rest fills in when someone's counting. Your own numbers also appear
  on your **You** profile.
- **Ratings & man of the match** — once a game's played, **rate your own
  performance** out of 5 stars from that game's History page (edit it any time).
  The Statto can add a rating too — your match rating is then the average of the
  two — and name one or more **men of the match** per team, who show in bold
  with a badge in the History line-up. Ratings and MOTM awards feed the
  Performances page and your profile.
- **Rules** — the system explained, with the penalty scale.
- **Organiser** — PIN-protected: open/lock/complete games, **set the squad size
  per game** (5/6/7/8-a-side presets or a custom number, changeable live while
  the poll's open), manage the roster, recalculate loyalty, add highlight links,
  change every setting.
- **Statto** — a separate PIN-protected role for the stats-keeper: correct any
  game's score, log **who scored** (goals + assists up front, the full stat set
  behind a **+ more** toggle), mark **own goals**, give each player a **rating**,
  name the **man of the match** (any number, either team), and add **highlight
  links**. Feeds the Performances page, each player's profile and the History
  detail. Set the Statto PIN in Organiser → Settings.
  - **Import from a spreadsheet.** Keep your stats in a Google Sheet (any
    layout with a **Player** column plus stat columns — Goals, Assists, Saves,
    Rating, MOTM, Own goals…). Paste the **share link** (set to *anyone with the
    link can view*, or *Publish to web → CSV*) or just paste the cells. The
    importer matches columns by name and players by name, routes rows to
    fixtures via an optional **Date** column (or a game you pick), shows a
    **preview** — matched rows, flagged unknown names/dates — then applies.
    Merges onto whatever's already recorded; a **Copy template** button gives
    you a starting sheet.

Notifications tell you the moment your spot changes — promoted off the reserves,
or bumped out — by **email and push** (push works on Android/desktop directly,
and on iPhone once you add the app to your Home Screen).

---

## Setup

You'll do this once. Times are rough. Everything's free.

### 1. Firebase project + database (~5 min)
1. <https://console.firebase.google.com> → **Add project** (free Spark plan).
2. **Build → Firestore Database → Create database** → *production mode* → a region near you.
3. **Firestore → Rules** → paste [`firestore.rules`](./firestore.rules) → **Publish**.
4. **Project settings** (gear) → **Your apps** → Web (`</>`) → register → copy the `firebaseConfig`.

### 2. Turn on sign-in (~1 min)
- **Build → Authentication → Get started → Sign-in method.** Enable two methods:
  - **Google →** enable → pick a support email → Save (one-tap sign-in).
  - **Email/Password →** enable → Save (so people can register with an email +
    password — no third-party account needed).
- **Authentication → Settings → Authorized domains →** add your GitHub Pages
  domain (`<username>.github.io`).
- Both are on by default in the app (`authProviders = ['google']` and
  `authEmailPassword = true` in `public/firebase-config.js`). Prefer OAuth only?
  Set `authEmailPassword = false`. Want more one-tap options? Enable **GitHub**
  or **Microsoft** in the same tab and add them to `authProviders`.
- **Linking accounts to history:** a new sign-in shows up as a fresh account.
  In the app's **Organiser → Sign-ins to link** card, pick who they are on the
  roster to merge the sign-in into that historic record (their games and loyalty
  stay put), or mark them a brand-new player. Once linked, that account is their
  permanent login on any device — every future sign-in resolves straight to their
  profile to register, withdraw and get notifications.

### 3. (Optional) Turn on push (~2 min)
- **Project settings → Cloud Messaging → Web Push certificates → Generate key pair.**
- Copy that key into `vapidKey` in `public/firebase-config.js`.
- Skip this if you only want email notifications.

### (Optional) Match weather
The app can show the weather at kickoff on **This week** and on each **History**
result, via [Open-Meteo](https://open-meteo.com) — **free, no API key**. In
**Organiser → Settings**, set the pitch's **latitude, longitude** (find the
pitch on Google Maps, right-click → copy the coordinates). Leave blank to hide
weather.

**Weather loyalty bonus:** when a game is marked as played, everyone who turned
out gets extra loyalty for tough conditions — **adverse weather** (cold/wet at
kickoff) and the **cold season** (Nov–Mar) each add a bonus (default +1 each,
tunable in Settings). The weather is frozen onto the game record, and the
History detail shows the bonus. The cold-season bonus works even without pitch
coordinates; the adverse-weather bonus needs them set.

### 4. Paste config & deploy
Edit [`public/firebase-config.js`](./public/firebase-config.js) with your values
(and `vapidKey` if using push), then:
```bash
git add public/firebase-config.js
git commit -m "Add Firebase config"
git push
```
Then in the repo: **Settings → Pages → Source: GitHub Actions**. The app deploys
to `https://<username>.github.io/tntf-poll/` on every push. Drop that link in the
group.

*(Firebase web config values are **not secret** — they're meant to be public.
Access is controlled by `firestore.rules`.)*

### 5. Turn on notifications (the GitHub Action)
The notifier ([`notify/`](./notify)) runs every 5 minutes via
[`.github/workflows/notify.yml`](./.github/workflows/notify.yml). Give it secrets
in **Settings → Secrets and variables → Actions**:

| Secret | What | Needed for |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase console → Project settings → **Service accounts → Generate new private key** → paste the whole JSON | email + push |
| `APP_URL` | your Pages URL, e.g. `https://<username>.github.io/tntf-poll/` | links in alerts |
| `SMTP_HOST`,`SMTP_PORT`,`SMTP_USER`,`SMTP_PASS`,`MAIL_FROM` | any SMTP account (e.g. a Gmail address + an [app password](https://support.google.com/accounts/answer/185833)) | email only |

Push needs only the service account (Firebase Cloud Messaging is free). Email
needs the SMTP secrets. Set up either or both.

### 6. First run
- Open the app → **Organiser** → unlock with your organiser PIN → set/rotate it (and the Statto PIN) any time in **Settings**.
- The roster is pre-seeded from the group; edit it in the Organiser tab.
- After each game: **Organiser → Mark as played** (banks loyalty, saves the
  result to history), then **Open the game** for next week — which fires the
  "poll is open" notification to everyone.

---

## Try it locally first (optional)
With no Firebase config, the app runs in **demo mode** on `localStorage` — fully
working but single-device, and with in-app (not push) status alerts. Good for a
look before wiring up Firebase.
```bash
npm run serve   # http://localhost:3000
npm test        # selection / penalty / notification-diff / stats logic
```

## History & analytics

The app ships with the group's real match history (**22 games**, Dec 2025 → Jul
2026) parsed from [`data/history.txt`](./data/history.txt). Each game records the
two teams and the score, which powers per-player analytics: **W-D-L, win %, goal
difference, win streaks, longest unbeaten run, current form** — shown on the
**Table** (a form guide per player) and the **You** profile.

- Source data lives in `data/history.txt`; run `node scripts/build-seed.mjs` to
  re-parse it into `public/seed-data.js` (the seed the app loads on first run).
- The builder canonicalises name variants (e.g. *Matt* → Matthew Eastwood,
  *Ismaeel* → Ismael Nazar) — the mapping is at the top of `scripts/build-seed.mjs`.
- **Names ↔ accounts:** history is keyed to a player *record*. When someone
  signs in they pick their name and their email links to that same record — so
  imported history and their account converge automatically. The Organiser
  roster shows a link tag against each name so you can spot who's connected.

> If you set up Firestore *before* this history existed, clear the `players` and
> `games` collections (or the `meta/config` doc) so the app re-seeds with it.

### Match highlights (two ways)

Highlights on the **History** detail view come from two sources, merged:

1. **In the app** — the Organiser (when completing a game) and the Statto (on
   any past game) can paste YouTube links and a match note straight onto the
   record. Nothing to commit; it saves to Firestore and shows immediately.
2. **A committed text file** — one file per game in
   [`public/content/games/`](./public/content/games/), for richer write-ups
   (labelled clips, longer notes). No build step, no manifest — add a file,
   commit/push, and the site renders it (fetched lazily when you open that
   result). Links entered in the app and in the file both show; duplicate videos
   are de-duped.

Copy [`_TEMPLATE.md`](./public/content/games/_TEMPLATE.md) to a file named after
the game's date (`YYYY-MM-DD.md`, e.g. `2026-01-13.md`) and fill in what you have:

```
video: https://youtu.be/THE_VIDEO_ID          # two-part highlights? add two
video: https://youtu.be/THE_SECOND_PART_ID
clip:  https://youtu.be/A_CLIP_ID | Faisal's screamer
note:  End-to-end stuff — **Bibs** edged it late on.
```

`video:` shows as full-width embeds (labelled *part 1 / part 2* when there are
two), `clip:` adds short clips with an optional `| caption`, and `note:` takes
plain text or light markdown. All fields are optional; games with no file just
show their line-ups and score. Any common YouTube URL shape works (`watch?v=`,
`youtu.be/`, `/embed/`, `/shorts/`); videos embed via `youtube-nocookie.com`.
See [`_HOWTO.md`](./public/content/games/_HOWTO.md) in that folder for the full
guide. (Files whose names start with `_` are docs, never treated as a game.)

## How it's built
- `public/` — static app, no build step:
  - `logic.js` — pure maths: ranking, penalties, status-change diff, stats, win/loss analytics (unit-tested).
  - `db.js` — Firestore when configured, `localStorage` otherwise. `seed-data.js` — generated history.
  - `auth.js` — email magic-link sign-in. `messaging.js` — FCM push tokens.
  - `import.js` — parse a stats spreadsheet (CSV/TSV / Google Sheets) and resolve names + dates to players + fixtures (unit-tested).
  - `app.js` — the responsive UI (top-bar nav, This week / Join / History / Table / You / Rules / Organiser). `firebase-messaging-sw.js` — push service worker.
  - `content/games/` — one editable `<date>.md` per game's highlights (see above).
- `data/` + `scripts/build-seed.mjs` — historic results and the parser that builds the seed.
- `notify/` — the scheduled notification robot (reuses `logic.js` for identical ranking).
- `.github/workflows/` — Pages deploy + the notifier.

## The loyalty model (editable in Settings)
- **Play a game:** `+2`.
- **Bad conditions:** `+1` adverse weather (cold/wet) · `+1` cold season (Nov–Mar) — stack on top of playing.
- **Step in to fill a gap:** signing up within 24h of kickoff **and playing** is worth `4 games` (`+8`) — but only when the squad was short of players who signed up in good time (capped at the number of gaps). No reward for just signing up late to a full squad.
- **Withdraw:** `before 5pm Mon` free · `after 5pm Mon` −3 · `within 12h (from 8am)` −5 · `within 6h` −8 · `within 3h / no-show` −10. (Editable in Settings; times shown assume the Tue 8pm game.)
- **Selection:** active sign-ups by loyalty (desc), ties broken by sign-up time. Top `capacity` confirmed, rest reserves.
- **Table order:** by loyalty; ties broken by lowest win %, then fewest goals, then name.
- **Result:** the organiser enters the final score when marking a game as played (editable, along with the teams, right up until confirming); it's stored on the match record and drives win/loss analytics.

## Security note
This is a private link for one group chat, so Firestore lets anyone with the
link read and register, and the organiser PIN is a *soft* gate. For a hard admin
lock, enable Firebase Auth restrictions — see the commented recipe in
[`firestore.rules`](./firestore.rules).
