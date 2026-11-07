import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_V1 = `
CREATE TABLE repos (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  default_branch TEXT,
  created_at    INTEGER NOT NULL
);
CREATE TABLE branches (
  id            INTEGER PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  name          TEXT NOT NULL,
  head_sha      TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  rewritten_at  INTEGER,
  last_commit_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(repo_id, name)
);
CREATE TABLE commits (
  id            INTEGER PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  sha           TEXT NOT NULL,
  author_name   TEXT,
  author_email  TEXT,
  committed_at  INTEGER NOT NULL,
  subject       TEXT,
  body          TEXT,
  first_seen_branch TEXT,
  first_seen_at INTEGER NOT NULL,
  UNIQUE(repo_id, sha)
);
CREATE TABLE fetch_events (
  id            INTEGER PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL,
  new_commits   INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
`

function migrate(db: Database.Database): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0
  if (version < 1) {
    db.exec(SCHEMA_V1)
    db.pragma('user_version = 1')
  }
}

export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
