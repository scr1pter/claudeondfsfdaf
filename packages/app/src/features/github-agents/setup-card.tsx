import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { GithubDeviceSignIn } from "@/components/github-connect"
import {
  ACTIONS_COPY,
  agentHandle,
  agentsApi,
  agentsView,
  type AgentsStatus,
  type AgentSetupPreview,
} from "./agents-model"
import { GithubRunDialog } from "./run-dialog"
import { useAgentsStatus } from "./use-status"
import "./github-agents.css"

export function GithubAgentsSetup(props: {
  cwd?: string
  model?: string
  keys?: string[]
  onStatus?: (status: AgentsStatus | undefined) => void
  onGithubConnected?: () => void
}) {
  const [state, setState] = createStore<{
    mode: "own-key" | "codium"
    model: string
    keys: string
    autoReview: boolean
    share: boolean
    preview?: AgentSetupPreview
    previewKey?: string
    opened?: string
    error?: string
    busy: boolean
    operationId: string
    bindOperationId: string
    signingIn: boolean
    run: boolean
  }>({
    mode: "own-key",
    model: props.model ?? "",
    keys: props.keys?.join(", ") ?? "",
    autoReview: false,
    share: false,
    busy: false,
    operationId: crypto.randomUUID(),
    bindOperationId: crypto.randomUUID(),
    signingIn: false,
    run: false,
  })
  let revision = 0
  const status = useAgentsStatus(
    () => props.cwd,
    () => {
      revision += 1
      setState({
        preview: undefined,
        previewKey: undefined,
        opened: undefined,
        error: undefined,
        busy: false,
        signingIn: false,
        run: false,
      })
      props.onStatus?.(undefined)
    },
  )
  const view = createMemo(() => agentsView(status.state.status))
  const input = createMemo(() => ({
    cwd: props.cwd ?? "",
    mode: state.mode,
    ...(state.mode === "own-key"
      ? {
          model: state.model.trim(),
          keys: state.keys
            .split(",")
            .map((key) => key.trim())
            .filter(Boolean),
        }
      : {}),
    autoReview: state.mode === "own-key" && state.autoReview,
    share: state.mode === "own-key" && state.share,
  }))
  const key = createMemo(() =>
    JSON.stringify({
      input: input(),
      authority: {
        epoch: status.state.authorityEpoch,
        authorityId: status.state.status?.authorityId,
        repositoryId: status.state.status?.repositoryId,
        repository: status.state.status?.repo,
        defaultBranch: status.state.status?.defaultBranch,
        publicRepository: status.state.status?.publicRepository,
        workflow: status.state.status?.workflow,
        bound: status.state.status?.bound,
        binding: status.state.status?.binding,
      },
    }),
  )
  const allowed = createMemo(
    () =>
      !!props.cwd &&
      !!status.state.status?.signedIn &&
      !!status.state.status.repositoryId &&
      !!status.state.status.authorityId &&
      !!status.state.status.canDispatch &&
      view().kind !== "update-cli" &&
      (state.mode === "own-key" || view().codium) &&
      (state.mode !== "own-key" ||
        (!!state.model.trim() &&
          state.keys
            .split(",")
            .filter((value) => value.trim())
            .every((value) => /^[A-Z_][A-Z0-9_]*$/.test(value.trim())))),
  )
  createEffect(() => {
    key()
    revision += 1
    setState({
      preview: undefined,
      previewKey: undefined,
      opened: undefined,
      error: undefined,
      busy: false,
      operationId: crypto.randomUUID(),
      bindOperationId: crypto.randomUUID(),
    })
  })
  createEffect(() => {
    const next = status.state.status
    props.onStatus?.(next)
    if (!view().codium && state.mode === "codium") setState("mode", "own-key")
  })
  const preview = async () => {
    const api = agentsApi()
    if (!api || !allowed() || state.busy) return
    const token = ++revision
    const request = input()
    const requestedKey = key()
    setState({ busy: true, error: undefined, opened: undefined })
    await api
      .preview(request)
      .then((value) => {
        if (revision === token && requestedKey === key()) setState({ preview: value, previewKey: requestedKey })
      })
      .catch(() => {
        if (revision === token)
          setState("error", "Could not prepare the workflow. Check your GitHub access and try again.")
      })
    if (revision === token) setState("busy", false)
  }
  const setup = async () => {
    const api = agentsApi()
    const expectedRepositoryId = status.state.status?.repositoryId
    const authorityId = status.state.status?.authorityId
    if (
      !api ||
      !expectedRepositoryId ||
      !authorityId ||
      !allowed() ||
      state.busy ||
      !state.preview ||
      state.previewKey !== key()
    )
      return
    const token = ++revision
    setState({ busy: true, error: undefined })
    await api
      .setup({ ...input(), expectedRepositoryId, authorityId, operationId: state.operationId })
      .then((value) => {
        if (revision === token) setState({ opened: value.url, preview: undefined, previewKey: undefined })
      })
      .catch(() => {
        if (revision === token)
          setState("error", "Could not open the setup pull request. Check GitHub before trying again.")
      })
    if (revision === token) setState("busy", false)
  }
  const bind = async () => {
    const api = agentsApi()
    const cwd = props.cwd
    const expectedRepositoryId = status.state.status?.repositoryId
    const authorityId = status.state.status?.authorityId
    if (
      !api ||
      !cwd ||
      !expectedRepositoryId ||
      !authorityId ||
      state.busy ||
      !status.state.status?.canDispatch ||
      !view().codium
    )
      return
    const token = ++revision
    setState({ busy: true, error: undefined })
    await api
      .bind({ cwd, expectedRepositoryId, authorityId, operationId: state.bindOperationId })
      .then((value) => {
        if (revision !== token) return
        if (value.state === "failed") setState("error", "Binding did not complete. Check the workflow and try again.")
        if (value.state === "pending")
          setState("error", "Binding is still pending. Check the Actions run, then check again.")
        if (value.runUrl || value.workflowUpdate) setState("opened", value.runUrl ?? value.workflowUpdate)
        status.reload()
      })
      .catch(() => {
        if (revision === token)
          setState("error", "Could not bind this repository. Check your account and GitHub access.")
      })
    if (revision === token) setState("busy", false)
  }
  return (
    <div class="github-agents" data-github-agents-setup>
      <header>
        <h2>Set up {status.state.status ? agentHandle(status.state.status) : "/vector"}</h2>
        <p>Give Vector a task in GitHub, {ACTIONS_COPY}.</p>
      </header>
      <Show when={props.cwd} fallback={<p>Open a repository to set up its GitHub workflow.</p>}>
        <Show
          when={agentsApi()}
          fallback={
            <p>
              Set up this workflow from the Vector desktop app, or run <code>vector github install</code>.
            </p>
          }
        >
          <Show when={status.state.loading}>
            <p role="status">Checking GitHub…</p>
          </Show>
          <Show when={status.state.error}>
            <p role="alert">{status.state.error}</p>
          </Show>
          <Show when={view().kind === "sign-in"}>
            <p>Sign in to GitHub to check your repository access.</p>
            <button type="button" onClick={() => setState("signingIn", true)}>
              Sign in to GitHub
            </button>
          </Show>
          <Show when={state.signingIn}>
            <GithubDeviceSignIn
              intro="Approve GitHub access to set up this repository's workflow."
              workflow
              onConnected={() => {
                setState("signingIn", false)
                status.reload()
                props.onGithubConnected?.()
              }}
              onClose={() => setState("signingIn", false)}
            />
          </Show>
          <Show when={status.state.status?.signedIn && !state.signingIn}>
            <button type="button" disabled={state.busy} onClick={() => setState("signingIn", true)}>
              Update GitHub permissions
            </button>
          </Show>
          <Show when={view().kind === "update-cli"}>
            <p>Update Vector and its CLI before changing or running this workflow.</p>
          </Show>
          <Show when={status.state.status?.signedIn && !status.state.status.canDispatch}>
            <p>Setting up and starting runs requires write access to this repository.</p>
          </Show>
          <Show when={view().kind === "ready"}>
            <section>
              <h3>Ready in {status.state.status?.repo}</h3>
              <p>
                Comment <code>{status.state.status ? agentHandle(status.state.status) : "/vector"} your task</code> on
                an issue or pull request, or start a run here.
              </p>
              <button
                type="button"
                disabled={!status.state.status?.canDispatch || state.busy}
                onClick={() => setState("run", true)}
              >
                Run in GitHub
              </button>
            </section>
          </Show>
          <Show when={view().kind === "bind"}>
            <section>
              <h3>Bind this repository to your Vector account</h3>
              <p>Anyone with write access to a bound repository can start runs that use your plan.</p>
              <button
                type="button"
                disabled={!status.state.status?.canDispatch || state.busy}
                onClick={() => void bind()}
              >
                {state.busy ? "Waiting for GitHub…" : "Bind repository"}
              </button>
            </section>
          </Show>
          <Show when={view().kind === "unavailable" && view().codium}>
            <section>
              <h3>Codium is unavailable for this binding</h3>
              <p id="github-binding-unavailable">
                Check your account and repository access, then check again before starting a Codium run.
              </p>
              <button type="button" disabled aria-describedby="github-binding-unavailable">
                Run in GitHub
              </button>
            </section>
          </Show>
          <Show when={status.state.status}>
            <fieldset
              class="github-agents-grid"
              disabled={state.busy || !status.state.status?.signedIn || view().kind === "update-cli"}
            >
              <legend>Workflow setup</legend>
              <Show when={view().codium}>
                <label>
                  Run with
                  <select
                    value={state.mode}
                    onChange={(event) =>
                      setState("mode", event.currentTarget.value === "codium" ? "codium" : "own-key")
                    }
                  >
                    <option value="own-key">Your own key</option>
                    <option value="codium">
                      {view().noSecret ? "Codium (your plan, no key)" : "Codium (your plan)"}
                    </option>
                  </select>
                </label>
              </Show>
              <Show when={state.mode === "own-key"}>
                <p>
                  Your own key works with a free Vector account. Add provider keys and <code>VECTOR_CLI_TOKEN</code> as
                  repository secrets.
                </p>
                <label>
                  Provider/model
                  <input
                    value={state.model}
                    placeholder="provider/model"
                    onInput={(event) => setState("model", event.currentTarget.value)}
                  />
                </label>
                <label>
                  Provider secret names, separated by commas
                  <input
                    value={state.keys}
                    placeholder="OPENROUTER_API_KEY"
                    onInput={(event) => setState("keys", event.currentTarget.value)}
                  />
                </label>
              </Show>
              <Show when={state.mode === "own-key"}>
                <label class="github-agents-check">
                  <input
                    type="checkbox"
                    checked={state.autoReview}
                    onChange={(event) => setState("autoReview", event.currentTarget.checked)}
                  />
                  Review pull requests automatically
                </label>
                <label class="github-agents-check">
                  <input
                    type="checkbox"
                    checked={state.share}
                    onChange={(event) => setState("share", event.currentTarget.checked)}
                  />
                  Include a share link in results
                </label>
              </Show>
              <p>
                Preview the exact workflow before opening a pull request. Merge it on the default branch to apply these
                settings.
              </p>
              <button type="button" disabled={!allowed() || state.busy} onClick={() => void preview()}>
                {state.busy ? "Preparing…" : "Preview workflow"}
              </button>
            </fieldset>
          </Show>
          <Show when={state.preview}>
            {(workflow) => (
              <section class="github-agents-grid">
                <h3>{workflow().path}</h3>
                <pre aria-label="Workflow preview">{workflow().content}</pre>
                <Show when={workflow().secrets.length}>
                  <h3>Repository secrets to add</h3>
                  <For each={workflow().secrets}>
                    {(secret) => (
                      <p>
                        <code>{secret.name}</code>: {secret.detail}{" "}
                        <Show when={secret.url}>
                          <a href={secret.url} target="_blank" rel="noopener noreferrer">
                            Open secrets
                          </a>
                        </Show>
                      </p>
                    )}
                  </For>
                </Show>
                <button
                  type="button"
                  disabled={!allowed() || state.busy || state.previewKey !== key()}
                  onClick={() => void setup()}
                >
                  Open setup pull request
                </button>
              </section>
            )}
          </Show>
          <Show when={state.opened}>
            <p role="status">
              <a href={state.opened} target="_blank" rel="noopener noreferrer">
                Open on GitHub
              </a>
              . Check and merge workflow changes before checking again.
            </p>
          </Show>
          <Show when={state.error}>
            <p role="alert">{state.error}</p>
          </Show>
          <button type="button" disabled={state.busy || status.state.loading} onClick={status.reload}>
            Check again
          </button>
          <Show when={state.run && status.state.status}>
            {(current) => (
              <GithubRunDialog cwd={props.cwd!} status={current()} onClose={() => setState("run", false)} />
            )}
          </Show>
        </Show>
      </Show>
    </div>
  )
}
