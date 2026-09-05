import { rmSync } from "node:fs"

import { resolve } from "pathe"
import { afterAll, describe, expect, it, vi } from "vitest"

const testDatabasePath = `./data/test-${process.pid}.db`
process.env.DATABASE_PATH = testDatabasePath

const { app } = await import("./app.js")
const { db } = await import("./db.js")
const { articleContext } = await import("./chat-context.js")

afterAll(() => {
  db.close()
  for (const suffix of ["", "-shm", "-wal"])
    rmSync(`${resolve(testDatabasePath)}${suffix}`, { force: true })
})

describe("local data service", () => {
  it("provides a built-in local user without a session", async () => {
    const session = await app.request("/better-auth/get-session")
    expect(await session.json()).toMatchObject({
      code: 0,
      session: null,
      user: { id: "local-user" },
    })
  })

  it("lists entries and persists read and collection state", async () => {
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO feeds (id,url,title,subscription_count,updated_at) VALUES (?,?,?,?,?)",
    ).run("feed-1", "https://example.com/rss", "Example", 1, now)
    db.prepare(
      "INSERT INTO subscriptions (id,user_id,feed_id,view,is_private,created_at) VALUES (?,?,?,?,?,?)",
    ).run("sub-1", "local-user", "feed-1", 0, 0, now)
    db.prepare(
      "INSERT INTO entries (id,feed_id,title,content,guid,inserted_at,published_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
      "entry-1",
      "feed-1",
      "Hello",
      "<p>First sentence. Second sentence.</p>",
      "hello",
      now,
      now,
    )

    const list = await app.request("/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(await list.json()).toMatchObject({
      code: 0,
      data: [{ read: false, entries: { id: "entry-1" }, feeds: { id: "feed-1" } }],
    })

    await app.request("/reads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryIds: ["entry-1"] }),
    })
    const unread = await app.request("/reads/total-count")
    expect(await unread.json()).toEqual({ code: 0, data: { count: 0 } })

    await app.request("/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "entry-1", view: 0 }),
    })
    const collection = await app.request("/collections?entryId=entry-1")
    expect(await collection.json()).toEqual({ code: 0, data: true })

    const context = articleContext({
      parts: [{ type: "data-block", data: [{ type: "mainEntry", value: "entry-1" }] }],
    })
    expect(context).toContain("First sentence.")
    expect(
      articleContext({
        parts: [
          {
            type: "data-block",
            data: [
              { type: "mainView", value: "0" },
              { type: "unreadOnly", value: "true" },
            ],
          },
        ],
      }),
    ).toBe("[]")
    const summary = await app.request("/ai/summary?id=entry-1")
    expect(await summary.json()).toEqual({
      code: 0,
      data: "First sentence.Second sentence.",
    })
  })

  it("falls back to a compatible mirror when the WSJ feed blocks automated requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("blocked", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>WSJ 中文</title><link>https://cn.wsj.com/</link><item><title>Test article</title><link>https://cn.wsj.com/articles/test</link><guid>test</guid></item></channel></rss>`,
          { headers: { "content-type": "text/xml" } },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)
    try {
      const response = await app.request("/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://cn.wsj.com/rss-news-and-feeds/zh-hans" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        code: 0,
        feed: { title: "WSJ 中文", url: "https://plink.anyfeeder.com/wsj/cn" },
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("streams chat deltas before the provider finishes and includes selected article content", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://provider.test/v1")
    vi.stubEnv("OPENAI_API_KEY", "test")
    vi.stubEnv("OPENAI_MODEL", "test-model")
    let upstream: ReadableStreamDefaultController<Uint8Array>
    const encode = (text: string) => new TextEncoder().encode(text)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    try {
      const response = await app.request("/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              parts: [
                { type: "data-rich-text", data: { text: "Summarize this" } },
                { type: "data-block", data: [{ type: "mainEntry", value: "entry-1" }] },
              ],
            },
          ],
        }),
      })
      expect(response.status).toBe(200)
      const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
      expect(sent.stream).toBe(true)
      expect(sent.messages[0].content).toContain("First sentence.")
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      expect(decoder.decode((await reader.read()).value)).toContain('"type":"start"')
      await reader.read()
      upstream!.enqueue(encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'))
      expect(decoder.decode((await reader.read()).value)).toContain('"delta":"Hello"')
      upstream!.enqueue(encode("data: [DONE]\n\n"))
      expect(decoder.decode((await reader.read()).value)).toContain("text-end")
      expect(decoder.decode((await reader.read()).value)).toContain("finish")
      expect((await reader.read()).done).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })
})
