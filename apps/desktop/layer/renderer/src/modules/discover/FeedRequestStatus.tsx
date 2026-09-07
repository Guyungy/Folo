import { Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { ipcServices } from "~/lib/client"

export function FeedRequestStatus({
  url,
  loading,
  error,
  retry,
}: {
  url?: string
  loading: boolean
  error?: Error | null
  retry: () => void
}) {
  const { t } = useTranslation()
  const [baseURL, setBaseURL] = useState("")
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const isRSSHub = url?.startsWith("rsshub://")
  useEffect(() => {
    if (!isRSSHub || !ipcServices?.localApi) return
    void ipcServices.localApi
      .fetch({ url: "http://local/settings/rsshub", method: "GET" })
      .then((response) => {
        const payload = JSON.parse(response.body)
        if (response.status >= 400) throw new Error(payload.message)
        setBaseURL(payload.data.baseURL)
      })
      .catch((error: Error) => setMessage(error.message))
  }, [isRSSHub])
  const save = async () => {
    setSaving(true)
    setMessage("")
    try {
      if (!ipcServices?.localApi) throw new Error("RSSHub settings require the desktop app")
      const response = await ipcServices.localApi.fetch({
        url: "http://local/settings/rsshub",
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseURL }),
      })
      if (response.status >= 400) throw new Error(JSON.parse(response.body).message)
      retry()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex w-full flex-col gap-3 p-4 text-sm" role="status">
      <p>{t(loading ? "feed_request.waiting" : "feed_form.error_fetching_feed")}</p>
      {error && <p className="break-words text-red">{error.message}</p>}
      {isRSSHub && (
        <>
          <label htmlFor="feed-rsshub-instance">{t("feed_request.instance")}</label>
          <Input
            id="feed-rsshub-instance"
            type="url"
            value={baseURL}
            disabled={loading || saving}
            onChange={(event) => setBaseURL(event.target.value)}
          />
          <p className="text-text-secondary">{t("feed_request.instance_help")}</p>
          <Button disabled={loading || saving || !baseURL.trim()} onClick={save}>
            {t("feed_request.save_retry")}
          </Button>
        </>
      )}
      {message && <p className="break-words text-red">{message}</p>}
      {!loading && (
        <Button disabled={saving} onClick={retry}>
          {t("retry", { ns: "common" })}
        </Button>
      )}
    </div>
  )
}
