import { db } from "./db.js"

type Block = { type?: string; value?: string; disabled?: boolean }

export function articleContext(message: Record<string, unknown>): string {
  if (!Array.isArray(message.parts)) return ""
  const blocks: Block[] = message.parts.flatMap((part: unknown) => {
    if (!part || typeof part !== "object") return []
    const p = part as { type?: string; data?: unknown }
    return p.type === "data-block" && Array.isArray(p.data)
      ? p.data.filter((b): b is Block => !!b && typeof b === "object" && !b.disabled)
      : []
  })
  const selectedEntry = blocks.find((b) => b.type === "mainEntry")?.value
  const feedIds = blocks
    .find((b) => b.type === "mainFeed")
    ?.value?.split(",")
    .filter(Boolean)
  const view = blocks.find((b) => b.type === "mainView")?.value
  const unread = blocks.find((b) => b.type === "unreadOnly")?.value === "true"
  if (!selectedEntry && !feedIds?.length && view === undefined) return ""
  const clauses = ["s.user_id = ?"]
  const params: (string | number)[] = ["local-user"]
  if (selectedEntry) {
    clauses.push("e.id = ?")
    params.push(selectedEntry)
  } else {
    if (feedIds?.length) {
      clauses.push(`e.feed_id IN (${feedIds.map(() => "?").join(",")})`)
      params.push(...feedIds)
    }
    if (view !== undefined && /^\d+$/.test(view)) {
      clauses.push("s.view = ?")
      params.push(Number(view))
    }
    if (unread) clauses.push("r.entry_id IS NULL")
  }
  const rows = db
    .prepare(
      `
    SELECT e.id,e.title,e.url,e.content,e.description FROM entries e
    JOIN subscriptions s ON s.feed_id=e.feed_id
    LEFT JOIN reads r ON r.entry_id=e.id AND r.user_id=s.user_id
    WHERE ${clauses.join(" AND ")} ORDER BY e.published_at DESC LIMIT 30
  `,
    )
    .all(...params) as {
    id: string
    title: string
    url: string
    content: string
    description: string
  }[]
  return JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      content: (row.content || row.description || "").slice(0, selectedEntry ? 60_000 : 6_000),
    })),
  ).slice(0, 100_000)
}
