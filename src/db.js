import { DatabaseSync } from 'node:sqlite';

// Shared connection setup. Every process (server, migrate CLI, tests) opens the
// same way so pragmas can never silently differ between them.
export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

export function setConfig(db, key, value) {
  db.prepare(
    'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Identity rule from the EDD: a customer is a normalized email.
export function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}
