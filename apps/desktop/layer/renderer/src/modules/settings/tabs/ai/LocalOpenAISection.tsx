import { Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { ipcServices } from "~/lib/client"

interface OpenAIConfig {
  baseURL: string
  apiKey: string
  model: string
  speechModel?: string
  transcriptionModel?: string
}

interface APIResponse<T> {
  code: number
  data?: T
  message?: string
}

const emptyConfig: OpenAIConfig = {
  baseURL: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  speechModel: "tts-1",
  transcriptionModel: "whisper-1",
}

const request = async <T,>(path: string, method = "GET", body?: OpenAIConfig) => {
  if (!ipcServices?.localApi) throw new Error("Local settings require the desktop app")
  const response = await ipcServices.localApi.fetch({
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "content-type": "application/json" } : undefined,
    method,
    url: `http://local${path}`,
  })
  const payload = JSON.parse(response.body) as APIResponse<T>
  if (response.status >= 400)
    throw new Error(payload.message || `Request failed (${response.status})`)
  return payload.data
}

export const LocalOpenAISection = () => {
  const { t } = useTranslation("ai")
  const [config, setConfig] = useState<OpenAIConfig>(emptyConfig)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)

  useEffect(() => {
    request<Partial<OpenAIConfig>>("/settings/openai")
      .then((saved) => setConfig({ ...emptyConfig, ...saved }))
      .catch((error: Error) => toast.error(error.message))
      .finally(() => setIsLoading(false))
  }, [])

  const isComplete = Boolean(config.baseURL.trim() && config.apiKey.trim() && config.model.trim())

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await request<{ saved: boolean }>("/settings/openai", "PUT", config)
      toast.success(t("local_openai.saved"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("local_openai.save_failed"))
    } finally {
      setIsSaving(false)
    }
  }

  const handleTest = async () => {
    setIsTesting(true)
    try {
      await request<{ connected: boolean }>("/settings/openai/test", "POST", config)
      toast.success(t("local_openai.test_success"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("local_openai.test_failed"))
    } finally {
      setIsTesting(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-text-secondary">{t("local_openai.description")}</p>
      <div className="space-y-2">
        <Label htmlFor="local-openai-base-url">{t("local_openai.base_url")}</Label>
        <Input
          id="local-openai-base-url"
          type="url"
          disabled={isLoading}
          value={config.baseURL}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => setConfig({ ...config, baseURL: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="local-openai-api-key">{t("local_openai.api_key")}</Label>
        <Input
          id="local-openai-api-key"
          type="password"
          autoComplete="off"
          disabled={isLoading}
          value={config.apiKey}
          placeholder="sk-..."
          onChange={(event) => setConfig({ ...config, apiKey: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="local-openai-model">{t("local_openai.model")}</Label>
        <Input
          id="local-openai-model"
          disabled={isLoading}
          value={config.model}
          placeholder={t("local_openai.model_placeholder")}
          onChange={(event) => setConfig({ ...config, model: event.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="local-openai-speech-model">{t("local_openai.speech_model")}</Label>
          <Input
            id="local-openai-speech-model"
            disabled={isLoading}
            value={config.speechModel}
            placeholder="tts-1"
            onChange={(event) => setConfig({ ...config, speechModel: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="local-openai-transcription-model">
            {t("local_openai.transcription_model")}
          </Label>
          <Input
            id="local-openai-transcription-model"
            disabled={isLoading}
            value={config.transcriptionModel}
            placeholder="whisper-1"
            onChange={(event) => setConfig({ ...config, transcriptionModel: event.target.value })}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={!isComplete || isTesting} onClick={handleTest}>
          {isTesting ? t("local_openai.testing") : t("local_openai.test")}
        </Button>
        <Button disabled={!isComplete || isSaving} onClick={handleSave}>
          {isSaving ? t("local_openai.saving") : t("local_openai.save")}
        </Button>
      </div>
      <div className="flex items-start gap-2 rounded-lg bg-fill-secondary p-3 text-xs text-text-secondary">
        <i className="i-mgc-shield-cute-re mt-0.5 size-4 shrink-0 text-green" />
        <span>{t("local_openai.security")}</span>
      </div>
    </div>
  )
}
