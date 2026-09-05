import { mkdir, readFile, writeFile } from "node:fs/promises"

import { dirname } from "pathe"

export interface OpenAIConfig {
  apiKey: string
  baseURL: string
  model: string
  speechModel?: string
  transcriptionModel?: string
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[]
}

export const readOpenAIConfig = async (): Promise<Partial<OpenAIConfig>> => {
  if (!process.env.OPENAI_CONFIG_PATH) return {}
  try {
    return JSON.parse(
      await readFile(process.env.OPENAI_CONFIG_PATH, "utf8"),
    ) as Partial<OpenAIConfig>
  } catch {
    return {}
  }
}

export const writeOpenAIConfig = async (config: OpenAIConfig) => {
  if (!process.env.OPENAI_CONFIG_PATH) throw new Error("OpenAI config path is unavailable")
  await mkdir(dirname(process.env.OPENAI_CONFIG_PATH), { recursive: true })
  await writeFile(process.env.OPENAI_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
}

const readConfig = async (): Promise<OpenAIConfig | null> => {
  let fileConfig: Partial<OpenAIConfig> = {}
  fileConfig = await readOpenAIConfig()
  const apiKey = process.env.OPENAI_API_KEY ?? fileConfig.apiKey
  const baseURL = process.env.OPENAI_BASE_URL ?? fileConfig.baseURL
  const model = process.env.OPENAI_MODEL ?? fileConfig.model
  return apiKey && baseURL && model
    ? {
        apiKey,
        baseURL,
        model,
        speechModel: fileConfig.speechModel,
        transcriptionModel: fileConfig.transcriptionModel,
      }
    : null
}

const requireConfig = async () => {
  const config = await readConfig()
  if (!config) throw new Error("OpenAI-compatible API is not configured")
  return config
}

export const requestCompletion = async (
  config: OpenAIConfig,
  messages: { role: string; content: string }[],
) => {
  const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: config.model, messages, temperature: 0.2 }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`OpenAI-compatible API returned ${response.status}`)
  const result = (await response.json()) as ChatCompletionResponse
  return result.choices?.[0]?.message?.content?.trim() || null
}

export const complete = async (messages: { role: string; content: string }[]) => {
  const config = await requireConfig()
  return requestCompletion(config, messages)
}

export async function streamCompletion(messages: { role: string; content: string }[]) {
  const config = await requireConfig()
  const abort = new AbortController()
  const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: config.model, messages, stream: true }),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
  })
  if (!response.ok || !response.body) {
    abort.abort()
    throw new Error(`Chat API returned ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let finished = false
  const event = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(event({ type: "start" }))
      controller.enqueue(event({ type: "text-start", id: "local-text" }))
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split(/\r?\n/)
        buffer = done ? "" : lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const data = line.slice(5).trim()
          if (data === "[DONE]") {
            finished = true
            break
          }
          if (!data) continue
          const chunk = JSON.parse(data) as {
            error?: { message?: string }
            choices?: { delta?: { content?: string } }[]
          }
          if (chunk.error) throw new Error(chunk.error.message || "Chat stream failed")
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) controller.enqueue(event({ type: "text-delta", id: "local-text", delta }))
        }
        if (done || finished) {
          controller.enqueue(event({ type: "text-end", id: "local-text" }))
          controller.enqueue(event({ type: "finish", finishReason: "stop" }))
          controller.close()
          await reader.cancel()
          abort.abort()
        }
      } catch (error) {
        controller.enqueue(
          event({
            type: "error",
            errorText: error instanceof Error ? error.message : "Chat failed",
          }),
        )
        controller.close()
        abort.abort()
      }
    },
    async cancel() {
      abort.abort()
      await reader.cancel()
    },
  })
}

export const synthesizeSpeech = async (text: string, voice?: string) => {
  const config = await requireConfig()
  const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.speechModel || "tts-1",
      input: text,
      voice: voice && /^[\w-]+$/.test(voice) ? voice : "alloy",
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Speech API returned ${response.status}`)
  return response
}

export const transcribeAudio = async (url: string) => {
  const config = await requireConfig()
  const audioResponse = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!audioResponse.ok) throw new Error(`Unable to download audio (${audioResponse.status})`)
  const form = new FormData()
  form.append("file", await audioResponse.blob(), "audio.mp3")
  form.append("model", config.transcriptionModel || "whisper-1")
  form.append("response_format", "srt")
  const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok) throw new Error(`Transcription API returned ${response.status}`)
  return response.text()
}

export const testOpenAIConfig = async (config: OpenAIConfig) => {
  const result = await requestCompletion(config, [
    { role: "user", content: "Reply with exactly: OK" },
  ])
  if (!result) throw new Error("The API returned an empty response")
  return result
}

export const generateSummary = async (
  content: string,
  language: string | undefined,
): Promise<string | null> => {
  const config = await readConfig()
  if (!config) return null

  return requestCompletion(config, [
    {
      role: "system",
      content: `Summarize the article accurately and concisely in ${language || "the article's language"}. Return only the summary.`,
    },
    { role: "user", content: content.slice(0, 60_000) },
  ])
}

export const generateTitle = async (messages: { role: string; content: string }[]) => {
  return complete([
    {
      role: "system",
      content:
        "Create a concise title for this conversation. Use the conversation language and return only the title, no quotes. Keep it under 30 characters when practical.",
    },
    ...messages,
  ])
}

export const translateFields = async (
  fields: Record<string, string>,
  language: string,
): Promise<Record<string, string>> => {
  const fieldNames = Object.keys(fields)
  if (fieldNames.length === 0) return {}
  const result = await complete([
    {
      role: "system",
      content: `Translate every JSON string value into ${language}. Preserve HTML/Markdown structure. Return only a valid JSON object with exactly these keys: ${fieldNames.join(", ")}.`,
    },
    { role: "user", content: JSON.stringify(fields) },
  ])
  if (!result) return {}
  const normalized = result.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const parsed = JSON.parse(normalized) as Record<string, unknown>
  return Object.fromEntries(
    fieldNames.flatMap((field) =>
      typeof parsed[field] === "string" ? [[field, parsed[field] as string]] : [],
    ),
  )
}
