export interface User {
  id: string
  email: string
  name: string
  handle: string
  image: string | null
  emailVerified: boolean
  createdAt: string
  updatedAt: string
}

export interface Feed {
  id: string
  title: string | null
  url: string
  description: string | null
  image: string | null
  siteUrl: string | null
  ownerUserId: string | null
  errorAt: string | null
  errorMessage: string | null
  subscriptionCount: number
  updatesPerWeek: number | null
  latestEntryPublishedAt: string | null
}

export interface Entry {
  id: string
  feedId: string
  title: string | null
  url: string | null
  content: string | null
  description: string | null
  guid: string
  author: string | null
  insertedAt: string
  publishedAt: string
  media: unknown[] | null
  categories: string[] | null
  attachments: unknown[] | null
  extra: Record<string, unknown> | null
  language: string | null
}
