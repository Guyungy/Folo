import { FollowClient } from "@follow-app/client-sdk"

import { getLocalApp } from "./local-app"

export const followClient = new FollowClient({
  credentials: "omit",
  timeout: 60_000,
  baseURL: "http://local",
  fetch: async (input, options = {}) => {
    const app = await getLocalApp()
    const url = new URL(input.toString())
    return app.request(`${url.pathname}${url.search}`, options)
  },
})

export const apiClient = followClient.api
