'use strict';
// SQLite storage layer (built-in node:sqlite, no npm packages needed).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'logicquest.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL DEFAULT 'Player',
    pts        INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_profiles_pts ON profiles(pts DESC);
  -- badges / custom challenges / history all live here, keyed by sub-collection name
  CREATE TABLE IF NOT EXISTS items (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sub        TEXT NOT NULL,
    id         TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, sub, id)
  );
`);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

const q = {
  insUser: db.prepare('INSERT INTO users (id, created_at, last_seen) VALUES (?,?,?)'),
  insSess: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?,?,?)'),
  sessUser: db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?'),
  touch: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
  getProfile: db.prepare('SELECT data FROM profiles WHERE user_id = ?'),
  upProfile: db.prepare(`INSERT INTO profiles (user_id, name, pts, data, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, pts=excluded.pts, data=excluded.data, updated_at=excluded.updated_at`),
  listItems: db.prepare('SELECT id, data FROM items WHERE user_id = ? AND sub = ? ORDER BY updated_at ASC'),
  upItem: db.prepare(`INSERT INTO items (user_id, sub, id, data, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, sub, id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`),
  delItem: db.prepare('DELETE FROM items WHERE user_id = ? AND sub = ? AND id = ?'),
  countItems: db.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND sub = ?'),
  pruneItems: db.prepare(`DELETE FROM items WHERE user_id = ? AND sub = ? AND id IN (
    SELECT id FROM items WHERE user_id = ? AND sub = ? ORDER BY updated_at ASC LIMIT ?)`),
  board: db.prepare('SELECT name, pts FROM profiles ORDER BY pts DESC, updated_at ASC LIMIT ?'),
  delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  stats: db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM items) AS items'),
};

module.exports = {
  /** Create a guest user + session. Returns { userId, token }. Token is only ever stored hashed. */
  createUser() {
    const userId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    q.insUser.run(userId, t, t);
    q.insSess.run(sha(token), userId, t);
    return { userId, token };
  },
  userFromToken(token) {
    if (!token || token.length > 100) return null;
    const row = q.sessUser.get(sha(token));
    if (!row) return null;
    q.touch.run(now(), row.user_id);
    return row.user_id;
  },
  getProfile(userId) {
    const r = q.getProfile.get(userId);
    return r ? JSON.parse(r.data) : null;
  },
  saveProfile(userId, obj) {
    const name = String(obj.name || 'Player').slice(0, 20);
    const pts = Number.isFinite(obj.pts) ? Math.max(0, Math.min(1e7, Math.floor(obj.pts))) : 0;
    q.upProfile.run(userId, name, pts, JSON.stringify({ ...obj, name, pts }), now());
  },
  listItems(userId, sub) {
    return q.listItems.all(userId, sub).map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
  },
  saveItem(userId, sub, id, obj, maxItems) {
    q.upItem.run(userId, sub, id, JSON.stringify(obj), now());
    const { n } = q.countItems.get(userId, sub);
    if (n > maxItems) q.pruneItems.run(userId, sub, userId, sub, n - maxItems); // drop oldest
  },
  deleteItem(userId, sub, id) { return q.delItem.run(userId, sub, id).changes > 0; },
  leaderboard(limit = 20) { return q.board.all(limit); },
  deleteUser(userId) { q.delUser.run(userId); },
  stats() { return q.stats.get(); },
  close() { db.close(); },
};
