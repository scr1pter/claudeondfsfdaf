import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { makeEventListener } from "@solid-primitives/event-listener"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { approval, outcome, refreshes, type HeldFile } from "./prompt-trust-model"

type Status = { held: readonly string[]; files: readonly HeldFile[] }
const NONE: Status = { held: [], files: [] }

/**
 * Prompt files outside the repository (global agents, commands, skills, plugins, AGENTS.md and the prompt settings of
 * global config) that changed since the owner last approved them are held: the engine does not load them until the owner
 * approves. This says so above the workspace, lists the files, and Approve loads exactly those, as they were listed,
 * from the instance's next start: a file held or changed after the list was read is not approved unseen. Nothing shows
 * when nothing is held, or when the server does not answer (an older engine, or an invited guest).
 *
 * The hold is worked out at every instance start, and a file changed in another editor is held at the next prompt, so
 * the list is read again when the window comes back, when an instance reloads, and when the server reconnects.
 */
export function PromptTrustBanner(props: {
  client: () => VectorClient | undefined
  listen: (fn: (event: { details?: { type?: string } }) => void) => () => void
}) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [status, { refetch }] = createResource(props.client, (client) =>
    client.config.promptTrust
      .get()
      .then((result): Status => result.data ?? NONE)
      .catch(() => NONE),
  )

  // One read for a burst of focus changes and events.
  const timer: { id?: ReturnType<typeof setTimeout> } = {}
  const refresh = () => {
    if (timer.id !== undefined) return
    timer.id = setTimeout(() => {
      timer.id = undefined
      if (props.client()) void refetch()
    }, 300)
  }
  onMount(() => {
    makeEventListener(window, "focus", refresh)
    makeEventListener(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") refresh()
    })
  })
  onCleanup(
    props.listen((event) => {
      if (refreshes(event.details?.type)) refresh()
    }),
  )
  onCleanup(() => clearTimeout(timer.id))

  const approve = async () => {
    const client = props.client()
    const shown = status()?.files
    if (!client || !shown || pending()) return
    setPending(true)
    const result = await client.config.promptTrust
      .approve({ promptTrustApproval: approval(shown) })
      .then((response) => outcome(response.response.status))
      .catch(() => "failed" as const)
    setPending(false)
    if (result === "changed") showToast({ title: language.t("promptTrust.banner.changed") })
    if (result === "failed") showToast({ title: language.t("promptTrust.banner.failed") })
    await refetch()
  }

  return (
    <Show when={(status()?.held ?? []).length > 0 ? status()?.held : undefined}>
      {(files) => (
        <div
          class="flex w-full flex-col gap-1.5 border-b border-amber-400/20 bg-amber-400/[0.08] px-4 py-2 text-12-regular text-[#f4f4f5]"
          role="status"
          aria-live="polite"
          data-component="prompt-trust-banner"
        >
          <div class="flex items-center gap-3">
            <span class="font-medium">{language.t("promptTrust.banner.title")}</span>
            <span class="min-w-0 flex-1 text-white/70">
              {files().length === 1
                ? language.t("promptTrust.banner.description.one")
                : language.t("promptTrust.banner.description.other", { count: files().length })}
            </span>
            <ButtonV2 variant="ghost" size="small" onClick={() => setOpen(!open())} aria-expanded={open()}>
              {language.t("promptTrust.banner.files")}
            </ButtonV2>
            <ButtonV2 variant="contrast" size="small" disabled={pending()} onClick={approve}>
              {pending() ? language.t("promptTrust.banner.approving") : language.t("promptTrust.banner.approve")}
            </ButtonV2>
          </div>
          <Show when={open()}>
            <ul class="flex flex-col gap-0.5 font-mono text-white/70">
              <For each={files()}>{(file) => <li class="truncate select-text">{file}</li>}</For>
            </ul>
          </Show>
        </div>
      )}
    </Show>
  )
}
