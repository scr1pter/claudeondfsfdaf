import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { Option, Schema } from "effect"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import { ReviewMemoryPanel } from "../../src/features/vectorscope/review-memory-panel"
import { ReviewMemoryRequestError } from "../../src/features/vectorscope/review-memory"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"

yieldLaunchScreen("app")
const listeners = new Set()
const events = {
  listen: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
const retire = () => {
  for (const listener of listeners) listener()
}
const failures = Schema.Struct({
  code: Schema.Literals([
    "denied",
    "unavailable",
    "invalid",
    "limit",
    "stale",
    "used",
    "expired",
    "disabled",
    "not-found",
    "source-unavailable",
  ]),
})

render(() => {
  const query = new URLSearchParams(location.search)
  const [state, setState] = createStore({
    open: true,
    identity: {},
    server: "fixture-engine",
    directory: "/repo",
    epoch: 0,
    owner: query.get("owner") === "guest" ? "guest" : "owner",
    connected: true,
    capability: query.get("capability") !== "0",
  })
  const response = async (method, route, body, signal, schema) => {
    const result = await fetch(`/fixture/review-memory${route}`, {
      method,
      headers: { "content-type": "application/json", "x-fixture-directory": state.directory },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    })
    if (!result.ok) {
      const decoded = Schema.decodeUnknownOption(failures)(await result.json())
      throw new ReviewMemoryRequestError(Option.isSome(decoded) ? decoded.value.code : "unavailable")
    }
    const value = await result.json()
    return schema ? Schema.decodeUnknownSync(schema)(value) : undefined
  }
  // Fixture-only transport. Production binds the canonical interface to the
  // normal generated client; no product HTTP adapter or credential is copied.
  const api = {
    inspect: (input, signal) =>
      response(
        "GET",
        `?offset=${input.offset ?? 0}&limit=${input.limit ?? 50}`,
        undefined,
        signal,
        ReviewMemoryControl.Inspect,
      ),
    prepare: (input, signal) => response("POST", "/prepare", input, signal, ReviewMemoryControl.Preview),
    confirm: (input, signal) => response("POST", "/confirm", input, signal, ReviewMemoryControl.ConfirmationResult),
    discard: (id, signal) => response("DELETE", `/previews/${encodeURIComponent(id)}`, undefined, signal),
  }
  const change = (patch) => {
    retire()
    setState({ owner: "unknown", ...patch })
  }
  return (
    <>
      <div class="flex flex-wrap gap-3 p-4">
        <button onClick={() => setState("open", (value) => !value)}>
          {state.open ? "Close fixture panel" : "Reopen fixture panel"}
        </button>
        <button onClick={() => change({ owner: "guest" })}>Guest connection</button>
        <button
          onClick={() => {
            change({ owner: "owner", connected: true })
            setState("epoch", (value) => value + 1)
          }}
        >
          Fresh owner connection
        </button>
        <button onClick={() => change({ owner: "unknown" })}>Retire same SDK</button>
        <button onClick={() => change({ directory: "/other" })}>Navigate repository</button>
        <button onClick={() => change({ connected: false })}>Disconnect engine</button>
        <button onClick={() => change({ capability: false })}>Missing capability</button>
      </div>
      <Show when={state.open}>
        <ReviewMemoryPanel
          selection={{
            identity: state.identity,
            server: state.server,
            directory: state.directory,
            epoch: state.epoch,
            owner: state.owner,
            connected: state.connected,
            capability: state.capability,
            api,
          }}
          events={events}
        />
      </Show>
    </>
  )
}, document.querySelector("#root"))
