// server.js — tiny zero-dependency HTTP server: JSON API + static frontend.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

// Admin routes require the PIN in the x-admin-pin header.
function requireAdmin(req) {
  const pin = req.headers['x-admin-pin'];
  if (!store.checkPin(pin)) { const e = new Error('Bad PIN'); e.status = 401; throw e; }
}

async function api(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  try {
    // ---- public reads/writes -------------------------------------------
    if (method === 'GET' && pathname === '/api/state') {
      return send(res, 200, store.getState(url.searchParams.get('playerId')));
    }
    if (method === 'POST' && pathname === '/api/player') {
      const { name } = await readBody(req);
      const p = store.upsertPlayer(name);
      return send(res, 200, { player: p, state: store.getState(p.id) });
    }
    if (method === 'POST' && pathname === '/api/signup') {
      const { playerId, gameId } = await readBody(req);
      return send(res, 200, store.signup(playerId, gameId));
    }
    if (method === 'POST' && pathname === '/api/withdraw') {
      const { playerId, gameId } = await readBody(req);
      return send(res, 200, store.withdraw(playerId, gameId));
    }
    if (method === 'POST' && pathname === '/api/admin/check') {
      const { pin } = await readBody(req);
      return send(res, 200, { ok: store.checkPin(pin) });
    }

    // ---- admin-only -----------------------------------------------------
    if (pathname.startsWith('/api/admin/')) {
      requireAdmin(req);
      const body = await readBody(req);
      switch (pathname) {
        case '/api/admin/open':
          return send(res, 200, { state: store.getState(null), game: store.openGame(body) });
        case '/api/admin/lock':
          return send(res, 200, store.lockGame(body.gameId));
        case '/api/admin/reopen':
          return send(res, 200, store.reopenGame(body.gameId));
        case '/api/admin/complete':
          return send(res, 200, store.completeGame(body.gameId));
        case '/api/admin/config':
          return send(res, 200, store.updateConfig(body));
        case '/api/admin/rename':
          return send(res, 200, store.renamePlayer(body.id, body.name));
        case '/api/admin/adjust':
          return send(res, 200, store.adjustLoyalty(body.id, body.delta));
        case '/api/admin/add-player':
          store.upsertPlayer(body.name);
          return send(res, 200, store.getState(null));
      }
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, err.status || 400, { error: err.message || 'Error' });
  }
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    // SPA fallback
    try {
      const buf = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(buf);
    } catch {
      send(res, 404, { error: 'Not found' });
    }
  }
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  return serveStatic(res, url.pathname);
}).listen(PORT, () => {
  console.log(`⚽ TNTF running at http://localhost:${PORT}`);
});
