import { MemoryRouter, Route } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import { DialogProvider } from "@vectordevai/ui/context/dialog"
import { render } from "solid-js/web"
import { SettingsEverywhereV2 } from "../../src/components/settings-v2/everywhere"
import { GlobalProvider } from "../../src/context/global"
import { LanguageProvider } from "../../src/context/language"
import { PlatformProvider, type Platform } from "../../src/context/platform"
import { ProjectTrustProvider } from "../../src/context/project-trust"
import { ServerConnection, ServerProvider } from "../../src/context/server"
import { ServerSDKProvider } from "../../src/context/server-sdk"
import { ServerSyncProvider } from "../../src/context/server-sync"
import "../../src/index.css"

const database = { writes: [] as EverywherePreferenceWire.Update[] }
Object.assign(window, { everywherePreferenceFixture: database })
let snapshot: EverywherePreferenceWire.Snapshot = { revision: 0, everywhere: {}, locked: [] }
const listeners = new Set<() => void>()
const platform: Platform = {
  platform: "desktop",
  openLink() {},
  async restart() {},
  back() {},
  forward() {},
  async notify() {},
  async openDirectoryPickerDialog() {
    return "/vector/other"
  },
  everywherePreferences: {
    async read() {
      return { version: 1, kind: "ready", snapshot }
    },
    async update(request) {
      database.writes.push(request)
      if (database.writes.length === 1) return { version: 1, kind: "cancelled" }
      if (request.revision !== snapshot.revision) return { version: 1, kind: "stale" }
      snapshot = { revision: snapshot.revision + 1, everywhere: request.settings, locked: [] }
      listeners.forEach((listener) => listener())
      return { version: 1, kind: "ready", snapshot }
    },
    onChange(callback) {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
  },
}
const sidecar = { type: "sidecar", variant: "base", http: { url: location.origin } } satisfies ServerConnection.Sidecar
const key = ServerConnection.key(sidecar)

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
                        <Route path="/*fixture" component={() => <SettingsEverywhereV2 offered />} />
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
