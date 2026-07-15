// notify/index.js — the "notification robot".
// Runs on a schedule from GitHub Actions. Reads the current game from
// Firestore, works out whose confirmed/reserve status changed, and sends them
// an email and/or a push notification. Reuses the SAME logic.js the app uses,
// so the ranking is guaranteed identical.
import admin from 'firebase-admin';
import nodemailer from 'nodemailer';
import * as logic from '../public/logic.js';

const APP_URL = process.env.APP_URL || '';

// --- Firebase Admin (service account from a GitHub secret) ------------------
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (!sa.project_id) { console.error('Missing FIREBASE_SERVICE_ACCOUNT secret'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// --- Email transport (optional; only if SMTP_* secrets are set) -------------
let transport = null;
if (process.env.SMTP_HOST) {
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function send(player, ev) {
  if (!player) return;
  if (transport && player.email) {
    try {
      await transport.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: player.email,
        subject: ev.title,
        text: `${ev.body}${APP_URL ? `\n\nOpen the app: ${APP_URL}` : ''}`,
        html: `<p style="font-size:16px">${ev.body}</p>${APP_URL ? `<p><a href="${APP_URL}" style="background:#ffe500;color:#052962;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:700">Open the app →</a></p>` : ''}`
      });
      console.log(`  email → ${player.email}: ${ev.title}`);
    } catch (e) { console.error('  email failed', player.email, e.message); }
  }
  const tokens = Object.values(player.pushTokens || {});
  if (tokens.length) {
    try {
      const res = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title: ev.title, body: ev.body },
        webpush: { notification: { icon: '/icon.svg' }, fcmOptions: APP_URL ? { link: APP_URL } : undefined }
      });
      console.log(`  push → ${player.name}: ${res.successCount}/${tokens.length} delivered`);
      // prune dead tokens so they don't pile up
      const dead = {};
      res.responses.forEach((r, i) => { if (!r.success && /registration-token|not-registered/i.test(r.error?.code || '')) dead[tokens[i].slice(-24)] = admin.firestore.FieldValue.delete(); });
      if (Object.keys(dead).length) await db.doc(`players/${player.id}`).set({ pushTokens: dead }, { merge: true });
    } catch (e) { console.error('  push failed', player.name, e.message); }
  }
}

async function main() {
  const cfgSnap = await db.doc('meta/config').get();
  const config = logic.withDefaults(cfgSnap.exists ? cfgSnap.data() : {});
  const gameId = cfgSnap.exists ? cfgSnap.data().currentGameId : null;

  const playersSnap = await db.collection('players').get();
  const players = {};
  playersSnap.forEach(d => { players[d.id] = { id: d.id, ...d.data() }; });

  const notifyRef = db.doc('meta/notify');
  const notify = (await notifyRef.get()).data() || { lastGameId: null, statuses: {} };

  // No open game → reset the marker so the next open triggers a fresh alert.
  if (!gameId) { await notifyRef.set({ lastGameId: null, statuses: {} }); console.log('No open game.'); return; }

  const gameSnap = await db.doc(`games/${gameId}`).get();
  const game = gameSnap.exists ? gameSnap.data() : null;
  if (!game || game.status === 'completed') {
    await notifyRef.set({ lastGameId: gameId, statuses: {} }, { merge: true });
    console.log('Game not active.'); return;
  }

  const susSnap = await db.collection(`games/${gameId}/signups`).get();
  const signups = susSnap.docs.map(d => ({ playerId: d.id, ...d.data() }));
  const ranked = logic.rankSignups(signups, players, game.capacity);
  const curr = logic.statusMap(ranked);

  const events = [];
  if (notify.lastGameId !== gameId) {
    // A new game just opened → tell the whole roster once.
    console.log(`New game opened: ${game.dateLabel}. Notifying roster.`);
    for (const p of Object.values(players)) {
      events.push({ playerId: p.id, title: `⚽ ${config.clubName}`, body: `This week's game (${game.dateLabel}) is open — get your name in.` });
    }
  } else {
    for (const c of logic.diffStatuses(notify.statuses || {}, curr)) {
      if (c.kind === 'promoted') events.push({ playerId: c.playerId, title: "You're IN ✅", body: `A spot opened up — you're in the squad for ${game.dateLabel}.` });
      else events.push({ playerId: c.playerId, title: 'Bumped to the reserves', body: `You've dropped to the reserves for ${game.dateLabel}. You'll move up if someone drops.` });
    }
    console.log(`${events.length} status change(s) to notify.`);
  }

  for (const ev of events) await send(players[ev.playerId], ev);

  // Auto-close: once we're past the day-before-5pm cutoff and the squad is
  // full, lock registration and send the organiser the squad list (once).
  let autoLockedGameId = notify.autoLockedGameId || null;
  const confirmed = ranked.filter(r => r.status === 'confirmed');
  const cutoff = closeCutoff(game.kickoffAt);
  if (game.status === 'open' && Date.now() >= cutoff.getTime() && confirmed.length >= game.capacity && autoLockedGameId !== gameId) {
    console.log('Auto-closing: squad full and past cutoff.');
    await db.doc(`games/${gameId}`).update({ status: 'locked', lockedAt: new Date().toISOString(), autoLocked: true });
    autoLockedGameId = gameId;
    await sendSquadAlert(config, game, confirmed, ranked.filter(r => r.status === 'waitlist'), players);
  }

  await notifyRef.set({ lastGameId: gameId, statuses: curr, autoLockedGameId, updatedAt: new Date().toISOString() });
  console.log('Done.');
}

// The auto-close moment: 17:00 on the day before kickoff (e.g. Monday 5pm for
// a Tuesday game).
function closeCutoff(kickoffAt) {
  const c = new Date(kickoffAt);
  c.setDate(c.getDate() - 1);
  c.setHours(17, 0, 0, 0);
  return c;
}

// Email + push the finalised squad to the organiser.
async function sendSquadAlert(config, game, confirmed, reserves, players) {
  const list = confirmed.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
  const bench = reserves.length ? `\n\nReserves:\n${reserves.map((r, i) => `${i + 1}. ${r.name}`).join('\n')}` : '';
  const body = `The squad for ${game.dateLabel}${game.venue ? ` at ${game.venue}` : ''} is locked (${confirmed.length}/${game.capacity}):\n\n${list}${bench}`;
  const ev = { title: `✅ Squad locked — ${game.dateLabel}`, body };

  if (transport && config.organiserEmail) {
    try {
      await transport.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: config.organiserEmail,
        subject: ev.title,
        text: `${body}${APP_URL ? `\n\n${APP_URL}` : ''}`,
        html: `<h3>${ev.title}</h3><pre style="font:15px/1.5 system-ui">${body}</pre>${APP_URL ? `<p><a href="${APP_URL}">Open the app →</a></p>` : ''}`
      });
      console.log(`  squad alert emailed to organiser ${config.organiserEmail}`);
    } catch (e) { console.error('  organiser email failed', e.message); }
  }
  // Also push to the organiser if their account is on the roster.
  const org = Object.values(players).find(p => config.organiserEmail && p.email && p.email.toLowerCase() === config.organiserEmail.toLowerCase());
  if (org) await send(org, { title: ev.title, body: `Squad for ${game.dateLabel} is locked (${confirmed.length}/${game.capacity}).` });
}

main().catch(e => { console.error(e); process.exit(1); });
