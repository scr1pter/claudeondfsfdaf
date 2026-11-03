import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@vectordevai/ui/context"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { persisted } from "@/utils/persist"
import { afterFirstRun, mayFetch, type DesktopLocal } from "@/utils/desktop-local"
import { DialogReleaseNotes } from "@/components/dialog-release-notes"
import { fixedReportHighlight, loadReleaseHighlights } from "@/context/highlights-model"

const CHANGELOG_URL = "https://vectordev.ai/changelog.json"

type Store = {
  version?: string
}

export const { use: useHighlights, provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const dialog = useDialog()
    const settings = useSettings()
    const [store, setStore, _, ready] = persisted("highlights.v1", createStore<Store>({ version: undefined }))

    const [range, setRange] = createStore({
      from: undefined as string | undefined,
      to: undefined as string | undefined,
    })
    const state = { started: false }
    let timer: ReturnType<typeof setTimeout> | undefined

    const clearTimer = () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }

    const markSeen = () => {
      if (!platform.version) return
      setStore("version", platform.version)
    }

    const start = (previous: string) => {
      if (!settings.general.releaseNotes()) {
        markSeen()
        return
      }

      const fetcher = platform.fetch ?? fetch
      const controller = new AbortController()
      onCleanup(() => {
        controller.abort()
        clearTimer()
      })

      // Release notes come from vectordev.ai. In the desktop app, Vector Local keeps them off unless the user allows
      // them, and a first run holds them until the person has chosen how to run models, when they are read; while
      // Vector Local keeps them off the version stays unseen, so they show once they may.
      const fetched = Promise.withResolvers<DesktopLocal | undefined>()
      onCleanup(afterFirstRun(fetched.resolve))
      fetched.promise
        .then((local) => {
          if (!mayFetch(local, "release-notes") || controller.signal.aborted) return undefined
          return fetcher(CHANGELOG_URL, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          })
        })
        .then((response) => (response?.ok ? (response.json() as Promise<unknown>) : undefined))
        .then(async (json) => {
          if (!json) return
          // The reports this computer sent come from the desktop's own file, never the network (WP A33).
          const reports = (await platform.reports?.list().catch(() => undefined)) ?? []
          const fixed = fixedReportHighlight(json, reports, platform.version, previous)
          const notes = loadReleaseHighlights(json, platform.version, previous)
          const highlights = fixed ? [fixed, ...notes] : notes
          if (controller.signal.aborted) return

          if (highlights.length === 0) {
            markSeen()
            return
          }

          timer = setTimeout(() => {
            timer = undefined
            markSeen()
            dialog.show(() => <DialogReleaseNotes highlights={highlights} />)
          }, 500)
        })
        .catch(() => undefined)
    }

    createEffect(() => {
      if (state.started) return
      if (!ready()) return
      if (!settings.ready()) return
      if (!platform.version) return
      state.started = true

      const previous = store.version
      if (!previous) {
        setStore("version", platform.version)
        return
      }

      if (previous === platform.version) return

      setRange({ from: previous, to: platform.version })
      start(previous)
    })

    return {
      ready,
      from: () => range.from,
      to: () => range.to,
      get last() {
        return store.version
      },
      markSeen,
    }
  },
})
