import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export const GUEST_LIMIT = 10;
export const INVITE_DURATION = 7 * 24 * 60 * 60 * 1000;
export const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;

export function openCatalog(directory) {
  const db = new DatabaseSync(join(directory, 'catalog.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'guest'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS single_owner ON users(role) WHERE role = 'owner';
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      token TEXT UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'revoked')),
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_email ON sessions(email);
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size > 0),
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('uploading', 'ready', 'trashed')),
      created INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS media_status ON media(status, created);
    CREATE INDEX IF NOT EXISTS media_fingerprint ON media(fingerprint);
  `);
  return db;
}

export function atomic(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
