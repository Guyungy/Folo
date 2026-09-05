import { createHash, randomUUID } from "node:crypto"

import { XMLParser } from "fast-xml-parser"

import { db } from "./db.js"
import type { Feed } from "./types.js"

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "#text",
})
const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]
const text = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    const parts = value.map(text).filter((part): part is string => Boolean(part))
    return parts.length ? parts.join("") : null
  }
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (value && typeof value === "object" && "#text" in value)
    return text((value as { "#text": unknown })["#text"])
  return null
}
const stableId = (prefix: string, value: string) =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`

const knownFeedFallbacks = new Map<string, string[]>([
  [
    "https://cn.wsj.com/rss-news-and-feeds/zh-hans",
    [
      "https://news.google.com/rss/search?q=site%3Acn.wsj.com&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans",
      "https://plink.anyfeeder.com/wsj/cn",
      "https://feedx.net/rss/wsj.xml",
    ],
  ],
  [
    "https://cn.wsj.com/zh-hans/rss",
    [
      "https://news.google.com/rss/search?q=site%3Acn.wsj.com&hl=zh-CN&gl=CN&ceid=CN%3Azh-Hans",
      "https://plink.anyfeeder.com/wsj/cn",
      "https://feedx.net/rss/wsj.xml",
    ],
  ],
])

const fetchFeedDocument = async (requestedUrl: string) => {
  const normalizedUrl = requestedUrl.trim().replace(/\/$/, "")
  const candidates = [requestedUrl.trim(), ...(knownFeedFallbacks.get(normalizedUrl) ?? [])]
  const failures: string[] = []

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
          "user-agent": "Folo/1.13.0 (+https://github.com/RSSNext/Folo)",
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) {
        failures.push(`${new URL(candidate).hostname}: HTTP ${response.status}`)
        continue
      }
      const content = await response.text()
      const document = parser.parse(content) as Record<string, unknown>
      const rssChannel = (document.rss as { channel?: Record<string, unknown> } | undefined)
        ?.channel
      const atomFeed = document.feed as Record<string, unknown> | undefined
      if (rssChannel || atomFeed) return { atomFeed, contentUrl: candidate, rssChannel }
      failures.push(`${new URL(candidate).hostname}: not RSS or Atom`)
    } catch (error) {
      failures.push(
        `${new URL(candidate).hostname}: ${error instanceof Error ? error.message : "request failed"}`,
      )
    }
  }

  throw new Error(`Unable to load feed (${failures.join("; ")})`)
}

export const refreshFeed = async (url: string): Promise<Feed> => {
  const { atomFeed, contentUrl, rssChannel } = await fetchFeedDocument(url)
  const source = rssChannel ?? atomFeed
  if (!source) throw new Error("Unsupported RSS or Atom document")
  const feedId = stableId("feed", contentUrl)
  const atomLinks = array(
    source.link as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )
  const siteUrl =
    text(source.link) ?? text(atomLinks.find((link) => link["@_rel"] !== "self")?.["@_href"])
  const feed: Feed = {
    id: feedId,
    url: contentUrl,
    title: text(source.title),
    description: text(source.description ?? source.subtitle),
    image: text((source.image as { url?: unknown } | undefined)?.url) ?? text(source.logo),
    siteUrl,
    ownerUserId: null,
    errorAt: null,
    errorMessage: null,
    subscriptionCount: 0,
    updatesPerWeek: null,
    latestEntryPublishedAt: null,
  }
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO feeds (id,url,title,description,image,site_url,owner_user_id,error_at,error_message,subscription_count,updates_per_week,latest_entry_published_at,updated_at)
    VALUES (@id,@url,@title,@description,@image,@siteUrl,NULL,NULL,NULL,COALESCE((SELECT subscription_count FROM feeds WHERE id=@id),0),NULL,@latestEntryPublishedAt,@updatedAt)
    ON CONFLICT(url) DO UPDATE SET title=excluded.title,description=excluded.description,image=excluded.image,site_url=excluded.site_url,error_at=NULL,error_message=NULL,updated_at=excluded.updated_at`,
  ).run({
    id: feed.id,
    url: feed.url,
    title: feed.title,
    description: feed.description,
    image: feed.image,
    siteUrl: feed.siteUrl,
    latestEntryPublishedAt: feed.latestEntryPublishedAt,
    updatedAt: now,
  })
  const items = array(
    (rssChannel?.item ?? atomFeed?.entry) as
      Record<string, unknown> | Record<string, unknown>[] | undefined,
  )
  let latest: string | null = null
  const insert =
    db.prepare(`INSERT INTO entries (id,feed_id,title,url,content,description,guid,author,inserted_at,published_at,media,categories,attachments,extra,language)
    VALUES (@id,@feedId,@title,@url,@content,@description,@guid,@author,@insertedAt,@publishedAt,NULL,@categories,NULL,NULL,NULL)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,content=excluded.content,description=excluded.description,author=excluded.author,published_at=excluded.published_at,categories=excluded.categories`)
  db.transaction(() => {
    for (const item of items) {
      const links = array(
        item.link as Record<string, unknown> | Record<string, unknown>[] | undefined,
      )
      const itemUrl =
        text(item.link) ??
        text(links.find((link) => !link["@_rel"] || link["@_rel"] === "alternate")?.["@_href"])
      const guid = text(item.guid ?? item.id) ?? itemUrl ?? randomUUID()
      const rawDate = text(item.pubDate ?? item.published ?? item.updated)
      const publishedAt =
        rawDate && !Number.isNaN(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : now
      latest = !latest || publishedAt > latest ? publishedAt : latest
      const categories = array(item.category as unknown)
        .map((category) => text(category))
        .filter((category): category is string => Boolean(category))
      insert.run({
        id: stableId("entry", `${feedId}:${guid}`),
        feedId,
        title: text(item.title),
        url: itemUrl,
        content: text(item["content:encoded"] ?? item.content ?? item.summary),
        description: text(item.description ?? item.summary),
        guid,
        author: text(item.author ?? item["dc:creator"]),
        insertedAt: now,
        publishedAt,
        categories: categories.length ? JSON.stringify(categories) : null,
      })
    }
  })()
  db.prepare("UPDATE feeds SET latest_entry_published_at = ? WHERE id = ?").run(latest, feedId)
  return { ...feed, latestEntryPublishedAt: latest }
}
