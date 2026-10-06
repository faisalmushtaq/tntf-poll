// notify/index.js — the "notification robot".
// Runs on a schedule from GitHub Actions. Reads the current game from
// Firestore, works out whose confirmed/reserve status changed, and sends them
// an email and/or a push notification. Reuses the SAME logic.js the app uses,
// so the ranking is guaranteed identical.
import admin from 'firebase-admin';
import nodemailer from 'nodemailer';
import * as logic from '../public/logic.js';

const APP_URL = process.env.APP_URL || '';
let CLUB_NAME = 'Tuesday Night Total Football'; // set from config in main()

// The cron interval notify.yml asks for, and how many run-to-run gaps we keep in
// meta/notify. GitHub rarely honours a 5-minute schedule on a quiet repository,
// so these feed the "will I get another run before kick-off?" estimate that
// decides when a pending line-up goes out. Keep CRON_INTERVAL_MINUTES in step
// with the cron in .github/workflows/notify.yml.
const CRON_INTERVAL_MINUTES = 5;

// The push notification icon, as a full URL. It has to be absolute: the
// browser resolves it against the site's origin, and the app lives under
// /tntf-poll/ on GitHub Pages, so a bare '/icon.svg' pointed at nothing. And
// it has to be a PNG — Android doesn't show SVG notification icons.
const PUSH_ICON = APP_URL ? `${APP_URL.replace(/\/?$/, '/')}icon-192.png` : '';
const RUN_GAP_SAMPLES = 12;

// A one-off test run, started by hand from the Actions tab with an address to
// send to (see notify.yml). It checks the setup end to end — the Firebase key,
// the email login, push — and sends nothing to anyone else.
const TEST_EMAIL = (process.env.TEST_EMAIL || '').trim();

// --- Firebase Admin (service account from a GitHub secret) ------------------
// If the notifier isn't configured yet, skip cleanly (exit 0) so the scheduled
// run doesn't fail and spam the repo owner with failure emails — but raise a
// warning annotation, so the Actions page shows it isn't actually doing
// anything rather than a misleading row of green ticks. A test run fails
// outright instead: you asked it to check the setup, and the setup is broken.
const notConfigured = msg => {
  if (TEST_EMAIL) { console.error(`::error::${msg}`); process.exit(1); }
  console.log(`::warning::${msg} No emails or push notifications are being sent.`);
  process.exit(0);
};
let sa = {};
try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
catch { notConfigured('FIREBASE_SERVICE_ACCOUNT is not valid JSON — paste the whole downloaded key file, including the { and }.'); }
if (!sa.project_id) notConfigured('Notifications not configured yet (no FIREBASE_SERVICE_ACCOUNT secret).');
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

// --- Editorial-theme email --------------------------------------------------
// Matches the website: warm near-white paper, ink serif text, a green accent
// rule and a dark pill "Open" button. `bodyHtml` is the pre-formatted inner
// HTML (paragraphs, lists) for the message body.
function emailHtml({ clubName, heading, bodyHtml }) {
  const paper = '#fbfaf8', ink = '#171614', muted = '#9a9488', line = '#e2ddd1', green = '#4a795d';
  const serif = "'Newsreader', Georgia, 'Times New Roman', serif";
  const crest = APP_URL ? `${APP_URL.replace(/\/$/, '')}/icon-192.png` : '';
  const button = APP_URL
    ? `<tr><td style="padding:22px 0 4px"><a href="${APP_URL}" style="display:inline-block;background:${ink};color:#f6f4ef;font:600 16px/1 ${serif};padding:13px 26px;border-radius:999px;text-decoration:none">Open the app &rarr;</a></td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:${paper}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${paper}">
    <tr><td align="center" style="padding:28px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${paper};border:1px solid ${line};border-radius:14px">
        <tr><td style="padding:22px 30px 16px;border-bottom:1px solid ${line}">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            ${crest ? `<td style="padding-right:11px" valign="middle"><img src="${crest}" width="30" height="30" alt="" style="display:block;border-radius:7px"></td>` : ''}
            <td valign="middle" style="font:600 17px/1.1 ${serif};color:${ink};letter-spacing:-.01em">${clubName}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:26px 30px 30px">
          <div style="font:600 25px/1.15 ${serif};color:${ink};letter-spacing:-.005em;margin:0 0 10px">${heading}</div>
          <div style="width:34px;height:3px;background:${green};border-radius:2px;margin:0 0 16px"></div>
          <div style="font:400 17px/1.55 ${serif};color:${ink}">${bodyHtml}</div>
          <table role="presentation" cellpadding="0" cellspacing="0">${button}</table>
        </td></tr>
        <tr><td style="padding:14px 30px 22px;border-top:1px solid ${line};font:400 13px/1.5 ${serif};color:${muted}">
          You get this because you're on the ${clubName} team sheet.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function send(player, ev) {
  if (!player) return;
  if (transport && player.email) {
    try {
      const bodyHtml = (ev.bodyHtml || `<p style="margin:0">${escapeHtml(ev.body)}</p>`);
      await transport.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: player.email,
        subject: ev.title,
        text: `${ev.body}${APP_URL ? `\n\nOpen the app: ${APP_URL}` : ''}`,
        html: emailHtml({ clubName: CLUB_NAME, heading: ev.heading || ev.title, bodyHtml })
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
        webpush: { notification: PUSH_ICON ? { icon: PUSH_ICON } : {}, fcmOptions: APP_URL ? { link: APP_URL } : undefined }
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
  CLUB_NAME = config.clubName || CLUB_NAME;
  let gameId = cfgSnap.exists ? cfgSnap.data().currentGameId : null;

  const playersSnap = await db.collection('players').get();
  const players = {};
  playersSnap.forEach(d => { players[d.id] = { id: d.id, ...d.data() }; });

  const notifyRef = db.doc('meta/notify');
  const notify = (await notifyRef.get()).data() || { lastGameId: null, statuses: {} };
  let autoOpenedKickoff = notify.autoOpenedKickoff || null;

  // How often do we *actually* get to run? notify.yml asks for every 5 minutes,
  // but GitHub throttles scheduled workflows on repositories with no recent
  // pushes, so the true gap can be hours. Record each run and keep a short
  // history of the gaps: that's what tells us whether we can afford to sit on a
  // pending line-up until its send time, or had better get it out now.
  // `runStats` rides along on every write to this doc below, including the
  // early-return paths, so the history survives a quiet week.
  const runAt = new Date();
  const lastRunAt = notify.lastRunAt ? new Date(notify.lastRunAt) : null;
  const gapMinutes = lastRunAt ? Math.round((runAt - lastRunAt) / 60000) : null;
  const runGaps = [...(Array.isArray(notify.runGaps) ? notify.runGaps : [])];
  if (gapMinutes > 0) runGaps.push(gapMinutes);
  const runStats = { lastRunAt: runAt.toISOString(), runGaps: runGaps.slice(-RUN_GAP_SAMPLES) };
  const nextRunMinutes = logic.nextRunEstimateMinutes(runStats.runGaps, CRON_INTERVAL_MINUTES);
  console.log(gapMinutes == null
    ? `First recorded run; assuming up to ${nextRunMinutes} min until the next one.`
    : `Last run ${gapMinutes} min ago; assuming up to ${nextRunMinutes} min until the next one.`);

  // Read the current game (if any) up front — the auto-opener needs to know
  // whether last week's game is settled before it puts out a fresh poll.
  let gameSnap = gameId ? await db.doc(`games/${gameId}`).get() : null;
  let game = gameSnap && gameSnap.exists ? gameSnap.data() : null;

  // Auto-open: on the configured day/time (default Friday 10am), once last
  // week's game is settled (completed or cancelled), put out the next poll and
  // announce it. Guarded so it can't fire twice or re-open a cancelled week.
  const plan = logic.autoOpenPlan(config, game, new Date(), autoOpenedKickoff);
  if (plan) {
    const newRef = db.collection('games').doc();
    await newRef.set({
      status: 'open', dateLabel: plan.dateLabel, kickoffAt: plan.kickoffAt,
      capacity: Number(config.capacity) || 14, venue: config.venue || '',
      autoOpened: true, createdAt: new Date().toISOString()
    });
    await db.doc('meta/config').set({ currentGameId: newRef.id }, { merge: true });
    autoOpenedKickoff = plan.kickoffAt;
    gameId = newRef.id;
    game = { id: newRef.id, ...(await newRef.get()).data() };
    // The weekly poll opening on schedule is routine, so its "poll's open"
    // message goes out now (processAnnouncement below, this same run) rather
    // than waiting out the review window — people hear at the advertised time.
    await db.doc('meta/announcement').set(logic.buildAnnouncement('poll-open', { game, recipients: Object.values(players), config, sendNow: true }));
    console.log(`Auto-opened poll for ${plan.dateLabel} (kickoff ${plan.kickoffAt}). Announcement staged.`);
  }

  // Send (or drop) the pending "poll's open" announcement, held for review.
  await processAnnouncement(gameId, game, players, nextRunMinutes);

  // Delete payment receipts past their retention period. Best-effort: a
  // failure here must never stop the notifications below.
  try { await purgeExpiredProofs(); }
  catch (e) { console.error('Receipt clean-up failed (will retry next run):', e.message); }

  // No open game → reset the marker so the next open triggers a fresh alert.
  if (!gameId) { await notifyRef.set({ lastGameId: null, statuses: {}, autoOpenedKickoff, ...runStats }, { merge: true }); console.log('No open game.'); return; }

  if (!game || game.status === 'completed') {
    await notifyRef.set({ lastGameId: gameId, statuses: {}, autoOpenedKickoff, ...runStats }, { merge: true });
    console.log('Game not active.'); return;
  }

  // Game called off → the "no game this week" broadcast is a staged
  // announcement (handled above by processAnnouncement); just go quiet here.
  if (game.status === 'cancelled') {
    await notifyRef.set({ lastGameId: gameId, statuses: {}, noticeGameId: gameId, autoOpenedKickoff, ...runStats }, { merge: true });
    console.log('Done (cancelled).'); return;
  }
  // "Game moved" (reschedule) and "line-up" broadcasts are also staged
  // announcements the organiser reviews — processAnnouncement sends them.

  const susSnap = await db.collection(`games/${gameId}/signups`).get();
  const signups = susSnap.docs.map(d => ({ playerId: d.id, ...d.data() }));
  // Match the browser exactly: an unlocked game follows the live recommended
  // format, while a finalised game uses its stored capacity.
  const capacity = logic.effectiveCapacity(game, signups, players, config);
  const ranked = logic.rankSignups(signups, players, capacity, { pollOpenAt: game.createdAt, config });
  const curr = logic.statusMap(ranked);

  const events = [];
  if (notify.lastGameId !== gameId) {
    // A new game just opened → the "poll's open" broadcast is handled by the
    // pending announcement (held for organiser review), not blasted here. Just
    // set the status baseline so we don't misfire promoted/bumped alerts.
    console.log(`New game opened: ${game.dateLabel}. Broadcast deferred to the pending announcement.`);
  } else {
    for (const c of logic.diffStatuses(notify.statuses || {}, curr)) {
      if (c.kind === 'promoted') events.push({ playerId: c.playerId, title: "You're IN ✅", heading: "You're in the squad", body: `A spot opened up — you're in the squad for ${game.dateLabel}.`, bodyHtml: `<p style="margin:0">A spot opened up — you're <strong>in the squad</strong> for ${escapeHtml(game.dateLabel)}.</p>` });
      else events.push({ playerId: c.playerId, title: 'Bumped to the reserves', heading: 'Bumped to the reserves', body: `You've dropped to the reserves for ${game.dateLabel}. You'll move up if someone drops.`, bodyHtml: `<p style="margin:0">You've dropped to the <strong>reserves</strong> for ${escapeHtml(game.dateLabel)}. You'll move up if someone drops out.</p>` });
    }
    console.log(`${events.length} status change(s) to notify.`);
  }

  for (const ev of events) await send(players[ev.playerId], ev);

  // Squad set: at the deadline (config.squadLockTime on the day before — Monday
  // 10am for a Tuesday game) tell everyone where they stand, once per game:
  // "you're in" to the squad, "you're reserve #n" to the bench. Sent whether or
  // not the squad is full; if it isn't, registration stays open below so late
  // sign-ups can still fill the gaps.
  let squadSetGameId = notify.squadSetGameId || null;
  if (squadSetGameId !== gameId && logic.squadSetDue(game, new Date(), config)) {
    const notices = logic.squadSetMessages(ranked, game, config);
    console.log(`Squad set — confirming ${notices.length} player(s) (squad + reserves).`);
    for (const n of notices) await send(players[n.playerId], n);
    squadSetGameId = gameId;
  }

  // Auto-close: once we're past that deadline and the squad is full, lock
  // registration and send the organiser the squad list (once).
  let autoLockedGameId = notify.autoLockedGameId || null;
  const confirmed = ranked.filter(r => r.status === 'confirmed');
  const cutoff = new Date(logic.squadLockCutoffISO(game.kickoffAt, config));
  if (game.status === 'open' && Date.now() >= cutoff.getTime() && confirmed.length >= capacity && autoLockedGameId !== gameId) {
    console.log('Auto-closing: squad full and past cutoff.');
    await db.doc(`games/${gameId}`).update({ status: 'locked', capacity, capacityLocked: true, lockedAt: new Date().toISOString(), autoLocked: true });
    autoLockedGameId = gameId;
    await sendSquadAlert(config, { ...game, capacity }, confirmed, ranked.filter(r => r.status === 'waitlist'), players);
  }

  // Close the poll once the game has kicked off — no more sign-ups mid-match.
  if (logic.pastKickoff(game, new Date()) && game.status === 'open') {
    console.log('Kick-off passed — locking registration.');
    await db.doc(`games/${gameId}`).update({ status: 'locked', capacity, capacityLocked: true, lockedAt: new Date().toISOString(), autoLocked: true });
    if (autoLockedGameId !== gameId) {
      autoLockedGameId = gameId;
      await sendSquadAlert(config, { ...game, capacity }, confirmed, ranked.filter(r => r.status === 'waitlist'), players);
    }
  }

  await notifyRef.set({ lastGameId: gameId, statuses: curr, autoLockedGameId, squadSetGameId, autoOpenedKickoff, kickoffAt: game.kickoffAt || null, venue: game.venue || '', ...runStats, updatedAt: new Date().toISOString() });
  console.log('Done.');
}

// Send a staged group announcement (poll's open, game moved, no game this week,
// or the line-up) once its grace window elapses — or the organiser sent it
// early — to the recipients they didn't deselect. If the game it was for is no
// longer in the matching state, drop it unsent.
// `nextRunMinutes` is how long we think it'll be before we run again; it lets a
// pending line-up go out early rather than be stranded past kick-off by a slow
// scheduler (see logic.announcementDeadlineDue).
async function processAnnouncement(gameId, game, players, nextRunMinutes) {
  const ref = db.doc('meta/announcement');
  const snap = await ref.get();
  const ann = snap.exists ? snap.data() : null;
  if (!ann || ann.status !== 'pending') return;

  if (!logic.announcementValid(ann, game, gameId)) {
    await ref.set({ status: 'cancelled', reason: 'stale', resolvedAt: new Date().toISOString() }, { merge: true });
    console.log(`Announcement (${ann.kind}) dropped — its game is no longer in the matching state.`);
    return;
  }
  const now = new Date();
  if (!logic.announcementReady(ann, now, { nextRunMinutes })) {
    console.log(`Announcement (${ann.kind}) held — grace window until ${ann.sendAfter}.`);
    return;
  }
  // Going out ahead of its send time because we might not get another run before
  // kick-off. Recorded on the doc so it's clear afterwards why it arrived early.
  const early = new Date(ann.sendAfter) > now;
  if (early) {
    console.log(`Announcement (${ann.kind}) sent EARLY — kick-off ${ann.kickoffAt} is nearer than the next expected run (~${nextRunMinutes} min), so waiting until ${ann.sendAfter} risked missing it.`);
  }

  const content = logic.announcementContent(ann, CLUB_NAME);
  const bodyHtml = content.paragraphs.map(p => `<p style="margin:0 0 10px">${escapeHtml(p)}</p>`).join('');
  const body = content.paragraphs.join('\n\n');
  const audience = logic.announcementAudience(ann);
  console.log(`Sending "${ann.kind}" announcement to ${audience.length} recipient(s).`);
  for (const r of audience) {
    const p = players[r.id] || { id: r.id, name: r.name, email: r.email };
    await send(p, { title: content.subject, heading: content.heading, body, bodyHtml });
  }
  await ref.set({ status: 'sent', sentAt: new Date().toISOString(), sentCount: audience.length, sentEarly: early }, { merge: true });
  console.log('Announcement sent.');
}

// Proof-of-payment receipts are bank screenshots, so each is deleted
// logic.PROOF_RETENTION_DAYS after upload. We walk every game's proofs
// subcollection rather than use a collection-group query, which would need a
// Firestore index setting up by hand; with one game a week that's a few dozen
// small queries a run. `select` fetches only the upload time, not the image.
// The sign-up keeps its paid tick — only the picture goes — and loses its
// proofAt so the app doesn't offer to show a receipt that's gone.
async function purgeExpiredProofs() {
  const now = new Date();
  const gameRefs = await db.collection('games').listDocuments();
  let removed = 0;
  for (const gameRef of gameRefs) {
    const snap = await gameRef.collection('proofs').select('uploadedAt').get();
    for (const doc of snap.docs) {
      if (!logic.proofExpired(doc.data(), now)) continue;
      const signupRef = gameRef.collection('signups').doc(doc.id);
      const batch = db.batch();
      batch.delete(doc.ref);
      // update(), not set(): if the sign-up is gone (player merged or removed)
      // there's nothing to tidy, and we mustn't resurrect a stub record.
      if ((await signupRef.get()).exists) batch.update(signupRef, { proofAt: admin.firestore.FieldValue.delete() });
      await batch.commit();
      removed++;
    }
  }
  if (removed) console.log(`Deleted ${removed} payment receipt(s) older than ${logic.PROOF_RETENTION_DAYS} days.`);
}

// Email + push the finalised squad to the organiser.
async function sendSquadAlert(config, game, confirmed, reserves, players) {
  const list = confirmed.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
  const bench = reserves.length ? `\n\nReserves:\n${reserves.map((r, i) => `${i + 1}. ${r.name}`).join('\n')}` : '';
  const body = `The squad for ${game.dateLabel}${game.venue ? ` at ${game.venue}` : ''} is locked (${confirmed.length}/${game.capacity}):\n\n${list}${bench}`;
  const ev = { title: `✅ Squad locked — ${game.dateLabel}`, body };

  if (transport && config.organiserEmail) {
    try {
      const olItem = 'margin:0;padding:2px 0;font:400 16px/1.5 \'Newsreader\',Georgia,serif;color:#171614';
      const squadHtml = confirmed.map((r, i) => `<li style="${olItem}">${i + 1}. ${escapeHtml(r.name)}</li>`).join('');
      const benchHtml = reserves.length
        ? `<p style="margin:16px 0 4px;font:600 16px/1.4 'Newsreader',Georgia,serif;color:#9a9488">Reserves</p><ol style="margin:0;padding:0;list-style:none">${reserves.map((r, i) => `<li style="${olItem}">${i + 1}. ${escapeHtml(r.name)}</li>`).join('')}</ol>`
        : '';
      const bodyHtml = `<p style="margin:0 0 12px">The squad for <strong>${escapeHtml(game.dateLabel)}</strong>${game.venue ? ` at ${escapeHtml(game.venue)}` : ''} is locked (${confirmed.length}/${game.capacity}).</p>`
        + `<ol style="margin:0;padding:0;list-style:none">${squadHtml}</ol>${benchHtml}`;
      await transport.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: config.organiserEmail,
        subject: ev.title,
        text: `${body}${APP_URL ? `\n\n${APP_URL}` : ''}`,
        html: emailHtml({ clubName: CLUB_NAME, heading: `Squad locked — ${game.dateLabel}`, bodyHtml })
      });
      console.log(`  squad alert emailed to organiser ${config.organiserEmail}`);
    } catch (e) { console.error('  organiser email failed', e.message); }
  }
  // Also push to the organiser if their account is on the roster.
  const org = Object.values(players).find(p => config.organiserEmail && p.email && p.email.toLowerCase() === config.organiserEmail.toLowerCase());
  if (org) await send(org, { title: ev.title, body: `Squad for ${game.dateLabel} is locked (${confirmed.length}/${game.capacity}).` });
}

// --- setup check (manual test run) -------------------------------------------
// Proves each piece works, in the order they'd fail, and says what to fix. It
// only reads from Firestore and only sends to TEST_EMAIL (plus that player's
// own devices, if the address is on the roster) — no announcements, no status
// alerts, no bookkeeping writes.
async function selfTest(to) {
  let ok = true;
  const fail = msg => { ok = false; console.error(`::error::${msg}`); };

  console.log('1. Firebase key');
  let players = [];
  try {
    const cfg = (await db.doc('meta/config').get()).data() || {};
    CLUB_NAME = cfg.clubName || CLUB_NAME;
    const snap = await db.collection('players').get();
    players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log(`   ✓ connected to project "${sa.project_id}" — ${cfg.clubName || 'club'}, ${players.length} players on the roster`);
  } catch (e) {
    fail(`Firebase key rejected (${e.message}). Generate a fresh key in Firebase → Project settings → Service accounts, and paste the whole file into the FIREBASE_SERVICE_ACCOUNT secret.`);
  }

  console.log('2. Email');
  if (!transport) {
    fail('Email is not configured: the SMTP_HOST secret is empty.');
  } else {
    try {
      await transport.verify();
      console.log(`   ✓ signed in to ${process.env.SMTP_HOST} as ${process.env.SMTP_USER}`);
      await transport.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to,
        subject: `${CLUB_NAME} — test email`,
        text: `Email from the ${CLUB_NAME} notifier is working.${APP_URL ? `\n\n${APP_URL}` : ''}`,
        html: emailHtml({ clubName: CLUB_NAME, heading: 'Email is working', bodyHtml: '<p style="margin:0">This is a test from the notifier. If you can read it, players will get their "you\'re in", line-up and poll emails.</p>' })
      });
      console.log(`   ✓ test email sent to ${to} — check the inbox (and the spam folder)`);
    } catch (e) {
      const hint = /535|auth|credentials|username and password/i.test(e.message)
        ? ' The login was refused: for Gmail, SMTP_PASS must be a 16-character app password (not your normal password) and SMTP_USER your full Gmail address.'
        : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|greeting/i.test(e.message)
          ? ' Could not reach the mail server: check SMTP_HOST, and SMTP_PORT (465 for Gmail).'
          : '';
      fail(`Email failed: ${e.message}.${hint}`);
    }
  }

  console.log('3. Push');
  const withPush = players.filter(p => Object.keys(p.pushTokens || {}).length);
  console.log(`   ${withPush.length} of ${players.length} players have turned on push in the app`);
  const me = players.find(p => p.email && p.email.toLowerCase() === to.toLowerCase());
  const tokens = Object.values((me && me.pushTokens) || {});
  if (!me) console.log(`   (${to} isn't on the roster, so no test push was sent)`);
  else if (!tokens.length) console.log(`   ${me.name} hasn't turned on push in the app, so no test push was sent`);
  else {
    try {
      const res = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title: `${CLUB_NAME} — test`, body: 'Push notifications are working.' },
        webpush: { notification: PUSH_ICON ? { icon: PUSH_ICON } : {}, fcmOptions: APP_URL ? { link: APP_URL } : undefined }
      });
      console.log(`   ✓ test push to ${me.name}: ${res.successCount} of ${tokens.length} device(s) accepted it`);
    } catch (e) { fail(`Push failed: ${e.message}`); }
  }

  if (!ok) process.exit(1);
  console.log('\nAll good — the scheduled runs will now send notifications.');
}

(TEST_EMAIL ? () => selfTest(TEST_EMAIL) : main)().catch(e => { console.error(e); process.exit(1); });
