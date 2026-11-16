import { Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { PlatformProvider } from "../../src/context/platform"
import { ServerConnection, ServerProvider, useServer } from "../../src/context/server"
import { ReviewMemoryConnection } from "../../src/features/vectorscope/review-memory-connected-panel"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"

yieldLaunchScreen("app")
const connections = ["first", "second"].map((name) => ({
  type: "http",
  http: { url: new URL(`/fixture/review-memory-connected/${name}`, location.origin).href },
}))
const binding = (connection) => ({
  connection: connection.http,
  client: createVectorClient({ baseUrl: connection.http.url }),
  events: createGlobalEmitter(),
})

function Fixture() {
  const server = useServer()
  const clients = new Map()
  const sdk = createMemo(() => {
    const connection = server.current
    if (!connection) throw new Error("Missing fixture server connection")
    const key = ServerConnection.key(connection)
    const existing = clients.get(key)
    if (existing) return existing
    const created = binding(connection)
    clients.set(key, created)
    return created
  })
  const query = new URLSearchParams(location.search)
  const [state, setState] = createStore({
    open: true,
    directory: "/repo",
    enabled: query.get("optin") !== "0",
    capability: query.get("capability") !== "0",
    healthy: query.get("health") !== "0",
  })
  const source = createMemo(() => {
    const current = sdk()
    return {
      identity: current,
      connection: server.current?.http,
      sdkConnection: current.connection,
      client: current.client,
      server: ServerConnection.key(server.current),
      directory: state.directory,
      enabled: state.enabled,
      capability: state.capability,
      healthy: state.healthy,
      listen: (listener) => current.events.listen((event) => listener(event.details.type)),
    }
  })
  const event = (type) => sdk().events.emit("global", { type, properties: {} })
  return (
    <>
      <div class="flex flex-wrap gap-3 p-4">
        <button onClick={() => setState("enabled", false)}>Disable global opt-in</button>
        <button onClick={() => setState("capability", false)}>Lose capability</button>
        <button onClick={() => setState("healthy", false)}>Lose health</button>
        <button
          onClick={() => {
            const connection = server.current
            if (!connection) throw new Error("Missing fixture server connection")
            // Exercise the actual ServerProvider same-key credential/store writer. Never inspect or log credentials.
            server.add({
              type: "http",
              http: { url: connection.http.url, username: "fixture-new-user", password: "fixture-only-value" },
            })
          }}
        >
          Edit connection binding
        </button>
        <button onClick={() => setState("directory", "/other")}>Change directory</button>
        <button onClick={() => server.setActive(ServerConnection.key(connections[1]))}>Replace SDK</button>
        <button onClick={() => event("server.connected")}>Reconnect engine</button>
        <button onClick={() => event("global.disposed")}>Dispose engine</button>
        <button onClick={() => setState("open", false)}>Close connected panel</button>
        <button onClick={() => setState("open", true)}>Open connected panel</button>
      </div>
      <Show when={state.open}>
        <ReviewMemoryConnection source={source} />
      </Show>
    </>
  )
}

const platform = {
  platform: "web",
  openLink: () => {},
  restart: async () => {},
  back: () => {},
  forward: () => {},
  notify: async () => {},
}
render(
  () => (
    <PlatformProvider value={platform}>
      <ServerProvider defaultServer={ServerConnection.key(connections[0])} servers={connections}>
        <Fixture />
      </ServerProvider>
    </PlatformProvider>
  ),
  document.querySelector("#root"),
)
