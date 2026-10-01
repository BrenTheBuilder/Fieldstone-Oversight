import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | expired | flagged
      amount INTEGER,
      currency TEXT,
      email TEXT,
      payment_intent TEXT,
      emailed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT
    );
    CREATE INDEX IF NOT EXISTS orders_email ON orders(email);
    CREATE TABLE IF NOT EXISTS download_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      downloads INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
