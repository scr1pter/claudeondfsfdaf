import { onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { LocalReviewView } from "../../src/features/vectorscope/local-review-panel"
import { localReviewController, localReviewTransport } from "../../src/features/vectorscope/local-review"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"

yieldLaunchScreen("app")
const identity = {}
const client = createVectorClient({ baseUrl: `${location.origin}/fixture` })
function Panel(props) {
  const [state, setState] = createStore({ value: { runs: [], discovered: false, uncertain: false, error: "" } })
  const controller = localReviewController({
    scope: {
      identity,
      server: "fixture",
      parentID: "ses_local_app_parent",
      directory: "/repo",
      projectID: "project",
      api: localReviewTransport(client, { parentID: "ses_local_app_parent", directory: "/repo", projectID: "project" }),
    },
    enabled: () => props.enabled,
    changed: (value) => setState("value", reconcile(value)),
    requestID: () => crypto.randomUUID(),
  })
  void controller.check()
  onCleanup(() => controller.dispose())
  return <LocalReviewView state={state.value} enabled={props.enabled} controller={controller} />
}
render(() => {
  const [state, setState] = createStore({
    open: true,
    enabled: new URLSearchParams(location.search).get("enabled") !== "0",
  })
  return (
    <div>
      <button onClick={() => setState("open", (value) => !value)}>
        {state.open ? "Close fixture panel" : "Reopen fixture panel"}
      </button>
      <button onClick={() => setState("enabled", false)}>Disable new reviews</button>
      <Show when={state.open}>
        <Panel enabled={state.enabled} />
      </Show>
    </div>
  )
}, document.querySelector("#root"))
