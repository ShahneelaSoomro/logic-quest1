'use strict';
const os = require('node:os'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-'));
const { server } = require('../server');

let base;
const jar = () => { let c = ''; return { get: () => c, set: (v) => { if (v) c = v.split(';')[0]; } }; };
async function call(j, method, url, body, extra = {}) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-LQ': '1', Cookie: j.get(), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  j.set(r.headers.get('set-cookie'));
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
}
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

server.listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    const A = jar(), B = jar();
    await t('health works', async () => { const r = await fetch(base + '/health'); assert.equal((await r.json()).ok, true); });
    await t('serves the game + adapter with security headers', async () => {
      const r = await fetch(base + '/'); const html = await r.text();
      assert.match(html, /Logic Quest/); assert.match(html, /lq-backend\.js/);
      assert.ok(r.headers.get('content-security-policy')); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal((await fetch(base + '/js/lq-backend.js')).status, 200);
    });
    await t('blocks path traversal', async () => {
      const r = await fetch(base + '/..%2Fserver.js'); assert.notEqual(r.status, 200);
      const r2 = await fetch(base + '/%2e%2e/db.js'); assert.notEqual(r2.status, 200);
    });
    await t('API requires a session', async () => { assert.equal((await call(jar(), 'GET', '/api/profile')).status, 401); });
    await t('POST /api/session creates a guest and sets an HttpOnly cookie', async () => {
      const r = await call(A, 'POST', '/api/session'); assert.equal(r.status, 200); assert.ok(r.json.id);
      assert.match(r.headers.get('set-cookie'), /HttpOnly/);
      const again = await call(A, 'POST', '/api/session'); assert.equal(again.json.id, r.json.id); // idempotent
    });
    await t('Bearer token auth works without cookies (cross-site mode)', async () => {
      const r = await fetch(base + '/api/session', { method: 'POST', headers: { 'X-LQ': '1' } }); const j = await r.json();
      assert.ok(j.token);
      const me = await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + j.token } });
      assert.equal((await me.json()).id, j.id);
      assert.equal((await fetch(base + '/api/me', { headers: { Authorization: 'Bearer nope' } })).status, 401);
    });
    await t('new profile does not exist yet', async () => { assert.equal((await call(A, 'GET', '/api/profile')).json.exists, false); });
    await t('profile round-trip; unknown keys dropped', async () => {
      const p = { name: 'Ada', pts: 120, stars: { L1: 3 }, done: { L1: true }, snd: false, evil: '<script>' };
      assert.equal((await call(A, 'PUT', '/api/profile', p)).status, 200);
      const g = (await call(A, 'GET', '/api/profile')).json;
      assert.equal(g.exists, true); assert.equal(g.data.name, 'Ada'); assert.equal(g.data.pts, 120); assert.equal(g.data.stars.L1, 3); assert.equal(g.data.evil, undefined);
    });
    await t('badges / custom / history CRUD', async () => {
      await call(A, 'PUT', '/api/c/badges/L1', { id: 'L1', lv: 1, title: 'Gate Rookie' });
      await call(A, 'PUT', '/api/c/custom/c123', { id: 'c123', n: 'Mine', b: '0110', t: 1 });
      await call(A, 'PUT', '/api/c/history/h1', { c: 'AND gate', ok: true, p: 40, t: 1 });
      assert.equal((await call(A, 'GET', '/api/c/badges')).json.items[0].data.title, 'Gate Rookie');
      assert.equal((await call(A, 'GET', '/api/c/custom')).json.items.length, 1);
      assert.equal((await call(A, 'DELETE', '/api/c/custom/c123')).json.deleted, true);
      assert.equal((await call(A, 'GET', '/api/c/custom')).json.items.length, 0);
    });
    await t('users are isolated from each other', async () => {
      await call(B, 'POST', '/api/session');
      assert.equal((await call(B, 'GET', '/api/profile')).json.exists, false);
      assert.equal((await call(B, 'GET', '/api/c/badges')).json.items.length, 0);
    });
    await t('validation: bad collection, id, type, size, JSON, missing header', async () => {
      assert.equal((await call(A, 'GET', '/api/c/secrets')).status, 404);
      assert.equal((await call(A, 'PUT', '/api/c/badges/bad%20id!', { a: 1 })).status, 400);
      assert.equal((await call(A, 'PUT', '/api/profile', { pts: 'lots' })).status, 400);
      assert.equal((await call(A, 'PUT', '/api/c/custom/big', { x: 'a'.repeat(9000) })).status, 413);
      const raw = await fetch(base + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-LQ': '1', Cookie: A.get() }, body: '{nope' });
      assert.equal(raw.status, 400);
      const noHdr = await fetch(base + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: A.get() }, body: '{}' });
      assert.equal(noHdr.status, 403);
    });
    await t('history is capped (oldest pruned)', async () => {
      const C = jar(); await call(C, 'POST', '/api/session');
      for (let i = 0; i < 505; i++) await call(C, 'PUT', '/api/c/history/h' + i, { t: i });
      assert.equal((await call(C, 'GET', '/api/c/history')).json.items.length, 500);
    });
    await t('leaderboard exposes only name + points', async () => {
      const r = (await call(jar(), 'GET', '/api/leaderboard')).json.top;
      assert.ok(r.length >= 1); assert.deepEqual(Object.keys(r[0]).sort(), ['name', 'pts']);
    });
    await t('game adapter flow (same calls as dbInit) works end-to-end', async () => {
      // Run the real browser adapter in a fake window, with fetch bound to a cookie jar
      const J = jar();
      const mem = {}; global.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } }; global.location = { hostname: 'localhost' }; global.window = { LQ_API_BASE: '' }; global.document = { body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }) };
      global.URL.createObjectURL = () => 'blob:x'; global.URL.revokeObjectURL = () => {};
      const realFetch = global.fetch;
      global.fetch = (u, o = {}) => realFetch(base + u, { ...o, headers: { ...o.headers, Cookie: J.get() } }).then((r) => { J.set(r.headers.get('set-cookie')); return r; });
      delete global.claude; global.claude = undefined; delete global.claude;
      eval(fs.readFileSync(path.join(__dirname, '../public/js/lq-backend.js'), 'utf8').replace("typeof window.claude !== 'undefined'", 'false'));
      const claude = global.window.claude;
      const u = await claude.use('user'), id = await u.id(); assert.ok(id);
      const d = await claude.use('db'), ROOT = d.doc('data/users/' + id + '/profile');
      assert.equal((await ROOT.get()).exists, false);
      await ROOT.set({ name: 'Zed', pts: 50 });
      await ROOT.collection('badges').doc('L1').set({ id: 'L1', lv: 1 });
      const p = await ROOT.get(); assert.equal(p.exists, true); assert.equal(p.data().name, 'Zed');
      const b = await ROOT.collection('badges').get(); assert.equal(b.docs[0].id, 'L1'); assert.equal(b.docs[0].data().lv, 1);
      await ROOT.collection('badges').doc('L1').delete();
      assert.equal((await ROOT.collection('badges').get()).docs.length, 0);
      assert.ok(await claude.use('downloads'));
      global.fetch = realFetch;
    });
    await t('account deletion erases data', async () => {
      assert.equal((await call(A, 'DELETE', '/api/account')).status, 200);
      assert.equal((await call(A, 'GET', '/api/profile')).status, 401);
    });
    console.log(`\nAll ${passed} tests passed`);
    server.close(); process.exit(0);
  } catch (e) { console.error('\nFAILED:', e); process.exit(1); }
});
