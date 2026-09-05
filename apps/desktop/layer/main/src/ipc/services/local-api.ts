import { getIpcContext, IpcMethod, IpcService } from "electron-ipc-decorator"

import { getLocalApp } from "../../lib/local-app"

interface LocalAPIRequest {
  body?: string
  headers?: Record<string, string>
  method: string
  url: string
}

interface LocalAPIResponse {
  body: string
  bodyEncoding?: "base64"
  streamId?: string
  headers: [string, string][]
  status: number
  statusText: string
}

export class LocalAPIService extends IpcService {
  static override readonly groupName = "localApi"
  private streams = new Map<
    string,
    {
      owner: number
      reader: ReadableStreamDefaultReader<Uint8Array>
      timer: ReturnType<typeof setTimeout>
    }
  >()

  @IpcMethod()
  async readStream(id: string) {
    const stream = this.streams.get(id)
    if (!stream || stream.owner !== getIpcContext().sender.id) throw new Error("Stream unavailable")
    clearTimeout(stream.timer)
    stream.timer = setTimeout(() => {
      this.streams.delete(id)
      void stream.reader.cancel().catch(() => {})
    }, 130_000)
    try {
      const result = await stream.reader.read()
      if (result.done) {
        clearTimeout(stream.timer)
        this.streams.delete(id)
      }
      return {
        done: result.done,
        data: result.value ? Buffer.from(result.value).toString("base64") : "",
      }
    } catch (error) {
      clearTimeout(stream.timer)
      this.streams.delete(id)
      throw error
    }
  }

  @IpcMethod()
  async cancelStream(id: string) {
    const stream = this.streams.get(id)
    if (!stream || stream.owner !== getIpcContext().sender.id) return
    this.streams.delete(id)
    clearTimeout(stream.timer)
    await stream.reader.cancel()
  }

  @IpcMethod()
  async fetch(payload: LocalAPIRequest): Promise<LocalAPIResponse> {
    const owner = getIpcContext().sender.id
    const localApp = await getLocalApp()
    const url = new URL(payload.url)
    const response = await localApp.request(`${url.pathname}${url.search}`, {
      body: payload.body,
      headers: payload.headers,
      method: payload.method,
    })
    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("text/event-stream") && response.body) {
      const streamId = crypto.randomUUID()
      const reader = response.body.getReader()
      const timer = setTimeout(() => {
        this.streams.delete(streamId)
        void reader.cancel().catch(() => {})
      }, 130_000)
      this.streams.set(streamId, { owner, reader, timer })
      return {
        body: "",
        streamId,
        headers: Array.from(response.headers.entries()),
        status: response.status,
        statusText: response.statusText,
      }
    }
    const isText = /json|text|xml|javascript|x-ndjson/.test(contentType)
    return {
      body: isText
        ? await response.text()
        : Buffer.from(await response.arrayBuffer()).toString("base64"),
      bodyEncoding: isText ? undefined : "base64",
      headers: Array.from(response.headers.entries()),
      status: response.status,
      statusText: response.statusText,
    }
  }
}
