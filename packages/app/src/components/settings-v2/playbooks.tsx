import { createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@vectordevai/ui/button"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

/** Mounted only inside the owner's Workflows settings. Installing never starts the workflow. */
export function SettingsPlaybooks() {
  const sdk = useServerSDK()
  const language = useLanguage()
  const [problem, setProblem] = createSignal<string>()
  const [busy, setBusy] = createSignal<string>()
  const [entries, { refetch }] = createResource(() => sdk().client, async (client) => {
    setProblem(undefined)
    return client.experimental.playbooks.list(undefined, { throwOnError: true }).then((answer) => answer.data)
      .catch((error) => { setProblem(formatServerError(error, language.t)); return undefined })
  })
  type Entry = NonNullable<ReturnType<typeof entries>>[number]
  const install = async (entry: Entry) => {
    if (busy()) return
    setBusy(entry.name)
    setProblem(undefined)
    try {
      await sdk().client.experimental.playbooks.install({ name: entry.name, version: entry.version,
        sha256: entry.sha256, replace: entry.installed }, { throwOnError: true })
      await refetch()
    } catch (error) { setProblem(formatServerError(error, language.t)) }
    finally { setBusy(undefined) }
  }
  return <div class="flex flex-col gap-3" data-component="settings-playbooks">
    <div class="settings-v2-row-modern">
      <div class="settings-v2-row-copy">
        <div class="settings-v2-row-title">Vector Playbooks</div>
        <div class="settings-v2-row-description">Install a checked workflow in your personal configuration. Review its plan before running it with /workflow.</div>
      </div>
      <Button variant="ghost" size="small" disabled={entries.loading || Boolean(busy())} onClick={() => void refetch()}>Refresh</Button>
    </div>
    <Show when={problem()}>{(text) => <p class="settings-v2-error" role="alert">{text()}</p>}</Show>
    <Show when={!entries.loading} fallback={<p class="settings-v2-row-description">Loading Playbooks…</p>}>
      <Show when={entries()?.length} fallback={<Show when={entries() && !problem()}><p class="settings-v2-row-description">No Playbooks are listed for this account yet.</p></Show>}>
        <For each={entries()}>{(entry) => <div class="settings-v2-row-modern">
          <div class="settings-v2-row-copy">
            <div class="settings-v2-row-title">{entry.name}</div>
            <div class="settings-v2-row-description">Version {entry.version}{entry.current ? " · Installed" : entry.installed ? " · Installed file differs" : ""}</div>
          </div>
          <Button variant="ghost" size="small" disabled={Boolean(busy()) || entry.current} onClick={() => void install(entry)}>
            {busy() === entry.name ? "Installing…" : entry.current ? "Installed" : entry.installed ? "Replace personal file" : "Install"}
          </Button>
        </div>}</For>
      </Show>
    </Show>
  </div>
}
