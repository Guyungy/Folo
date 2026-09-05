import { Hono } from "hono"

import type { OpenAIConfig } from "./ai.js"
import {
  generateSummary,
  generateTitle,
  readOpenAIConfig,
  streamCompletion,
  synthesizeSpeech,
  testOpenAIConfig,
  transcribeAudio,
  translateFields,
  writeOpenAIConfig,
} from "./ai.js"
import { articleContext } from "./chat-context.js"
import { db, jsonValue } from "./db.js"
import { refreshFeed } from "./rss.js"
import type { Entry, Feed } from "./types.js"

type Variables = { userId: string }
type DBValue = string | number | bigint | Uint8Array | null
const app = new Hono<{ Variables: Variables }>()
const ok = <T>(data: T) => ({ code: 0 as const, data })
const bool = (value: unknown) => Boolean(value)
const summarize = (value: string | null) => {
  if (!value) return null
  const plainText = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
  if (!plainText) return null
  const sentences = plainText.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [plainText]
  let result = ""
  for (const sentence of sentences) {
    if (result && result.length + sentence.length > 500) break
    result += sentence.trim()
    if (result.length >= 180) break
  }
  return result || plainText.slice(0, 500)
}

const feedFromRow = (row: Record<string, unknown>): Feed & { type: "feed" } => ({
  type: "feed",
  id: String(row.id),
  url: String(row.url),
  title: row.title as string | null,
  description: row.description as string | null,
  image: row.image as string | null,
  siteUrl: row.site_url as string | null,
  ownerUserId: row.owner_user_id as string | null,
  errorAt: row.error_at as string | null,
  errorMessage: row.error_message as string | null,
  subscriptionCount: Number(row.subscription_count),
  updatesPerWeek: row.updates_per_week as number | null,
  latestEntryPublishedAt: row.latest_entry_published_at as string | null,
})

const feedFromJoinedRow = (row: Record<string, unknown>) =>
  feedFromRow({
    id: row.f_id,
    url: row.f_url,
    title: row.f_title,
    description: row.f_description,
    image: row.f_image,
    site_url: row.f_site_url,
    owner_user_id: row.f_owner_user_id,
    error_at: row.f_error_at,
    error_message: row.f_error_message,
    subscription_count: row.f_subscription_count,
    updates_per_week: row.f_updates_per_week,
    latest_entry_published_at: row.f_latest_entry_published_at,
  })

const entryFromRow = (row: Record<string, unknown>): Entry => ({
  id: String(row.id),
  feedId: String(row.feed_id),
  title: row.title as string | null,
  url: row.url as string | null,
  content: (row.content ?? row.description) as string | null,
  description: row.description as string | null,
  guid: String(row.guid),
  author: row.author as string | null,
  insertedAt: String(row.inserted_at),
  publishedAt: String(row.published_at),
  media: jsonValue<unknown[]>(row.media as string | null),
  categories: jsonValue<string[]>(row.categories as string | null),
  attachments: jsonValue<unknown[]>(row.attachments as string | null),
  extra: jsonValue<Record<string, unknown>>(row.extra as string | null),
  language: row.language as string | null,
})

const stripContent = (entry: Entry) => {
  const { content: _content, feedId: _feedId, ...rest } = entry
  return rest
}

app.use("*", async (c, next) => {
  c.set("userId", "local-user")
  return next()
})
app.get("/health", (c) => c.json(ok({ status: "ok" })))
app.get("/settings/openai", async (c) => c.json(ok(await readOpenAIConfig())))
app.put("/settings/openai", async (c) => {
  const config = await c.req.json<OpenAIConfig>()
  if (!config.baseURL || !config.apiKey || !config.model)
    return c.json({ code: 400, message: "Base URL, API key, and model are required" }, 400)
  await writeOpenAIConfig(config)
  return c.json(ok({ saved: true }))
})
app.post("/settings/openai/test", async (c) => {
  const config = await c.req.json<OpenAIConfig>()
  if (!config.baseURL || !config.apiKey || !config.model)
    return c.json({ code: 400, message: "Base URL, API key, and model are required" }, 400)
  try {
    await testOpenAIConfig(config)
    return c.json(ok({ connected: true }))
  } catch (error) {
    return c.json(
      { code: 502, message: error instanceof Error ? error.message : "Connection failed" },
      502,
    )
  }
})
app.get("/ai/summary", async (c) => {
  const row = db
    .prepare("SELECT content,description FROM entries WHERE id=?")
    .get(c.req.query("id") ?? "") as
    { content: string | null; description: string | null } | undefined
  const content = row?.content ?? row?.description
  if (!content) return c.json(ok(null))
  try {
    const generated = await generateSummary(content, c.req.query("language"))
    if (generated) return c.json(ok(generated))
  } catch (error) {
    console.warn("OpenAI-compatible summary failed; using local fallback", error)
  }
  return c.json(ok(summarize(content)))
})
app.get("/ai/chat/config", async (c) => {
  const config = await readOpenAIConfig()
  const model = config.model || "local"
  return c.json({
    defaultModel: model,
    availableModels: [model],
    availableModelsMenu: [{ label: model, value: model }],
    rateLimit: {
      maxTokens: Number.MAX_SAFE_INTEGER,
      currentTokens: 0,
      remainingTokens: Number.MAX_SAFE_INTEGER,
      windowDuration: 0,
      windowResetTime: 0,
    },
    attachmentLimits: {
      maxFiles: 0,
      remainingFiles: 0,
      windowDuration: 0,
      windowResetTime: 0,
    },
    usage: { total: 0, used: 0, remaining: Number.MAX_SAFE_INTEGER, resetAt: new Date(0) },
    freeQuota: {
      shouldCheckDailyLimit: false,
      remainingRequests: Number.MAX_SAFE_INTEGER,
      remainingMonthlyRequests: Number.MAX_SAFE_INTEGER,
      role: "admin",
      dailyLimit: Number.MAX_SAFE_INTEGER,
      monthlyLimit: Number.MAX_SAFE_INTEGER,
    },
  })
})
app.post("/ai/summary-title", async (c) => {
  const body = await c.req.json<{ messages?: { role: string; content: string }[] }>()
  try {
    return c.json({ title: (await generateTitle(body.messages ?? [])) || "新对话" })
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Unable to generate title" },
      502,
    )
  }
})

const translateEntry = async (id: string, language: string, fieldsValue: string) => {
  const row = db.prepare("SELECT * FROM entries WHERE id=?").get(id) as
    Record<string, unknown> | undefined
  if (!row) return null
  const fieldMap: Record<string, string> = {
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    content: String(row.content ?? ""),
    readabilityContent: String(row.content ?? ""),
  }
  const requestedFields = fieldsValue.split(",").filter((field) => field in fieldMap)
  const source = Object.fromEntries(
    requestedFields.flatMap((field) => (fieldMap[field] ? [[field, fieldMap[field]]] : [])),
  )
  return translateFields(source, language)
}

app.get("/ai/translation", async (c) => {
  try {
    return c.json(
      ok(
        await translateEntry(
          c.req.query("id") ?? "",
          c.req.query("language") ?? "English",
          c.req.query("fields") ?? "title,description",
        ),
      ),
    )
  } catch (error) {
    return c.json(
      { code: 502, message: error instanceof Error ? error.message : "Translation failed" },
      502,
    )
  }
})
app.post("/ai/translation/batch", async (c) => {
  const body = await c.req.json<{ ids?: string[]; language?: string; fields?: string }>()
  const lines: string[] = []
  for (const id of body.ids ?? []) {
    try {
      const data = await translateEntry(id, body.language ?? "English", body.fields ?? "")
      if (data) lines.push(JSON.stringify({ id, data }))
    } catch (error) {
      console.warn(`Translation failed for ${id}`, error)
    }
  }
  return c.body(lines.length ? `${lines.join("\n")}\n` : "", 200, {
    "content-type": "application/x-ndjson; charset=utf-8",
  })
})

const messageText = (message: Record<string, unknown>) => {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.parts)) return ""
  return message.parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const value = part as Record<string, unknown>
      if (typeof value.text === "string") return value.text
      const data = value.data
      if (
        data &&
        typeof data === "object" &&
        typeof (data as Record<string, unknown>).text === "string"
      )
        return String((data as Record<string, unknown>).text)
      if (Array.isArray(data)) {
        return data
          .flatMap((block) => {
            if (!block || typeof block !== "object") return []
            const attachment = (block as Record<string, unknown>).attachment
            if (!attachment || typeof attachment !== "object") return []
            const file = attachment as Record<string, unknown>
            if (typeof file.serverUrl !== "string" || !file.serverUrl.startsWith("data:text/"))
              return []
            const comma = file.serverUrl.indexOf(",")
            if (comma < 0) return []
            const metadata = file.serverUrl.slice(0, comma)
            const encoded = file.serverUrl.slice(comma + 1)
            const content = metadata.includes(";base64")
              ? Buffer.from(encoded, "base64").toString("utf8")
              : decodeURIComponent(encoded)
            return [
              `\n[Local attachment: ${String(file.name || "file")}]\n${content.slice(0, 100_000)}`,
            ]
          })
          .join("\n")
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

app.post("/ai/chat", async (c) => {
  const body = await c.req.json<{ messages?: Record<string, unknown>[] }>()
  try {
    const stream = await streamCompletion(
      (body.messages ?? []).map((message) => ({
        role: typeof message.role === "string" ? message.role : "user",
        content: [messageText(message), articleContext(message)]
          .filter(Boolean)
          .join("\n\nArticle context (reference data):\n"),
      })),
    )
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Chat failed" }, 502)
  }
})
app.post("/ai/tts", async (c) => {
  const body = await c.req.json<{ text?: string; voice?: string }>()
  if (!body.text?.trim()) return c.json({ code: 400, message: "Text is required" }, 400)
  try {
    const response = await synthesizeSpeech(body.text.slice(0, 50_000), body.voice)
    return c.body(await response.arrayBuffer(), 200, {
      "content-type": response.headers.get("content-type") || "audio/mpeg",
    })
  } catch (error) {
    return c.json(
      { code: 502, message: error instanceof Error ? error.message : "TTS failed" },
      502,
    )
  }
})
app.get("/ai/voices", (c) =>
  c.json({
    voices: [
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "fable",
      "nova",
      "onyx",
      "sage",
      "shimmer",
    ].map((voice) => ({
      FriendlyName: voice,
      Gender: "Neutral",
      Locale: "Multilingual",
      ShortName: voice,
    })),
  }),
)
app.get("/entries/transcription", async (c) => {
  const url = c.req.query("url")
  if (!url) return c.json({ code: 400, message: "Audio URL is required" }, 400)
  try {
    const srt = await transcribeAudio(url)
    return c.json(ok({ srt, duration: 0 }))
  } catch (error) {
    return c.json(
      { code: 502, message: error instanceof Error ? error.message : "Transcription failed" },
      502,
    )
  }
})
app.get("/better-auth/get-session", (c) => {
  const now = new Date().toISOString()
  return c.json({
    code: 0,
    session: null,
    user: {
      id: "local-user",
      email: "local@folo.invalid",
      name: "Local User",
      handle: "local",
      image: null,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      role: "admin",
    },
    role: "admin",
    feedSubscriptionLimit: null,
    rsshubSubscriptionLimit: null,
  })
})

app.get("/feeds", (c) => {
  const id = c.req.query("id")
  const url = c.req.query("url")
  const row = db
    .prepare(`SELECT * FROM feeds WHERE ${id ? "id = ?" : "url = ?"}`)
    .get(id ?? url ?? "") as Record<string, unknown> | undefined
  if (!row) return c.json({ code: 404, message: "Feed not found" }, 404)
  const entries = db
    .prepare("SELECT * FROM entries WHERE feed_id = ? ORDER BY published_at DESC LIMIT ?")
    .all(String(row.id), Number(c.req.query("entriesLimit") ?? 20)) as Record<string, unknown>[]
  const subscription = db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND feed_id = ?")
    .get(c.get("userId"), String(row.id)) as Record<string, unknown> | undefined
  return c.json(
    ok({
      feed: feedFromRow(row),
      entries: entries.map(entryFromRow).map(stripContent),
      subscription: subscription ? subscriptionFromRow(subscription) : undefined,
      readCount: 0,
      subscriptionCount: Number(row.subscription_count),
    }),
  )
})

app.get("/feeds/refresh", async (c) => {
  const row = db.prepare("SELECT url FROM feeds WHERE id = ?").get(c.req.query("id") ?? "") as
    { url: string } | undefined
  if (!row) return c.json({ code: 404, message: "Feed not found" }, 404)
  try {
    await refreshFeed(row.url)
    return c.json(ok(null))
  } catch (error) {
    db.prepare("UPDATE feeds SET error_at=?, error_message=? WHERE url=?").run(
      new Date().toISOString(),
      error instanceof Error ? error.message : String(error),
      row.url,
    )
    return c.json({ code: 502, message: "Unable to refresh feed" }, 502)
  }
})

const subscriptionFromRow = (row: Record<string, unknown>) => ({
  id: String(row.id),
  userId: String(row.user_id),
  feedId: String(row.feed_id),
  listId: null,
  inboxId: null,
  view: Number(row.view),
  category: row.category as string | null,
  title: row.title as string | null,
  isPrivate: bool(row.is_private),
  hideFromTimeline: row.hide_from_timeline === null ? null : bool(row.hide_from_timeline),
  createdAt: String(row.created_at),
  type: "feed" as const,
})

app.get("/subscriptions", (c) => {
  const view = c.req.query("view")
  const rows = db
    .prepare(
      `SELECT s.*, f.id f_id, f.url f_url, f.title f_title, f.description f_description,
    f.image f_image, f.site_url f_site_url, f.owner_user_id f_owner_user_id, f.error_at f_error_at,
    f.error_message f_error_message, f.subscription_count f_subscription_count,
    f.updates_per_week f_updates_per_week, f.latest_entry_published_at f_latest_entry_published_at
    FROM subscriptions s JOIN feeds f ON f.id=s.feed_id WHERE s.user_id=? ${view === undefined ? "" : "AND s.view=?"} ORDER BY s.created_at DESC`,
    )
    .all(...(view === undefined ? [c.get("userId")] : [c.get("userId"), Number(view)])) as Record<
    string,
    unknown
  >[]
  return c.json(
    ok(rows.map((row) => ({ ...subscriptionFromRow(row), feeds: feedFromJoinedRow(row) }))),
  )
})

app.post("/subscriptions", async (c) => {
  const body = await c.req.json<{
    url?: string
    view?: number
    category?: string | null
    isPrivate?: boolean
    title?: string | null
  }>()
  if (!body.url) return c.json({ code: 400, message: "Feed URL is required" }, 400)
  let feed: Feed
  try {
    feed = await refreshFeed(body.url)
  } catch (error) {
    return c.json(
      { code: 422, message: error instanceof Error ? error.message : "Invalid feed" },
      422,
    )
  }
  const userId = c.get("userId")
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(user_id,feed_id) DO UPDATE SET view=excluded.view,category=excluded.category,title=excluded.title,is_private=excluded.is_private`,
  ).run(
    crypto.randomUUID(),
    userId,
    feed.id,
    body.view ?? 0,
    body.category ?? null,
    body.title ?? null,
    body.isPrivate ? 1 : 0,
    now,
  )
  db.prepare(
    "UPDATE feeds SET subscription_count=(SELECT COUNT(*) FROM subscriptions WHERE feed_id=?) WHERE id=?",
  ).run(feed.id, feed.id)
  const unread = db
    .prepare(
      "SELECT COUNT(*) count FROM entries e LEFT JOIN reads r ON r.entry_id=e.id AND r.user_id=? WHERE e.feed_id=? AND r.entry_id IS NULL",
    )
    .get(userId, feed.id) as { count: number }
  return c.json({
    code: 0,
    feed: { ...feed, type: "feed" },
    list: null,
    unread: { [feed.id]: unread.count },
  })
})

app.patch("/subscriptions", async (c) => {
  const body = await c.req.json<Record<string, unknown>>()
  if (!body.feedId) return c.json({ code: 400, message: "feedId is required" }, 400)
  const fields: string[] = []
  const values: DBValue[] = []
  for (const [key, column] of [
    ["view", "view"],
    ["category", "category"],
    ["title", "title"],
    ["isPrivate", "is_private"],
    ["hideFromTimeline", "hide_from_timeline"],
  ] as const) {
    if (key in body) {
      fields.push(`${column}=?`)
      const value = body[key]
      values.push(
        typeof value === "boolean"
          ? Number(value)
          : value === undefined
            ? null
            : (value as DBValue),
      )
    }
  }
  if (fields.length)
    db.prepare(`UPDATE subscriptions SET ${fields.join(",")} WHERE user_id=? AND feed_id=?`).run(
      ...values,
      c.get("userId"),
      String(body.feedId),
    )
  const row = db
    .prepare("SELECT * FROM subscriptions WHERE user_id=? AND feed_id=?")
    .get(c.get("userId"), String(body.feedId)) as Record<string, unknown>
  return c.json(ok(subscriptionFromRow(row)))
})

app.patch("/subscriptions/batch", async (c) => {
  const body = await c.req.json<{
    feedIds: string[]
    view?: number
    category?: string | null
    isPrivate?: boolean
    title?: string | null
  }>()
  for (const feedId of body.feedIds) {
    const fields: string[] = []
    const values: DBValue[] = []
    for (const [key, column] of [
      ["view", "view"],
      ["category", "category"],
      ["title", "title"],
      ["isPrivate", "is_private"],
    ] as const)
      if (key in body) {
        fields.push(`${column}=?`)
        const value = body[key]
        values.push(typeof value === "boolean" ? Number(value) : value === undefined ? null : value)
      }
    if (fields.length)
      db.prepare(`UPDATE subscriptions SET ${fields.join(",")} WHERE user_id=? AND feed_id=?`).run(
        ...values,
        c.get("userId"),
        feedId,
      )
  }
  return c.json(ok(null))
})

app.delete("/subscriptions", async (c) => {
  const body = await c.req.json<{ feedId?: string; feedIdList?: string[]; url?: string }>()
  let ids = body.feedIdList ?? (body.feedId ? [body.feedId] : [])
  if (body.url) {
    const row = db.prepare("SELECT id FROM feeds WHERE url=?").get(body.url) as
      { id: string } | undefined
    if (row) ids = [row.id]
  }
  const remove = db.prepare("DELETE FROM subscriptions WHERE user_id=? AND feed_id=?")
  db.transaction(() => ids.forEach((id) => remove.run(c.get("userId"), id)))()
  return c.json(ok(null))
})

app.post("/entries", async (c) => {
  const body = await c.req.json<{
    feedId?: string
    feedIdList?: string[]
    view?: number
    read?: boolean
    limit?: number
    publishedAfter?: string
    publishedBefore?: string
    isCollection?: boolean
    withContent?: boolean
  }>()
  const clauses = ["s.user_id=?"]
  const values: DBValue[] = [c.get("userId")]
  if (body.feedId) {
    clauses.push("e.feed_id=?")
    values.push(body.feedId)
  }
  if (body.feedIdList?.length) {
    clauses.push(`e.feed_id IN (${body.feedIdList.map(() => "?").join(",")})`)
    values.push(...body.feedIdList)
  }
  if (body.view !== undefined) {
    clauses.push("s.view=?")
    values.push(body.view)
  }
  if (body.read !== undefined)
    clauses.push(body.read ? "r.entry_id IS NOT NULL" : "r.entry_id IS NULL")
  if (body.isCollection) clauses.push("c.entry_id IS NOT NULL")
  if (body.publishedAfter) {
    clauses.push("e.published_at < ?")
    values.push(body.publishedAfter)
  }
  if (body.publishedBefore) {
    clauses.push("e.published_at > ?")
    values.push(body.publishedBefore)
  }
  values.push(Math.min(body.limit ?? 20, 100))
  const rows = db
    .prepare(
      `SELECT e.*, r.entry_id read_id, c.created_at collection_created,
    f.id f_id,f.url f_url,f.title f_title,f.description f_description,f.image f_image,
    f.site_url f_site_url,f.owner_user_id f_owner_user_id,f.error_at f_error_at,
    f.error_message f_error_message,f.subscription_count f_subscription_count,
    f.updates_per_week f_updates_per_week,f.latest_entry_published_at f_latest_entry_published_at,
    e.id entry_id,e.url entry_url,e.title entry_title,e.description entry_description,e.feed_id entry_feed_id
    FROM entries e JOIN feeds f ON f.id=e.feed_id JOIN subscriptions s ON s.feed_id=e.feed_id
    LEFT JOIN reads r ON r.entry_id=e.id AND r.user_id=s.user_id LEFT JOIN collections c ON c.entry_id=e.id AND c.user_id=s.user_id
    WHERE ${clauses.join(" AND ")} ORDER BY e.published_at ${body.publishedBefore ? "ASC" : "DESC"} LIMIT ?`,
    )
    .all(...values) as Record<string, unknown>[]
  return c.json(
    ok(
      rows.map((row) => {
        const entry = entryFromRow({
          ...row,
          id: row.entry_id,
          url: row.entry_url,
          title: row.entry_title,
          description: row.entry_description,
          feed_id: row.entry_feed_id,
        })
        return {
          read: Boolean(row.read_id),
          view: 0,
          from: [String(row.entry_feed_id)],
          feeds: feedFromJoinedRow(row),
          entries: stripContent(entry),
          collections: row.collection_created
            ? { createdAt: String(row.collection_created) }
            : undefined,
        }
      }),
    ),
  )
})

app.get("/entries", (c) => {
  const row = db
    .prepare(
      `SELECT e.*,f.id f_id,f.url f_url,f.title f_title,f.description f_description,
    f.image f_image,f.site_url f_site_url,f.owner_user_id f_owner_user_id,f.error_at f_error_at,
    f.error_message f_error_message,f.subscription_count f_subscription_count,
    f.updates_per_week f_updates_per_week,f.latest_entry_published_at f_latest_entry_published_at,
    e.id entry_id,e.url entry_url,e.title entry_title,e.description entry_description,e.feed_id entry_feed_id
    FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE e.id=?`,
    )
    .get(c.req.query("id") ?? "") as Record<string, unknown> | undefined
  if (!row) return c.json(ok(null))
  const entry = entryFromRow({
    ...row,
    id: row.entry_id,
    url: row.entry_url,
    title: row.entry_title,
    description: row.entry_description,
    feed_id: row.entry_feed_id,
  })
  const { feedId: _feedId, ...entryPayload } = entry
  return c.json(ok({ feeds: feedFromJoinedRow(row), entries: entryPayload }))
})

app.get("/entries/readability", (c) => {
  const row = db
    .prepare("SELECT content,description FROM entries WHERE id=?")
    .get(c.req.query("id") ?? "") as
    { content: string | null; description: string | null } | undefined
  return c.json(ok(row ? { content: row.content ?? row.description ?? undefined } : null))
})

app.get("/entries/check-new", (c) => {
  const row = db
    .prepare(
      "SELECT id,inserted_at FROM entries WHERE inserted_at>? ORDER BY inserted_at DESC LIMIT 1",
    )
    .get(new Date(Number(c.req.query("insertedAfter"))).toISOString()) as
    { id: string; inserted_at: string } | undefined
  return c.json(ok({ has_new: Boolean(row), lastest_at: row?.inserted_at, entry_id: row?.id }))
})

app.get("/reads", (c) => {
  const rows = db
    .prepare(
      `SELECT s.feed_id id,COUNT(e.id) count FROM subscriptions s JOIN entries e ON e.feed_id=s.feed_id LEFT JOIN reads r ON r.entry_id=e.id AND r.user_id=s.user_id WHERE s.user_id=? AND r.entry_id IS NULL GROUP BY s.feed_id`,
    )
    .all(c.get("userId")) as { id: string; count: number }[]
  return c.json(ok(Object.fromEntries(rows.map((row) => [row.id, row.count]))))
})
app.get("/reads/total-count", (c) => {
  const row = db
    .prepare(
      `SELECT COUNT(e.id) count FROM subscriptions s JOIN entries e ON e.feed_id=s.feed_id LEFT JOIN reads r ON r.entry_id=e.id AND r.user_id=s.user_id WHERE s.user_id=? AND r.entry_id IS NULL`,
    )
    .get(c.get("userId")) as { count: number }
  return c.json(ok(row))
})
app.post("/reads", async (c) => {
  const body = await c.req.json<{ entryIds: string[] }>()
  const stmt = db.prepare("INSERT OR REPLACE INTO reads VALUES (?,?,?)")
  const now = new Date().toISOString()
  db.transaction(() => body.entryIds.forEach((id) => stmt.run(c.get("userId"), id, now)))()
  return c.json(ok(null))
})
app.delete("/reads", async (c) => {
  const body = await c.req.json<{ entryId: string }>()
  db.prepare("DELETE FROM reads WHERE user_id=? AND entry_id=?").run(c.get("userId"), body.entryId)
  return c.json(ok(null))
})
app.post("/reads/all", async (c) => {
  const body = await c.req.json<{ feedId?: string; feedIdList?: string[]; view?: number }>()
  const clauses = ["s.user_id=?"]
  const values: DBValue[] = [c.get("userId")]
  if (body.feedId) {
    clauses.push("e.feed_id=?")
    values.push(body.feedId)
  }
  if (body.feedIdList?.length) {
    clauses.push(`e.feed_id IN (${body.feedIdList.map(() => "?").join(",")})`)
    values.push(...body.feedIdList)
  }
  if (body.view !== undefined) {
    clauses.push("s.view=?")
    values.push(body.view)
  }
  const rows = db
    .prepare(
      `SELECT e.id,e.feed_id FROM entries e JOIN subscriptions s ON s.feed_id=e.feed_id WHERE ${clauses.join(" AND ")}`,
    )
    .all(...values) as { id: string; feed_id: string }[]
  const stmt = db.prepare("INSERT OR IGNORE INTO reads VALUES (?,?,?)")
  const counts: Record<string, number> = {}
  db.transaction(() =>
    rows.forEach((row) => {
      if (stmt.run(c.get("userId"), row.id, new Date().toISOString()).changes)
        counts[row.feed_id] = (counts[row.feed_id] ?? 0) + 1
    }),
  )()
  return c.json(ok({ read: counts }))
})

app.get("/collections", (c) => {
  const row = db
    .prepare("SELECT 1 FROM collections WHERE user_id=? AND entry_id=?")
    .get(c.get("userId"), c.req.query("entryId") ?? "")
  return c.json(ok(Boolean(row)))
})
app.post("/collections", async (c) => {
  const body = await c.req.json<{ entryId: string; view?: number }>()
  db.prepare("INSERT OR REPLACE INTO collections VALUES (?,?,?,?)").run(
    c.get("userId"),
    body.entryId,
    body.view ?? 0,
    new Date().toISOString(),
  )
  return c.json(ok(null))
})
app.delete("/collections", async (c) => {
  const body = await c.req.json<{ entryId: string }>()
  db.prepare("DELETE FROM collections WHERE user_id=? AND entry_id=?").run(
    c.get("userId"),
    body.entryId,
  )
  return c.json(ok(null))
})

app.notFound((c) =>
  c.json({ code: 404, message: `Not implemented: ${c.req.method} ${c.req.path}` }, 404),
)
app.onError((error, c) => {
  console.error(error)
  return c.json(
    {
      code: 500,
      message: process.env.NODE_ENV === "production" ? "Internal server error" : error.message,
    },
    500,
  )
})

export { app }
