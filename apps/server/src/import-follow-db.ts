import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { db } from "./db.js"

type Row = Record<string, unknown>
const sqlValue = (value: unknown): string | number | bigint | Uint8Array | null => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  )
    return value
  return value === undefined ? null : JSON.stringify(value)
}
const iso = (value: unknown) => {
  if (typeof value === "number") return new Date(value).toISOString()
  if (typeof value === "string" && value) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 10_000_000_000) return new Date(numeric).toISOString()
    if (!Number.isNaN(Date.parse(value))) return new Date(value).toISOString()
  }
  return new Date().toISOString()
}
const importedId = (kind: string, value: string) =>
  `import_${kind}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`

export interface ImportReport {
  feeds: number
  entries: number
  subscriptions: number
  reads: number
  collections: number
  summaries: number
  skippedInboxes: number
}

export function importFollowDatabase(sourcePath: string): ImportReport {
  if (!existsSync(sourcePath)) throw new Error(`Database not found: ${sourcePath}`)
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    const report: ImportReport = {
      feeds: 0,
      entries: 0,
      subscriptions: 0,
      reads: 0,
      collections: 0,
      summaries: 0,
      skippedInboxes: 0,
    }
    const feedIds = new Map<string, string>()
    const entryIds = new Map<string, string>()

    db.transaction(() => {
      for (const row of source
        .prepare("SELECT * FROM feeds WHERE url IS NOT NULL")
        .all() as Row[]) {
        const sourceId = String(row.id)
        const url = String(row.url)
        const byUrl = db.prepare("SELECT id FROM feeds WHERE url=?").get(url) as
          { id: string } | undefined
        let targetId = byUrl?.id
        if (!targetId) {
          const collision = db.prepare("SELECT url FROM feeds WHERE id=?").get(sourceId) as
            { url: string } | undefined
          targetId = collision && collision.url !== url ? importedId("feed", url) : sourceId
          db.prepare(
            `INSERT INTO feeds (id,url,title,description,image,site_url,owner_user_id,error_at,error_message,subscription_count,updates_per_week,latest_entry_published_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            targetId,
            url,
            sqlValue(row.title),
            sqlValue(row.description),
            sqlValue(row.image),
            sqlValue(row.site_url),
            null,
            sqlValue(row.error_at),
            sqlValue(row.error_message),
            Number(row.subscription_count ?? 0),
            sqlValue(row.updates_per_week),
            sqlValue(row.latest_entry_published_at),
            new Date().toISOString(),
          )
          report.feeds++
        }
        feedIds.set(sourceId, targetId)
      }

      const upsertEntry = db.prepare(
        `INSERT INTO entries (id,feed_id,title,url,content,description,guid,author,inserted_at,published_at,media,categories,attachments,extra,language)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,content=COALESCE(excluded.content,entries.content),description=COALESCE(excluded.description,entries.description),author=COALESCE(excluded.author,entries.author),published_at=excluded.published_at`,
      )
      for (const row of source
        .prepare("SELECT * FROM entries WHERE feed_id IS NOT NULL")
        .all() as Row[]) {
        const feedId = feedIds.get(String(row.feed_id))
        if (!feedId) continue
        const entryId = String(row.id)
        upsertEntry.run(
          entryId,
          feedId,
          sqlValue(row.title),
          sqlValue(row.url),
          sqlValue(row.content ?? row.source_content),
          sqlValue(row.description),
          String(row.guid || entryId),
          sqlValue(row.author),
          iso(row.inserted_at),
          iso(row.published_at),
          sqlValue(row.media),
          sqlValue(row.categories),
          sqlValue(row.attachments),
          sqlValue(row.extra),
          sqlValue(row.language),
        )
        entryIds.set(entryId, entryId)
        report.entries++
        if (Number(row.read) === 1) {
          db.prepare("INSERT OR IGNORE INTO reads VALUES (?,?,?)").run(
            "local-user",
            entryId,
            new Date().toISOString(),
          )
          report.reads++
        }
      }

      for (const row of source.prepare("SELECT * FROM subscriptions").all() as Row[]) {
        if (!row.feed_id) {
          report.skippedInboxes++
          continue
        }
        const feedId = feedIds.get(String(row.feed_id))
        if (!feedId) continue
        const result = db
          .prepare(
            `INSERT INTO subscriptions (id,user_id,feed_id,view,category,title,is_private,hide_from_timeline,created_at)
           VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,feed_id) DO NOTHING`,
          )
          .run(
            importedId("subscription", `${row.id}:${feedId}`),
            "local-user",
            feedId,
            Number(row.view ?? 0),
            sqlValue(row.category),
            sqlValue(row.title),
            Number(row.is_private ?? 0),
            sqlValue(row.hide_from_timeline),
            iso(row.created_at),
          )
        report.subscriptions += Number(result.changes)
      }

      for (const row of source.prepare("SELECT * FROM collections").all() as Row[]) {
        const entryId = entryIds.get(String(row.entry_id))
        if (!entryId) continue
        const result = db
          .prepare("INSERT OR IGNORE INTO collections VALUES (?,?,?,?)")
          .run("local-user", entryId, Number(row.view ?? 0), iso(row.created_at))
        report.collections += Number(result.changes)
      }

      for (const row of source.prepare("SELECT * FROM summaries").all() as Row[]) {
        const entryId = entryIds.get(String(row.entry_id))
        if (!entryId) continue
        db.prepare("DELETE FROM summaries WHERE entry_id=? AND language IS ?").run(
          entryId,
          sqlValue(row.language),
        )
        db.prepare("INSERT INTO summaries VALUES (?,?,?,?,?)").run(
          entryId,
          String(row.summary),
          sqlValue(row.readability_summary),
          iso(row.created_at),
          sqlValue(row.language),
        )
        report.summaries++
      }

      db.exec(
        "UPDATE feeds SET subscription_count=(SELECT COUNT(*) FROM subscriptions WHERE subscriptions.feed_id=feeds.id)",
      )
    })()
    return report
  } finally {
    source.close()
  }
}

const sourcePath = process.argv.slice(2).find((argument) => argument !== "--")
if (sourcePath) console.log(JSON.stringify(importFollowDatabase(sourcePath), null, 2))
