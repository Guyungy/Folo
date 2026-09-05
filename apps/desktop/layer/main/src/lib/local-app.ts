import { app } from "electron"
import { join } from "pathe"

let localAppPromise: Promise<typeof import("@follow/server").app> | undefined

export function getLocalApp() {
  localAppPromise ??= (async () => {
    process.env.DATABASE_PATH = join(app.getPath("userData"), "local-api.db")
    process.env.OPENAI_CONFIG_PATH = join(app.getPath("userData"), "openai.json")
    return (await import("@follow/server")).app
  })()
  return localAppPromise
}
