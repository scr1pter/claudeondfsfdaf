import { createEffect, createMemo, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import {
  ACTIONS_COPY,
  agentsApi,
  agentsView,
  brainApproval,
  runMinutes,
  type AgentsStatus,
  type BrainPreview,
} from "./agents-model"
import "./github-agents.css"

export function GithubRunDialog(props: { cwd: string; status: AgentsStatus; onClose: () => void }) {
  const [state, setState] = createStore<{
    prompt: string
    includeBrain: boolean
    preview?: BrainPreview
    approved?: string
    busy: boolean
    error?: string
    runUrl?: string
    dispatched: boolean
  }>({ prompt: "", includeBrain: false, busy: false, dispatched: false })
  const ready = createMemo(() => agentsView(props.status).kind === "ready" && props.status.canDispatch)
  const brainAvailable = createMemo(
    () =>
      props.status.options?.mode === "codium" &&
      props.status.listed.agents &&
      props.status.listed.brain &&
      props.status.bound === "yours" &&
      !!props.status.repositoryId &&
      typeof props.status.publicRepository === "boolean",
  )
  const approved = createMemo(
    () =>
      brainApproval(state.preview, props.status.repositoryId, state.approved) &&
      state.preview?.publicRepository === props.status.publicRepository,
  )
  let revision = 0
  let dialog: HTMLDivElement | undefined
  const previous = document.activeElement
  onMount(() => dialog?.querySelector<HTMLTextAreaElement>("textarea")?.focus())
  onCleanup(() => {
    revision += 1
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
  })
  createEffect(() => {
    props.cwd
    props.status.repositoryId
    props.status.publicRepository
    brainAvailable()
    revision += 1
    setState({
      includeBrain: false,
      preview: undefined,
      approved: undefined,
      error: undefined,
      busy: false,
      dispatched: false,
      runUrl: undefined,
    })
  })
  const preview = async () => {
    const api = agentsApi()
    if (!api || !brainAvailable() || !state.includeBrain || state.busy || !ready()) return
    const token = ++revision
    setState({ busy: true, error: undefined, approved: undefined, preview: undefined })
    await api
      .previewBrain(props.cwd)
      .then((value) => {
        if (revision !== token) return
        if (
          value.repositoryId !== props.status.repositoryId ||
          value.publicRepository !== props.status.publicRepository
        ) {
          setState("error", "Repository details changed. Check the repository again before approving Brain.")
          return
        }
        setState("preview", value)
      })
      .catch(() => {
        if (revision === token) setState("error", "Could not prepare Brain. Nothing has been uploaded.")
      })
    if (revision === token) setState("busy", false)
  }
  const run = async (event: SubmitEvent) => {
    event.preventDefault()
    const api = agentsApi()
    if (
      !api ||
      !ready() ||
      !state.prompt.trim() ||
      state.busy ||
      state.dispatched ||
      (state.includeBrain && (!brainAvailable() || !approved()))
    )
      return
    const token = ++revision
    setState({ busy: true, error: undefined })
    await api
      .run({
        cwd: props.cwd,
        prompt: state.prompt.trim(),
        ...(state.includeBrain && state.preview
          ? { brain: { previewId: state.preview.id, approvedSha256: state.preview.sha256 } }
          : {}),
      })
      .then((value) => {
        if (revision === token)
          setState({ runUrl: value.runUrl, dispatched: true, approved: undefined, preview: undefined })
      })
      .catch(() => {
        if (revision === token)
          setState(
            "error",
            "Could not start the run. Check GitHub before retrying. Brain approval is not reused for another run.",
          )
      })
    if (revision === token) setState({ busy: false, approved: undefined, preview: undefined })
  }
  return (
    <Portal>
      <div class="github-agents-dialog-backdrop">
        <div
          class="github-agents github-agents-dialog"
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label="Run in GitHub"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              props.onClose()
              return
            }
            if (event.key !== "Tab") return
            const items = [
              ...(dialog?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]",
              ) ?? []),
            ]
            const first = items[0]
            const last = items.at(-1)
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }}
        >
          <header class="github-agents-actions">
            <h2 class="flex-1">Run in GitHub</h2>
            <button type="button" onClick={props.onClose}>
              Close
            </button>
          </header>
          <p>
            <strong>{props.status.repo}</strong> · {props.status.options?.mode === "codium" ? "Codium" : "Your own key"}
          </p>
          <p>
            Runs {ACTIONS_COPY}. {runMinutes(props.status)}
          </p>
          <a
            href="https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub Actions usage information
          </a>
          <Show when={props.status.publicRepository}>
            <p class="github-agents-warning">This repository is public: its Actions logs are public.</p>
          </Show>
          <Show when={!ready()}>
            <p role="alert">Check the current workflow, binding and write access before starting a run.</p>
          </Show>
          <form class="github-agents-grid" onSubmit={(event) => void run(event)}>
            <label>
              What should Vector do?
              <textarea
                rows={5}
                autofocus
                required
                maxlength={12000}
                value={state.prompt}
                disabled={state.busy || state.dispatched}
                onInput={(event) => setState("prompt", event.currentTarget.value)}
              />
            </label>
            <Show when={brainAvailable() && !state.dispatched}>
              <section class="github-agents-grid">
                <label class="github-agents-check">
                  <input
                    type="checkbox"
                    checked={state.includeBrain}
                    disabled={state.busy}
                    onChange={(event) => {
                      revision += 1
                      setState({
                        includeBrain: event.currentTarget.checked,
                        preview: undefined,
                        approved: undefined,
                        error: undefined,
                      })
                    }}
                  />
                  Include repository Brain for this run
                </label>
                <Show when={state.includeBrain}>
                  <p>
                    Preview the exact repository memory and skills before approving them. Upload starts only when you
                    start this run.
                  </p>
                  <button type="button" disabled={state.busy || !ready()} onClick={() => void preview()}>
                    Preview Brain
                  </button>
                </Show>
                <Show when={state.includeBrain && state.preview}>
                  {(value) => (
                    <div class="github-agents-grid">
                      <p>
                        {value().entries} entries · {value().skills} skills · {value().bytes} bytes
                      </p>
                      <pre aria-label="Brain preview">{value().text}</pre>
                      <p>
                        Digest: <code>{value().sha256}</code>
                      </p>
                      <Show when={value().publicRepository}>
                        <p class="github-agents-warning">
                          Review this content for public repository use before approving it.
                        </p>
                      </Show>
                      <label class="github-agents-check">
                        <input
                          type="checkbox"
                          checked={approved()}
                          disabled={state.busy}
                          onChange={(event) =>
                            setState("approved", event.currentTarget.checked ? value().sha256 : undefined)
                          }
                        />
                        I approve this exact Brain content for this repository and this run.
                      </label>
                    </div>
                  )}
                </Show>
              </section>
            </Show>
            <Show when={state.error}>
              <p role="alert">{state.error}</p>
            </Show>
            <Show
              when={state.dispatched}
              fallback={
                <button
                  type="submit"
                  disabled={!ready() || !state.prompt.trim() || state.busy || (state.includeBrain && !approved())}
                >
                  {state.busy ? "Starting…" : "Start run"}
                </button>
              }
            >
              <p role="status">
                Run dispatched.{" "}
                <Show when={state.runUrl}>
                  <a href={state.runUrl} target="_blank" rel="noopener noreferrer">
                    Open Actions run
                  </a>
                </Show>
              </p>
            </Show>
          </form>
        </div>
      </div>
    </Portal>
  )
}
