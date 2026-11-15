import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  color           TEXT NOT NULL,
  rejoin_code     TEXT NOT NULL UNIQUE,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  notify_time     TEXT NOT NULL DEFAULT '08:00',
  notify_replies  INTEGER NOT NULL DEFAULT 1,
  last_daily_push TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per remembered device. The token itself is never stored, only its hash.
CREATE TABLE IF NOT EXISTS devices (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS words (
  id            INTEGER PRIMARY KEY,
  publish_date  TEXT NOT NULL,
  slot          INTEGER NOT NULL,
  word          TEXT NOT NULL,
  part_of_speech TEXT NOT NULL DEFAULT '',
  pronunciation TEXT NOT NULL DEFAULT '',
  definition    TEXT NOT NULL,
  example       TEXT NOT NULL DEFAULT '',
  origin        TEXT NOT NULL DEFAULT '',
  prompt        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (publish_date, slot)
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY,
  word_id     INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS comments_word ON comments(word_id);

CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS reactions (
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  PRIMARY KEY (word_id, user_id, kind)
);

CREATE TABLE IF NOT EXISTS saved (
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (word_id, user_id)
);

CREATE TABLE IF NOT EXISTS visits (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'wordclub.db');
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
