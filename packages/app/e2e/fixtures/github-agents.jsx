import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { Show } from "solid-js"
import { GithubAgentsSetup } from "../../src/features/github-agents/setup-card"
import { GithubBindingsList } from "../../src/features/github-agents/bindings-list"
import { Automations } from "../../src/features/scheduled/automations"
import "../../src/index.css"
import "../../src/vector-premium.css"

// Synthetic IPC only. Browser acceptance runs in CI; there is no account, provider, or remote dispatch.
const query = new URLSearchParams(location.search)
const [state, setState] = createStore({
  cwd: "/repo/one",
  status: undefined,
})
const auth = { signedIn: query.get("signedIn") !== "off" }
const calls = []
const fixture = {
  calls,
  switchRepository() {
    setState("cwd", "/repo/two")
  },
  releasePreview: undefined,
}
window.githubAgentsFixture = fixture
const mode = query.get("mode") === "codium" ? "codium" : "own-key"
const options = {
  mode,
  provider: "openrouter",
  model: "example",
  keys: ["OPENROUTER_API_KEY"],
  autoReview: false,
  version: "1.99.113",
  schedules: [],
}
const listed = query.get("listed") !== "off"
const sha256 = "a".repeat(64)
window.api = {
  github: {
    auth: {
      async start(input) {
        calls.push(["authStart", input])
        return { userCode: "FAKE-CODE", verificationUri: "https://github.com/login/device", expiresIn: 600 }
      },
      async complete() {
        calls.push(["authComplete"])
        auth.signedIn = true
        return { ok: true, login: "owner" }
      },
      async cancel() {
        calls.push(["authCancel"])
      },
      async openVerification() {
        calls.push(["authOpen"])
      },
    },
  },
  githubAgents: {
    async status(cwd) {
      calls.push(["status", cwd])
      return {
        repo: cwd === "/repo/one" ? "owner/one" : "owner/two",
        repositoryId: cwd === "/repo/one" ? "17" : "18",
        defaultBranch: "main",
        publicRepository: query.get("public") === "1",
        signedIn: auth.signedIn,
        canDispatch: query.get("writer") !== "off",
        workflow: query.get("workflow") ?? "current",
        options,
        timeoutMinutes: 42,
        listed: {
          agents: listed,
          scheduled: listed && query.get("scheduled") !== "off",
          noSecret: listed && query.get("noSecret") !== "off",
          brain: listed,
        },
        bound: "yours",
      }
    },
    async preview(input) {
      calls.push(["preview", input])
      if (query.get("pending") === "1")
        await new Promise((resolve) => {
          fixture.releasePreview = resolve
        })
      return {
        path: ".github/workflows/vector.yml",
        content: `name: Vector\n# ${input.cwd} ${input.mode} ${input.model ?? ""}`,
        secrets:
          input.mode === "codium"
            ? []
            : [
                { name: "VECTOR_CLI_TOKEN", detail: "From your free Vector account" },
                { name: "OPENROUTER_API_KEY", detail: "Your provider key" },
              ],
      }
    },
    async setup(input) {
      calls.push(["setup", input])
      return { url: "https://github.com/owner/one/pull/1" }
    },
    async bind(cwd) {
      calls.push(["bind", cwd])
      return { state: "bound" }
    },
    async run(input) {
      calls.push(["run", input])
      if (query.get("failRun") === "1") throw new Error("synthetic refusal")
      return { runUrl: "https://github.com/owner/one/actions/runs/1", dispatchedAt: Date.now() }
    },
    async schedules(input) {
      calls.push(["schedules", input])
      return { url: "https://github.com/owner/one/pull/2" }
    },
    async bindings() {
      calls.push(["bindings"])
      return [
        {
          repositoryId: "17",
          repository: "must-not-show/private",
          binder: { login: "must-not-show" },
          boundAt: 1,
          workflowVersion: "3",
          codium: "unavailable",
          suspended: "binder-left",
        },
      ]
    },
    async runs() {
      calls.push(["runs"])
      return [
        {
          rid: "7",
          repositoryId: "17",
          repository: "owner/one",
          event: "workflow_dispatch",
          source: "desktop",
          purpose: "task",
          startedAt: 1000,
          endedAt: 61000,
          outcome: "completed",
        },
      ]
    },
    async unbind(repositoryId) {
      calls.push(["unbind", repositoryId])
    },
    async previewBrain(cwd) {
      calls.push(["previewBrain", cwd])
      return {
        id: `preview-${cwd}`,
        repositoryId: cwd === "/repo/one" ? "17" : "18",
        publicRepository: query.get("public") === "1",
        sha256,
        bytes: 128,
        entries: 1,
        skills: 0,
        text: '{"lesson":"Inspect auth tests before editing"}',
      }
    },
    async returnedArtifacts(input) {
      calls.push(["returnedArtifacts", input])
      return [{ artifactId: "99", name: "vector-session-7" }]
    },
    async previewReturned(input) {
      calls.push(["previewReturned", input])
      return {
        id: "returned-preview",
        repositoryId: "17",
        rid: input.rid,
        publicRepository: query.get("public") === "1",
        sha256,
        bytes: 128,
        text: '{"lesson":"Proposed draft, not active memory"}',
      }
    },
    async importReturned(input) {
      calls.push(["importReturned", input])
      return { proposed: 1, known: 0, refused: 0, over: 0 }
    },
  },
}

render(
  () => (
    <main style={{ padding: "28px", "max-width": "900px", margin: "auto" }}>
      <Show
        when={query.get("view") === "automations"}
        fallback={
          <>
            <GithubAgentsSetup
              cwd={state.cwd}
              model="openrouter/example"
              keys={["OPENROUTER_API_KEY"]}
              onStatus={(status) => setState("status", status)}
              onGithubConnected={() => calls.push(["authRefreshed"])}
            />
            <Show when={query.get("manager") === "1" && state.status}>
              {(status) => <GithubBindingsList cwd={state.cwd} status={status()} />}
            </Show>
          </>
        }
      >
        <Automations
          open
          supported
          repositories={[{ directory: "/repo/one", name: "One" }]}
          sessions={[]}
          records={[]}
          focusedRepository="/repo/one"
          onClose={() => {}}
          onCreate={async (input) => {
            calls.push(["localCreate", input])
            return true
          }}
          onTogglePause={() => {}}
          onDelete={() => {}}
        />
      </Show>
    </main>
  ),
  document.getElementById("root"),
)
