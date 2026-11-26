import { onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { LocalFixView } from "../../src/features/vectorscope/local-fix-panel"
import { localFixController, localFixTransport } from "../../src/features/vectorscope/local-fix"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"

// VS-12d (SF-10b): the real fix view, controller and generated-client transport against the spec's page.route engine.
yieldLaunchScreen("app")
const params = new URLSearchParams(location.search)
const variant = params.get("variant")
const head = "a".repeat(40)
const scope = { parentID: "ses_local_fix_parent", directory: "/repo", projectID: "project" }
const client = createVectorClient({ baseUrl: `${location.origin}/fixture` })
const finding = (id, patch) => ({
  id,
  path: "src/a.ts",
  line: 2,
  side: "RIGHT",
  source: "review",
  severity: "blocking",
  category: "bug",
  title: `Finding ${id}`,
  body: "Body",
  confidence: 0.99,
  anchor: { path: "src/a.ts", side: "RIGHT", line: 2, hunk: 0 },
  suggestionAllowed: true,
  ...patch,
})
const source = {
  outcome: {
    ...(variant === "uncommitted" ? {} : { pr: 7 }),
    head,
    baseRef: "main",
    checkout: { mode: "in-place", trust: "trusted", headFiles: [], fromDiff: [] },
    authored: variant === "untrusted" ? "untrusted" : "trusted",
    label: "Reviewing your checkout",
    report: { summary: "", risk: "low", files: [], findings: [] },
    selection: {
      inline: [
        finding("f-verified", { verified: true, suggestion: "  return Math.abs(value)" }),
        finding("f-unverified", { suggestion: "  return 0" }),
      ],
      outsideDiff: [],
      elsewhere: [],
      nits: [],
      overflow: [],
      stillOpen: [],
      fixed: [],
      dismissed: [],
      reappeared: [],
      raised: [],
      dropped: [],
      risk: "low",
    },
    skipped: [],
    files: [{ path: "src/a.ts", additions: 1, deletions: 1 }],
    anchored: {},
    durationMs: 1,
    specialists: [],
    sessions: [],
    banners: [],
    notes: [],
  },
  pr: { number: 7, headRefOid: head, baseRefOid: "b".repeat(40), baseRefName: "main" },
  dismissed: new Set(),
  applied: new Set(),
}

function Panel(props) {
  const [state, setState] = createStore({ value: { fixes: [], results: [], uncertain: false, error: "" } })
  const controller = localFixController({
    scope: { identity: {}, server: "fixture", ...scope, api: localFixTransport(client, scope) },
    enabled: () => props.enabled,
    dismissed: () => source.dismissed,
    changed: (value) => setState("value", reconcile(value)),
  })
  void controller.check()
  onCleanup(() => controller.dispose())
  return <LocalFixView state={state.value} enabled={props.enabled} source={() => source} controller={controller} />
}

render(() => {
  const [state, setState] = createStore({ open: true, enabled: params.get("enabled") !== "0" })
  return (
    <div>
      <button onClick={() => setState("open", (value) => !value)}>
        {state.open ? "Close fixture panel" : "Reopen fixture panel"}
      </button>
      <button onClick={() => setState("enabled", false)}>Disable fixes</button>
      <Show when={state.open}>
        <Panel enabled={state.enabled} />
      </Show>
    </div>
  )
}, document.querySelector("#root"))
