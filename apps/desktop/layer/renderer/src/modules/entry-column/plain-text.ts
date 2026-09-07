import { parseHtml } from "@follow/utils/html"

export const entryHtmlToPlainText = (value: string | null | undefined) =>
  value ? parseHtml(value, { noMedia: true }).toText().replaceAll(/\s+/g, " ").trim() : value
