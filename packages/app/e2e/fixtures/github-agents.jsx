import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { Show } from "solid-js"
import { PlatformProvider } from "../../src/context/platform"
import { codiumChanged } from "../../src/vector-account"
import { GithubAgentsSetup } from "../../src/features/github-agents/setup-card"
import { GithubBindingsList } from "../../src/features/github-agents/bindings-list"
import { Automations } from "../../src/features/scheduled/automations"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"
import "../../src/vector-premium.css"

// Synthetic IPC only. These delayed replies capture the old account exactly as an in-flight main request can.
const query = new URLSearchParams(location.search)
const [state, setState] = createStore({ cwd: "/repo/one", status: undefined })
const auth = { signedIn: query.get("signedIn") !== "off", vectorSignedIn: true, owner: "owner", repositoryId: "17" }
const accountListeners = new Set()
const calls = []
const held = new Set()
const releases = {}
const notify = () =>
  [...accountListeners].forEach((listener) => listener({ authenticated: auth.vectorSignedIn, pending: false }))
const fixture = {
  calls,
  switchRepository() {
    setState("cwd", "/repo/two")
  },
  switchRemote() {
    auth.repositoryId = "19"
  },
  switchAccount() {
    auth.owner = "other"
    auth.vectorSignedIn = true
    notify()
  },
  signOut() {
    auth.vectorSignedIn = false
    notify()
  },
  codiumChanged() {
    codiumChanged()
  },
  release(name) {
    releases[name]?.()
  },
  releasePreview: undefined,
}
window.githubAgentsFixture = fixture
async function pause(name, flag) {
  if (query.get(flag) !== "1" || held.has(name)) return
  held.add(name)
  await new Promise((resolve) => {
    releases[name] = resolve
    if (name === "preview") fixture.releasePreview = resolve
  })
}
const mode = query.get("mode") === "codium" ? "codium" : "own-key"
const options = {
  mode,
  provider: "openrouter",
  model: "example",
  keys: mode === "own-key" ? ["OPENROUTER_API_KEY"] : [],
  autoReview: false,
  version: "1.99.113",
  schedules: [],
}
const listed = query.get("listed") !== "off"
const sha256 = "a".repeat(64)
const repository = (cwd) => (cwd === "/repo/one" ? auth.repositoryId : "18")
const repoName = (cwd) =>
  `${auth.owner}/${cwd === "/repo/one" ? (auth.repositoryId === "19" ? "changed" : "one") : "two"}`
const binding = (cwd) => ({
  repositoryId: repository(cwd),
  ...(query.get("rowAuthority") === "off"
    ? {}
    : { authorityId: `binding-authority-${auth.owner}-${repository(cwd)}-${auth.vectorSignedIn ? "on" : "off"}` }),
  repository: repoName(cwd),
  binder: { login: auth.owner },
  boundAt: 1,
  workflowVersion: "3",
  codium: query.get("binding") === "unavailable" || !auth.vectorSignedIn ? "unavailable" : "ready",
  ...(query.get("binding") === "suspended" ? { suspended: "transferred" } : {}),
})
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
        return { ok: true, login: auth.owner }
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
      const value = {
        repo: repoName(cwd),
        repositoryId: repository(cwd),
        authorityId: `authority-${auth.owner}-${repository(cwd)}-${auth.vectorSignedIn ? "on" : "off"}`,
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
        bound: query.get("bound") === "other" ? "not-yours-or-unknown" : "yours",
        binding: binding(cwd),
      }
      await pause("status", "pendingStatus")
      return value
    },
    async preview(input) {
      calls.push(["preview", input])
      const value = {
        path: ".github/workflows/vector.yml",
        content: `name: Vector\n# ${input.cwd} ${input.mode} ${input.model ?? ""}\n# ${auth.owner} repository ${repository(input.cwd)}`,
        secrets:
          input.mode === "codium"
            ? []
            : [
                { name: "VECTOR_CLI_TOKEN", detail: "From your free Vector account" },
                { name: "OPENROUTER_API_KEY", detail: "Your provider key" },
              ],
      }
      await pause("preview", "pending")
      return value
    },
    async setup(input) {
      calls.push(["setup", input])
      await pause("setup", "pendingSetup")
      if (query.get("failSetup") === "1") throw new Error("synthetic uncertain setup")
      return { url: "https://github.com/owner/one/pull/1" }
    },
    async bind(input) {
      calls.push(["bind", input])
      if (query.get("failBind") === "1") throw new Error("synthetic uncertain bind")
      return { state: "bound" }
    },
    async run(input) {
      calls.push(["run", input])
      await pause("run", "pendingRun")
      if (query.get("failRun") === "1") throw new Error("synthetic refusal")
      return { runUrl: "https://github.com/owner/one/actions/runs/1", dispatchedAt: Date.now() }
    },
    async schedules(input) {
      calls.push(["schedules", input])
      await pause("schedules", "pendingSchedule")
      if (query.get("failSchedule") === "1") throw new Error("synthetic uncertain schedule")
      return { url: "https://github.com/owner/one/pull/2" }
    },
    async bindings() {
      calls.push(["bindings"])
      if (!auth.vectorSignedIn) throw new Error("signed out")
      const value = [
        binding("/repo/one"),
        {
          repositoryId: "99",
          repository: "must-not-show/private",
          binder: { login: "must-not-show" },
          boundAt: 1,
          workflowVersion: "3",
          codium: "unavailable",
          suspended: "binder-left",
        },
      ]
      await pause("bindings", "pendingBindings")
      return value
    },
    async runs() {
      calls.push(["runs"])
      if (!auth.vectorSignedIn) throw new Error("signed out")
      const value = [
        {
          rid: "7",
          repositoryId: repository("/repo/one"),
          repository: repoName("/repo/one"),
          event: "workflow_dispatch",
          source: "desktop",
          purpose: "task",
          startedAt: 1000,
          endedAt: 61000,
          outcome: "completed",
        },
      ]
      await pause("runs", "pendingRuns")
      return value
    },
    async unbind(input) {
      calls.push(["unbind", input])
      await pause("unbind", "pendingUnbind")
      calls.push(["unbindReturned", input])
      if (query.get("failUnbind") === "1") throw new Error("synthetic uncertain unbind")
    },
    async previewBrain(cwd) {
      calls.push(["previewBrain", cwd])
      const value = {
        id: `preview-${cwd}${auth.owner === "owner" ? "" : "-other"}`,
        repositoryId: repository(cwd),
        publicRepository: query.get("public") === "1",
        sha256,
        bytes: 128,
        entries: 1,
        skills: 0,
        text: `{"lesson":"Inspect auth tests before editing","scope":"${auth.owner}-Brain-secret"}`,
      }
      await pause("brain", "pendingBrain")
      return value
    },
    async returnedArtifacts(input) {
      calls.push(["returnedArtifacts", input])
      return [{ artifactId: "99", name: "vector-session-7" }]
    },
    async previewReturned(input) {
      calls.push(["previewReturned", input])
      const value = {
        id: `returned-preview-${auth.owner}`,
        repositoryId: repository(input.cwd),
        rid: input.rid,
        currentPublicRepository: query.get("public") === "1",
        publicRepository: query.get("public") === "1" || query.get("publicRun") === "1",
        sha256,
        bytes: 128,
        text: `{"lesson":"Proposed draft, not active memory","scope":"${auth.owner}-returned-secret"}`,
      }
      await pause("returned", "pendingReturned")
      return value
    },
    async importReturned(input) {
      calls.push(["importReturned", input])
      return { proposed: 1, known: 0, refused: 0, over: 0 }
    },
  },
}
const platform = {
  platform: "desktop",
  openLink() {},
  async restart() {},
  back() {},
  forward() {},
  async notify() {},
  vectorAccount: {
    async status() {
      return { authenticated: auth.vectorSignedIn, pending: false }
    },
    async start() {
      return { authenticated: auth.vectorSignedIn, pending: false }
    },
    async cancel() {
      return { authenticated: auth.vectorSignedIn, pending: false }
    },
    async logout() {
      fixture.signOut()
      return { authenticated: false, pending: false }
    },
    onChange(listener) {
      accountListeners.add(listener)
      return () => accountListeners.delete(listener)
    },
  },
}
// This standalone component fixture has no app-shell startup probes, like the account/settings fixtures.
yieldLaunchScreen("app")
render(
  () => (
    <PlatformProvider value={platform}>
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
    </PlatformProvider>
  ),
  document.getElementById("root"),
)
