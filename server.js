'use strict';
/**
 * Logic Quest backend - zero npm dependencies (Node >= 22.5).
 * Serves the game from /public and exposes a small JSON API backed by SQLite.
 * Players get an anonymous guest account via an HttpOnly cookie; no sign-up needed.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const COOKIE_SECURE = String(process.env.COOKIE_SECURE).toLowerCase() === 'true';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'lq_sid';
const MAX_BODY = 64 * 1024;

// What the game is allowed to store (mirrors the state object in index.html)
const PROFILE_KEYS = ['name', 'pts', 'stars', 'done', 'prog', 'att', 'seen', 'ok', 'rw', 'snd'];
const COLLECTIONS = { badges: 50, custom: 200, history: 500 }; // name -> max docs per user
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ITEM = 8 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ---------- tiny in-memory rate limiter ----------
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t > b.reset) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  return ++b.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60_000).unref();

// ---------- helpers ----------
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${60 * 60 * 24 * 365}`];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object';
  const payload = isObj ? JSON.stringify(body) : body ?? '';
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const isPlainObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // The game is a single HTML file with inline <script>/<style>, so 'unsafe-inline' is required.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LQ, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const ip = clientIp(req);
  if (limited('api:' + ip, 600, 60_000)) return send(res, 429, { error: 'Too many requests' }, { 'Retry-After': '60' });

  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"

  // CSRF defence in depth: state-changing calls must carry a custom header (forces a CORS preflight cross-site).
  if (method !== 'GET' && method !== 'OPTIONS' && req.headers['x-lq'] !== '1') return send(res, 403, { error: 'Missing X-LQ header' });

  // Public
  if (method === 'GET' && parts[0] === 'leaderboard') {
    return send(res, 200, { top: store.leaderboard(20) }, { 'Cache-Control': 'public, max-age=15' });
  }

  // Session bootstrap: returns existing user or creates a guest account
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let userId = store.userFromToken(bearer || parseCookies(req)[COOKIE]);
  if (method === 'POST' && parts[0] === 'session') {
    if (!userId) {
      if (limited('new:' + ip, 40, 60 * 60_000)) return send(res, 429, { error: 'Too many new accounts from this address' });
      const u = store.createUser();
      setSessionCookie(res, u.token);
      userId = u.userId;
      return send(res, 200, { id: userId, token: u.token }); // token is shown once; cross-site clients keep it and send it as a Bearer header
    }
    return send(res, 200, { id: userId });
  }
  if (!userId) return send(res, 401, { error: 'No session. POST /api/session first.' });

  if (parts[0] === 'me' && method === 'GET') return send(res, 200, { id: userId });

  if (parts[0] === 'profile') {
    if (method === 'GET') {
      const data = store.getProfile(userId);
      return send(res, 200, { exists: !!data, data });
    }
    if (method === 'PUT') {
      const body = await readJson(req);
      if (!isPlainObj(body)) return send(res, 400, { error: 'Body must be an object' });
      const clean = {};
      for (const k of PROFILE_KEYS) if (k in body) clean[k] = body[k];
      if (clean.name !== undefined && typeof clean.name !== 'string') return send(res, 400, { error: 'name must be a string' });
      if (clean.pts !== undefined && typeof clean.pts !== 'number') return send(res, 400, { error: 'pts must be a number' });
      store.saveProfile(userId, clean);
      return send(res, 200, { ok: true });
    }
  }

  if (parts[0] === 'c' && COLLECTIONS[parts[1]]) {
    const sub = parts[1], id = parts[2];
    if (!id && method === 'GET') return send(res, 200, { items: store.listItems(userId, sub) });
    if (id && !ID_RE.test(id)) return send(res, 400, { error: 'Invalid id' });
    if (id && method === 'PUT') {
      const body = await readJson(req);
      if (!isPlainObj(body)) return send(res, 400, { error: 'Body must be an object' });
      if (JSON.stringify(body).length > MAX_ITEM) return send(res, 413, { error: 'Item too large' });
      store.saveItem(userId, sub, id, body, COLLECTIONS[sub]);
      return send(res, 200, { ok: true });
    }
    if (id && method === 'DELETE') return send(res, 200, { ok: true, deleted: store.deleteItem(userId, sub, id) });
  }

  if (parts[0] === 'account' && method === 'DELETE') { // lets a player erase all their data
    store.deleteUser(userId);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------- static files ----------
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden'); // path traversal guard
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  applyCors(req, res);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/health') return send(res, 200, { ok: true, ...store.stats() });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Logic Quest running on http://localhost:${PORT}`));
  const stop = () => { server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { server };
