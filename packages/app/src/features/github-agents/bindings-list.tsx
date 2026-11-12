import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { agentsApi, type AgentBinding, type AgentRun, type AgentsStatus, type ReturnedPreview } from "./agents-model"
import { useAgentsAuthority } from "./use-authority"

export function GithubBindingsList(props: { cwd?: string; status: AgentsStatus }) {
  const [state, setState] = createStore<{
    bindings: AgentBinding[]
    runs: AgentRun[]
    loading: boolean
    busy: boolean
    error?: string
    revision: number
    confirm?: string
    artifacts?: { artifactId: string; name: string; expiresAt?: string }[]
    selectedRun?: string
    preview?: ReturnedPreview
    approved?: string
    result?: string
    retired: boolean
  }>({ bindings: [], runs: [], loading: true, busy: false, revision: 0, retired: false })
  let revision = 0
  useAgentsAuthority(() => {
    revision += 1
    setState({
      bindings: [],
      runs: [],
      loading: false,
      busy: false,
      error: undefined,
      confirm: undefined,
      artifacts: undefined,
      selectedRun: undefined,
      preview: undefined,
      approved: undefined,
      result: undefined,
      retired: true,
    })
  })
  onCleanup(() => {
    revision += 1
  })
  createEffect(() => {
    props.cwd
    props.status.repositoryId
    props.status.authorityId
    props.status.publicRepository
    const listed = !state.retired && props.status.listed.agents && props.status.options?.mode === "codium"
    state.revision
    const token = ++revision
    const api = agentsApi()
    setState({
      bindings: [],
      runs: [],
      loading: !!api && listed,
      error: undefined,
      confirm: undefined,
      preview: undefined,
      approved: undefined,
      artifacts: undefined,
      selectedRun: undefined,
      result: undefined,
      busy: false,
    })
    if (!api || !listed) return
    void Promise.all([api.bindings(), api.runs()])
      .then(([bindings, runs]) => {
        if (revision === token) setState({ bindings, runs, loading: false })
      })
      .catch(() => {
        if (revision === token)
          setState({ loading: false, error: "Could not load GitHub bindings and runs. Try again." })
      })
  })
  const unbind = async (repositoryId: string) => {
    const api = agentsApi()
    if (!api || state.busy || state.confirm !== repositoryId) return
    const token = ++revision
    setState({ busy: true, error: undefined })
    await api
      .unbind(repositoryId)
      .then(() => {
        if (revision === token) setState("revision", (value) => value + 1)
      })
      .catch(() => {
        if (revision === token) setState("error", "Could not unbind the repository. Check your account and try again.")
      })
    if (revision === token) setState("busy", false)
  }
  const artifacts = async (rid: string) => {
    const api = agentsApi()
    if (!api || !props.cwd || state.busy || props.status.options?.mode !== "codium") return
    const token = ++revision
    setState({
      busy: true,
      error: undefined,
      preview: undefined,
      approved: undefined,
      artifacts: undefined,
      selectedRun: rid,
      result: undefined,
    })
    await api
      .returnedArtifacts({ cwd: props.cwd, rid })
      .then((value) => {
        if (revision === token) setState("artifacts", value)
      })
      .catch(() => {
        if (revision === token)
          setState("error", "Could not list returned results. They may have expired or access may have changed.")
      })
    if (revision === token) setState("busy", false)
  }
  const preview = async (artifactId: string) => {
    const api = agentsApi()
    if (!api || !props.cwd || !state.selectedRun || state.busy) return
    const token = ++revision
    setState({ busy: true, error: undefined, preview: undefined, approved: undefined })
    await api
      .previewReturned({ cwd: props.cwd, rid: state.selectedRun, artifactId })
      .then((value) => {
        if (
          revision === token &&
          value.repositoryId === props.status.repositoryId &&
          value.rid === state.selectedRun &&
          value.publicRepository === props.status.publicRepository
        )
          setState("preview", value)
      })
      .catch(() => {
        if (revision === token)
          setState("error", "Could not preview returned Brain proposals. No proposals have been imported.")
      })
    if (revision === token) setState("busy", false)
  }
  const importProposals = async () => {
    const api = agentsApi()
    const value = state.preview
    if (
      !api ||
      !value ||
      state.busy ||
      state.approved !== value.sha256 ||
      value.repositoryId !== props.status.repositoryId ||
      value.publicRepository !== props.status.publicRepository
    )
      return
    const token = ++revision
    setState({ busy: true, error: undefined })
    await api
      .importReturned({ previewId: value.id, approvedSha256: value.sha256 })
      .then((result) => {
        if (revision === token)
          setState({
            result: `${result.proposed} proposals queued for review; ${result.known} already known, ${result.refused} refused, ${result.over} over the limit. Nothing was applied automatically.`,
            preview: undefined,
            approved: undefined,
          })
      })
      .catch(() => {
        if (revision === token) setState("error", "Could not import proposals. Preview them again before retrying.")
      })
    if (revision === token) setState({ busy: false, approved: undefined })
  }
  return (
    <Show when={!state.retired && props.status.listed.agents && props.status.options?.mode === "codium"}>
      <div class="github-agents">
        <section class="github-agents-grid">
          <h3>Repository bindings</h3>
          <p>Anyone with write access to a bound repository can start runs that use your plan.</p>
          <Show when={state.loading}>
            <p role="status">Loading bindings and runs…</p>
          </Show>
          <For each={state.bindings}>
            {(binding) => (
              <article>
                <strong>
                  {binding.suspended === "binder-left"
                    ? "Repository access changed"
                    : (binding.repository ?? "Bound repository")}
                </strong>
                <p>
                  <Show when={binding.suspended !== "binder-left" && binding.binder}>
                    Bound by {binding.binder?.login} ·{" "}
                  </Show>
                  Last use: {binding.lastUsedAt ? new Date(binding.lastUsedAt).toLocaleString() : "Not used yet"} ·
                  Codium {binding.codium === "ready" && !binding.suspended ? "ready" : "unavailable"}
                </p>
                <Show
                  when={state.confirm === binding.repositoryId}
                  fallback={
                    <button
                      type="button"
                      disabled={state.busy}
                      onClick={() => setState("confirm", binding.repositoryId)}
                    >
                      Unbind
                    </button>
                  }
                >
                  <p>Stop new runs from using this binding?</p>
                  <button type="button" disabled={state.busy} onClick={() => void unbind(binding.repositoryId)}>
                    Confirm unbind
                  </button>{" "}
                  <button type="button" disabled={state.busy} onClick={() => setState("confirm", undefined)}>
                    Keep binding
                  </button>
                </Show>
              </article>
            )}
          </For>
          <Show when={!state.loading && !state.bindings.length}>
            <p>No repository bindings.</p>
          </Show>
        </section>
        <section class="github-agents-grid">
          <h3>Recent runs</h3>
          <For each={state.runs}>
            {(run) => (
              <article>
                <strong>{run.repository ?? "Repository"}</strong>
                <p>
                  {new Date(run.startedAt).toLocaleString()} ·{" "}
                  {run.endedAt
                    ? `${Math.max(0, Math.round((run.endedAt - run.startedAt) / 60000))} minutes`
                    : "In progress"}{" "}
                  · {run.outcome ?? "Pending"}
                </p>
                <Show when={run.runUrl}>
                  <a href={run.runUrl} target="_blank" rel="noopener noreferrer">
                    Open run
                  </a>
                </Show>
                <Show
                  when={
                    props.cwd &&
                    props.status.listed.brain &&
                    props.status.options?.mode === "codium" &&
                    run.repositoryId === props.status.repositoryId &&
                    run.endedAt
                  }
                >
                  <button type="button" disabled={state.busy} onClick={() => void artifacts(run.rid)}>
                    Find returned Brain proposals
                  </button>
                </Show>
              </article>
            )}
          </For>
          <Show when={!state.loading && !state.runs.length}>
            <p>No runs yet.</p>
          </Show>
        </section>
        <Show when={state.artifacts}>
          <section class="github-agents-grid">
            <h3>Returned results</h3>
            <For each={state.artifacts}>
              {(artifact) => (
                <button type="button" disabled={state.busy} onClick={() => void preview(artifact.artifactId)}>
                  Preview {artifact.name}
                </button>
              )}
            </For>
            <Show when={!state.artifacts?.length}>
              <p>No available result artifacts.</p>
            </Show>
          </section>
        </Show>
        <Show when={state.preview}>
          {(value) => (
            <section class="github-agents-grid">
              <h3>Review returned Brain proposals</h3>
              <pre aria-label="Returned Brain preview">{value().text}</pre>
              <p>
                Digest: <code>{value().sha256}</code> · {value().bytes} bytes
              </p>
              <label class="github-agents-check">
                <input
                  type="checkbox"
                  checked={state.approved === value().sha256}
                  disabled={state.busy}
                  onChange={(event) => setState("approved", event.currentTarget.checked ? value().sha256 : undefined)}
                />
                Queue this exact content as proposals for this repository. Review is required before applying it.
              </label>
              <button
                type="button"
                disabled={state.busy || state.approved !== value().sha256}
                onClick={() => void importProposals()}
              >
                Import as proposals
              </button>
            </section>
          )}
        </Show>
        <Show when={state.result}>
          <p role="status">{state.result}</p>
        </Show>
        <Show when={state.error}>
          <p role="alert">{state.error}</p>
        </Show>
        <button
          type="button"
          disabled={state.busy || state.loading}
          onClick={() => setState("revision", (value) => value + 1)}
        >
          Refresh bindings and runs
        </button>
      </div>
    </Show>
  )
}
