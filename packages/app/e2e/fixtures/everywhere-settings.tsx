import { MemoryRouter, Route, useLocation } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { DialogProvider } from "@vectordevai/ui/context/dialog"
import { createEffect, createSignal, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import { SettingsEverywhereV2 } from "../../src/components/settings-v2/everywhere"
import { GlobalProvider } from "../../src/context/global"
import { LanguageProvider } from "../../src/context/language"
import { PlatformProvider, type Platform } from "../../src/context/platform"
import { ProjectTrustProvider } from "../../src/context/project-trust"
import { ServerConnection, ServerProvider } from "../../src/context/server"
import { ServerSDKProvider } from "../../src/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "../../src/context/server-sync"
import { afterPaint, launchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"

const platform: Platform = {
  platform: "desktop",
  openLink() {},
  async restart() {},
  back() {},
  forward() {},
  async notify() {},
  async openDirectoryPickerDialog() {
    return null
  },
}
const sidecar = { type: "sidecar", variant: "base", http: { url: location.origin } } satisfies ServerConnection.Sidecar
const key = ServerConnection.key(sidecar)

function Fixture() {
  const sync = useServerSync()
  const route = useLocation()
  const [open, setOpen] = createSignal(false)
  // Mount the page after both initial statuses reach the normal server store.
  const statuses = () => sync().session.data.session_status
  const ready = () =>
    statuses().ses_everywhere_active?.type === "busy" && statuses().ses_everywhere_idle?.type === "idle"
  const coldStart = new URLSearchParams(location.search).has("cold")
  // Vite puts the launch screen over every page, and only NewLayout's LaunchReadyProbe lifts it. Send
  // the same ready signals for this page: its shell painted, no persisted settings, the engine and bootstrap answered.
  onMount(() => afterPaint(() => launchScreen.signal("shell")))
  launchScreen.signal("settings")
  createEffect(() => launchScreen.signal("engine", Boolean(sync().data.path.directory)))
  createEffect(() => launchScreen.signal("data", sync().ready))
  return (
    <main>
      <button type="button" disabled={!coldStart && !ready()} onClick={() => setOpen(true)}>
        Show Everywhere settings
      </button>
      <output aria-label="Fixture route">{route.pathname}</output>
      <Show when={open()}>
        <SettingsEverywhereV2 offered={false} />
      </Show>
    </main>
  )
}

render(
  () => (
    <PlatformProvider value={platform}>
      <LanguageProvider locale="en">
        <QueryClientProvider client={new QueryClient()}>
          <DialogProvider>
            <ServerProvider defaultServer={key} canonicalLocalServer={key} servers={[sidecar]}>
              <GlobalProvider>
                <ServerSDKProvider>
                  <ServerSyncProvider>
                    <ProjectTrustProvider>
                      <MemoryRouter>
                        <Route path="/*fixture" component={Fixture} />
                      </MemoryRouter>
                    </ProjectTrustProvider>
                  </ServerSyncProvider>
                </ServerSDKProvider>
              </GlobalProvider>
            </ServerProvider>
          </DialogProvider>
        </QueryClientProvider>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.querySelector<HTMLDivElement>("#root")!,
)
