import { IN_ELECTRON } from "@follow/shared/constants"
import { env } from "@follow/shared/env.desktop"
import { createDesktopAPIHeaders } from "@follow/utils/headers"
import { FollowClient } from "@follow-app/client-sdk"
import PKG from "@pkg"

import { ipcServices } from "./client"
import { getClientId, getSessionId } from "./client-session"

const isElectronRuntime = () => {
  return IN_ELECTRON || (typeof window !== "undefined" && !!window.electron)
}

export const fetchFromLocalApp = async (request: Request) => {
  if (!isElectronRuntime() || !ipcServices?.localApi) {
    return fetch(request)
  }
  const localApi = ipcServices.localApi

  const requestBody =
    request.method !== "GET" && request.method !== "HEAD" ? await request.clone().text() : undefined
  const response = await localApi.fetch({
    body: requestBody,
    headers: Object.fromEntries(request.headers.entries()),
    method: request.method,
    url: request.url,
  })

  if (response.streamId) {
    const id = response.streamId
    const cancel = () => {
      void localApi.cancelStream(id).catch(() => {})
    }
    request.signal.addEventListener("abort", cancel, { once: true })
    if (request.signal.aborted) {
      cancel()
      throw new DOMException("Aborted", "AbortError")
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await localApi.readStream(id)
          if (request.signal.aborted) throw new DOMException("Aborted", "AbortError")
          if (chunk.done) {
            request.signal.removeEventListener("abort", cancel)
            controller.close()
          } else {
            controller.enqueue(Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)))
          }
        } catch (error) {
          request.signal.removeEventListener("abort", cancel)
          cancel()
          controller.error(error)
        }
      },
      cancel() {
        request.signal.removeEventListener("abort", cancel)
        cancel()
      },
    })
    return new Response(stream, { headers: response.headers, status: response.status })
  }

  const responseBody =
    response.bodyEncoding === "base64"
      ? Uint8Array.from(atob(response.body), (character) => character.charCodeAt(0))
      : response.body

  return new Response(responseBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export const followClient = new FollowClient({
  credentials: "omit",
  timeout: 60_000,
  baseURL: env.VITE_API_URL,
  fetch: async (input, options = {}) => {
    const request = new Request(input.toString(), {
      ...options,
      cache: "no-store",
    })
    return fetchFromLocalApp(request)
  },
})

export const followApi = followClient.api
followClient.addRequestInterceptor(async (ctx) => {
  const { options } = ctx
  const headers = new Headers(options.headers)
  headers.set("X-Client-Id", getClientId())
  headers.set("X-Session-Id", getSessionId())

  const apiHeader = createDesktopAPIHeaders({ version: PKG.version })
  Object.entries(apiHeader).forEach(([key, value]) => {
    headers.set(key, value)
  })

  options.headers = Object.fromEntries(headers.entries())
  return ctx
})

followClient.addResponseInterceptor(async ({ response }) => {
  try {
    const isJSON = response.headers.get("content-type")?.includes("application/json")
    if (!isJSON) return response
    const _json = await response.clone().json()

    const isError = response.status >= 400
    if (!isError) return response
  } catch {
    // ignore
  }

  return response
})
