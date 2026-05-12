// SQLite schema + open helper. WAL mode so SSE readers don't block writers
// during the burst of state-change events that come in when many agents
// are active at once.

import Database from 'better-sqlite3';

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      api_key_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      user TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (user, agent_name, instance_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_events_seat ON events(user, agent_name, instance_id, ts DESC);

    CREATE TABLE IF NOT EXISTS assets (
      user TEXT NOT NULL,
      state TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (user, state)
    );

    CREATE TABLE IF NOT EXISTS idempotency (
      client_id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    );
  `);

  return db;
}
