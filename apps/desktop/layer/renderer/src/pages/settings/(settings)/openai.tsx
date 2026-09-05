import { LocalOpenAISection } from "~/modules/settings/tabs/ai/LocalOpenAISection"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const priority = (1000 << 1) + 16

export const handle = defineSettingPageData({
  icon: "i-mgc-key-2-cute-re",
  name: "titles.openai",
  priority,
})

export function Component() {
  return (
    <>
      <SettingsTitle />
      <div className="mt-6">
        <LocalOpenAISection />
      </div>
    </>
  )
}
