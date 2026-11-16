import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { OPEN_PREVIEW, activityLabel, applyActivity, stopBrowser, visibleActivity } from "./activity"
import { browserAgentApi, type BrowserAgentActivity } from "./types"

/**
 * The indicator that the agent drives a browser no Preview shows: Preview closed, or a helper's browser, which no
 * Preview shows. "Show" opens Preview on the session's own browser; "Stop" closes the browser, its tabs and their
 * pages. The desktop announces every agent browser's activity to every main window; elsewhere this shows nothing.
 */
export function BrowserActivity(props: { sessionID?: string; parentOf: (sessionID: string) => string | undefined }) {
  const language = useLanguage()
  const [open, setOpen] = createSignal<ReadonlyMap<string, BrowserAgentActivity>>(new Map())
  onMount(() => {
    const remove = browserAgentApi()?.onBrowserAgentActivity?.((event) => setOpen((current) => applyActivity(current, event)))
    onCleanup(() => remove?.())
  })
  const items = createMemo(() => (props.sessionID ? visibleActivity(open(), props.sessionID, props.parentOf) : []))
  const stop = (contextId: string) => void stopBrowser(browserAgentApi(), contextId)
  return (
    <Show when={items().length > 0}>
      <div
        data-component="browser-activity"
        role="status"
        class="pointer-events-none absolute top-2 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-1"
      >
        <For each={items()}>
          {(item) => (
            <div class="pointer-events-auto flex max-w-[min(32rem,90vw)] items-center gap-2 rounded-full border border-border-weak-base bg-background-base px-3 py-1 text-12-regular text-text-base shadow-sm">
              <span
                class="size-1.5 shrink-0 rounded-full bg-icon-success-base"
                classList={{ "animate-pulse": item.activity.busy }}
              />
              <span class="shrink-0">
                {language.t(item.own ? "browser.activity.own" : "browser.activity.helper")}
              </span>
              <Show when={activityLabel(item.activity)}>
                {(label) => (
                  <span class="min-w-0 truncate text-text-weak" title={item.activity.url}>
                    {label()}
                  </span>
                )}
              </Show>
              <Show when={item.own}>
                <button
                  type="button"
                  class="shrink-0 text-text-interactive-base hover:underline"
                  onClick={() => globalThis.window?.dispatchEvent(new CustomEvent(OPEN_PREVIEW))}
                >
                  {language.t("browser.activity.show")}
                </button>
              </Show>
              <button
                type="button"
                class="shrink-0 text-text-critical-base hover:underline"
                onClick={() => stop(item.activity.contextId)}
              >
                {language.t("browser.activity.stop")}
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
