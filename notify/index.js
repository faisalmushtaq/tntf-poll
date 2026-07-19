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

// --- Firebase Admin (service account from a GitHub secret) ------------------
// If the notifier isn't configured yet, skip cleanly (exit 0) so the scheduled
// run doesn't fail and spam the repo owner with failure emails.
let sa = {};
try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
catch { console.log('FIREBASE_SERVICE_ACCOUNT is not valid JSON — skipping this run.'); process.exit(0); }
if (!sa.project_id) {
  console.log('Notifications not configured yet (no FIREBASE_SERVICE_ACCOUNT secret) — skipping this run.');
  process.exit(0);
}
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
  CLUB_NAME = config.clubName || CLUB_NAME;
  let gameId = cfgSnap.exists ? cfgSnap.data().currentGameId : null;

  const playersSnap = await db.collection('players').get();
  const players = {};
  playersSnap.forEach(d => { players[d.id] = { id: d.id, ...d.data() }; });

  const notifyRef = db.doc('meta/notify');
  const notify = (await notifyRef.get()).data() || { lastGameId: null, statuses: {} };
  let autoOpenedKickoff = notify.autoOpenedKickoff || null;

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
    // Stage the "poll's open" announcement for organiser review. It auto-sends
    // once the grace window (config.announceGraceMinutes) elapses.
    await db.doc('meta/announcement').set(logic.buildAnnouncement('poll-open', { game, recipients: Object.values(players), config }));
    console.log(`Auto-opened poll for ${plan.dateLabel} (kickoff ${plan.kickoffAt}). Announcement staged.`);
  }

  // Send (or drop) the pending "poll's open" announcement, held for review.
  await processAnnouncement(gameId, game, players);

  // No open game → reset the marker so the next open triggers a fresh alert.
  if (!gameId) { await notifyRef.set({ lastGameId: null, statuses: {}, autoOpenedKickoff }, { merge: true }); console.log('No open game.'); return; }

  if (!game || game.status === 'completed') {
    await notifyRef.set({ lastGameId: gameId, statuses: {}, autoOpenedKickoff }, { merge: true });
    console.log('Game not active.'); return;
  }

  // Game called off → the "no game this week" broadcast is a staged
  // announcement (handled above by processAnnouncement); just go quiet here.
  if (game.status === 'cancelled') {
    await notifyRef.set({ lastGameId: gameId, statuses: {}, noticeGameId: gameId, autoOpenedKickoff }, { merge: true });
    console.log('Done (cancelled).'); return;
  }
  // "Game moved" (reschedule) and "line-up" broadcasts are also staged
  // announcements the organiser reviews — processAnnouncement sends them.

  const susSnap = await db.collection(`games/${gameId}/signups`).get();
  const signups = susSnap.docs.map(d => ({ playerId: d.id, ...d.data() }));
  const ranked = logic.rankSignups(signups, players, game.capacity, { pollOpenAt: game.createdAt, config });
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

  // Close the poll once the game has kicked off — no more sign-ups mid-match.
  if (logic.pastKickoff(game, new Date()) && game.status === 'open') {
    console.log('Kick-off passed — locking registration.');
    await db.doc(`games/${gameId}`).update({ status: 'locked', lockedAt: new Date().toISOString(), autoLocked: true });
    if (autoLockedGameId !== gameId) {
      autoLockedGameId = gameId;
      await sendSquadAlert(config, game, confirmed, ranked.filter(r => r.status === 'waitlist'), players);
    }
  }

  await notifyRef.set({ lastGameId: gameId, statuses: curr, autoLockedGameId, autoOpenedKickoff, kickoffAt: game.kickoffAt || null, venue: game.venue || '', updatedAt: new Date().toISOString() });
  console.log('Done.');
}

// Send a staged group announcement (poll's open, game moved, no game this week,
// or the line-up) once its grace window elapses — or the organiser sent it
// early — to the recipients they didn't deselect. If the game it was for is no
// longer in the matching state, drop it unsent.
async function processAnnouncement(gameId, game, players) {
  const ref = db.doc('meta/announcement');
  const snap = await ref.get();
  const ann = snap.exists ? snap.data() : null;
  if (!ann || ann.status !== 'pending') return;

  if (!logic.announcementValid(ann, game, gameId)) {
    await ref.set({ status: 'cancelled', reason: 'stale', resolvedAt: new Date().toISOString() }, { merge: true });
    console.log(`Announcement (${ann.kind}) dropped — its game is no longer in the matching state.`);
    return;
  }
  if (!logic.announcementReady(ann, new Date())) {
    console.log(`Announcement (${ann.kind}) held — grace window until ${ann.sendAfter}.`);
    return;
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
  await ref.set({ status: 'sent', sentAt: new Date().toISOString(), sentCount: audience.length }, { merge: true });
  console.log('Announcement sent.');
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

main().catch(e => { console.error(e); process.exit(1); });
