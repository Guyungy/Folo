import { mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { dirname, resolve } from "pathe"

const databasePath = resolve(process.cwd(), process.env.DATABASE_PATH ?? "./data/folo.db")
mkdirSync(dirname(databasePath), { recursive: true })

class Database extends DatabaseSync {
  transaction<T>(operation: () => T) {
    return () => {
      this.exec("BEGIN")
      try {
        const result = operation()
        this.exec("COMMIT")
        return result
      } catch (error) {
        this.exec("ROLLBACK")
        throw error
      }
    }
  }
}

export const db = new Database(databasePath)
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON")

db.exec(`
  CREATE TABLE IF NOT EXISTS feeds (
    id TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, title TEXT, description TEXT, image TEXT,
    site_url TEXT, owner_user_id TEXT, error_at TEXT, error_message TEXT,
    subscription_count INTEGER NOT NULL DEFAULT 0, updates_per_week INTEGER,
    latest_entry_published_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, title TEXT, url TEXT, content TEXT,
    description TEXT, guid TEXT NOT NULL, author TEXT, inserted_at TEXT NOT NULL,
    published_at TEXT NOT NULL, media TEXT, categories TEXT, attachments TEXT,
    extra TEXT, language TEXT, FOREIGN KEY(feed_id) REFERENCES feeds(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS entries_feed_published ON entries(feed_id, published_at DESC);
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, feed_id TEXT NOT NULL,
    view INTEGER NOT NULL DEFAULT 0, category TEXT, title TEXT, is_private INTEGER NOT NULL DEFAULT 0,
    hide_from_timeline INTEGER, created_at TEXT NOT NULL,
    UNIQUE(user_id, feed_id),
    FOREIGN KEY(feed_id) REFERENCES feeds(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS reads (
    user_id TEXT NOT NULL, entry_id TEXT NOT NULL, read_at TEXT NOT NULL,
    PRIMARY KEY(user_id, entry_id),
    FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS collections (
    user_id TEXT NOT NULL, entry_id TEXT NOT NULL, view INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, entry_id),
    FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS summaries (
    entry_id TEXT NOT NULL, summary TEXT NOT NULL, readability_summary TEXT,
    created_at TEXT, language TEXT,
    UNIQUE(entry_id, language),
    FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );
`)

export const jsonValue = <T>(value: string | null): T | null =>
  value === null ? null : (JSON.parse(value) as T)
