import { createMemo, createResource } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import { selectedShellOption, shellSelectOptions, type ShellOption, type ShellSelectOption } from "./shell-model"

/**
 * The Terminal Shell picker's state, shared by Settings > General and the legacy settings dialog. It lists the shells
 * the connected server has and saves the choice as `shell` in its global config.
 */
export function useShellPicker() {
  const language = useLanguage()
  const serverSync = useServerSync()
  const serverSdk = useServerSDK()

  const [shells] = createResource(
    () =>
      serverSdk()
        .client.pty.shells()
        .then((res) => (Array.isArray(res.data) ? res.data : []))
        .catch(() => [] as ShellOption[]),
    { initialValue: [] as ShellOption[] },
  )

  const current = createMemo(() => serverSync().data.config.shell ?? "")
  const options = createMemo(() =>
    shellSelectOptions({
      shells: shells.latest,
      current: serverSync().data.config.shell,
      auto: language.t("settings.general.row.shell.autoDefault"),
      terminalOnly: language.t("settings.general.row.shell.terminalOnly"),
    }),
  )
  const selected = createMemo(() => selectedShellOption(options(), current()))

  const select = (option: ShellSelectOption | null | undefined) => {
    if (!option) return
    if (option.value === current()) return
    void serverSync()
      .updateConfig({ shell: option.value })
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: "Could not save the terminal shell",
          description: formatServerError(error, language.t),
        }),
      )
  }

  return { options, selected, select }
}
