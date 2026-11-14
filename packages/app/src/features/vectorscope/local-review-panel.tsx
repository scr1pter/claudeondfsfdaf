import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@vectordevai/ui/button"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { localReviewCanStart, localReviewController, localReviewTransport, type LocalReviewState } from "./local-review"

const empty = (): LocalReviewState => ({ runs: [], discovered: false, uncertain: false, error: "" })
const partialNotice = {
  budget: "The review stopped at its budget limit.",
  steps: "The review stopped at its step limit.",
  timeout: "The review did not finish within its time limit.",
  "model-error": "A model request did not finish successfully.",
  privacy: "Some code could not be reviewed under the configured privacy policy.",
  "budget-estimate": "The review could not proceed within its estimated budget.",
} satisfies Record<NonNullable<ReviewOutcome["partial"]>, string>

export function LocalReviewPanel(props: { parentID?: string; directory?: string }) {
  const sdk = useServerSDK()
  const sync = useServerSync()
  const [state, setState] = createStore({ value: empty(), revision: 0, authority: 0, unavailable: "" })
  let controller: ReturnType<typeof localReviewController> | undefined
  const enabled = () =>
    sync().globalConfig()?.experimental?.vectorscope === true &&
    sync().globalConfig()?.agent?.vectorscope?.disable !== true
  const source = createMemo(() => {
    const current = sdk()
    const parent = props.parentID ? sync().session.get(props.parentID) : undefined
    const directory = props.directory
    const epoch = state.authority
    if (!parent || parent.parentID || parent.internal || !directory || pathKey(parent.directory) !== pathKey(directory))
      return { current, epoch }
    return { current, epoch, parentID: parent.id, directory: parent.directory, projectID: parent.projectID }
  })
  createEffect(() => {
    const captured = source()
    controller?.dispose()
    controller = undefined
    setState("value", reconcile(empty()))
    if (!captured.parentID || !captured.directory || !captured.projectID) {
      setState(
        "unavailable",
        "Open an existing main conversation in this checkout to review its changes. Vector will not create or move a conversation for this action.",
      )
      return
    }
    setState("unavailable", "")
    const scope = {
      identity: captured.current,
      server: captured.current.scope,
      parentID: captured.parentID,
      directory: captured.directory,
      projectID: captured.projectID,
    }
    const active = localReviewController({
      scope: { ...scope, api: localReviewTransport(captured.current.client, scope) },
      enabled,
      changed: (value) => {
        setState("value", reconcile(value))
        setState("revision", (revision) => revision + 1)
      },
    })
    controller = active
    void active.check()
    const unsubscribe = captured.current.event.listen((event) => {
      if (!["server.connected", "global.disposed", "server.instance.disposed"].includes(event.details.type)) return
      // A reconnect can change owner authority without changing the displayed
      // directory. Retire code/results immediately, before another GET settles.
      active.dispose()
      setState("value", reconcile(empty()))
      setState("authority", (revision) => revision + 1)
    })
    onCleanup(() => {
      unsubscribe()
      active.dispose()
    })
  })
  createEffect(() => {
    const current = state.value.current
    if (!current || current.run.status !== "running" || state.value.busy) return
    const active = controller
    const timer = setTimeout(() => void active?.refresh(), 2_000)
    onCleanup(() => clearTimeout(timer))
  })
  onCleanup(() => controller?.dispose())
  const currentController = () => {
    void state.revision
    return controller
  }
  return (
    <LocalReviewView
      state={state.value}
      enabled={enabled()}
      unavailable={state.unavailable}
      controller={currentController()}
    />
  )
}

export function LocalReviewView(props: {
  state: LocalReviewState
  enabled: boolean
  unavailable?: string
  controller?: ReturnType<typeof localReviewController>
}) {
  const [draft, setDraft] = createStore({ kind: "working-tree" as "working-tree" | "staged", maxCost: "" })
  const findings = () => {
    const selection = props.state.current?.result?.outcome?.selection
    return selection
      ? [
          ...selection.inline,
          ...selection.outsideDiff,
          ...selection.elsewhere,
          ...selection.nits,
          ...selection.overflow,
        ]
      : []
  }
  const canStart = () => !!props.controller && localReviewCanStart(props.state, props.enabled)
  return (
    <section
      class="mx-auto w-full max-w-[960px] space-y-4 p-6"
      aria-label="Local VectorScope reviews"
      data-component="vectorscope-local-review"
    >
      <div>
        <h2 class="text-[19px] font-semibold">Review this conversation’s local changes</h2>
        <p class="mt-2 text-sm text-[color:var(--vx-text-subtle)]">
          Runs on the conversation’s connected engine and Git checkout. No GitHub sign-in is required. Closing this
          panel leaves an admitted review running.
        </p>
      </div>
      <Show when={props.unavailable}>
        <p role="status">{props.unavailable}</p>
      </Show>
      <Show when={!props.enabled}>
        <p role="status">
          New local reviews are off in the owner’s global VectorScope settings. Existing results and Stop remain
          available.
        </p>
      </Show>
      <div class="flex flex-wrap items-end gap-3">
        <label class="grid gap-1 text-sm">
          Changes to review
          <select
            aria-label="Local review target"
            value={draft.kind}
            disabled={!!props.state.busy || !!props.state.intent}
            onChange={(event) => setDraft("kind", event.currentTarget.value === "staged" ? "staged" : "working-tree")}
          >
            <option value="working-tree">All uncommitted changes</option>
            <option value="staged">Staged changes only</option>
          </select>
        </label>
        <label class="grid gap-1 text-sm">
          Optional maximum cost (USD)
          <input
            aria-label="Local review maximum cost"
            inputmode="decimal"
            value={draft.maxCost}
            disabled={!!props.state.busy || !!props.state.intent}
            onInput={(event) => setDraft("maxCost", event.currentTarget.value)}
            placeholder="Use engine limit"
          />
        </label>
        <Button
          disabled={!canStart()}
          onClick={() =>
            void props.controller?.start(draft.kind, draft.maxCost.trim() ? Number(draft.maxCost) : undefined)
          }
        >
          Start local review
        </Button>
        <Button
          variant="secondary"
          disabled={!props.controller || !!props.state.busy}
          onClick={() => void props.controller?.check()}
        >
          Check existing runs
        </Button>
      </div>
      <Show when={props.state.target}>
        <p class="text-xs text-[color:var(--vx-text-muted)]">
          Verified base: <code>{props.state.target!.head.slice(0, 12)}</code>. Starting uses the owner’s selected review
          model and current limits.
        </p>
      </Show>
      <Show when={props.state.next}>
        <p role="status">More review history remains. Load it before starting another review.</p>
        <Button disabled={!!props.state.busy} onClick={() => void props.controller?.check(true)}>
          Load older runs
        </Button>
      </Show>
      <Show when={props.state.busy}>
        <p role="status">
          {props.state.busy === "starting"
            ? "Submitting this exact review request…"
            : props.state.busy === "stopping"
              ? "Stopping and joining the owned review…"
              : "Checking local review status…"}
        </p>
      </Show>
      <Show when={props.state.error}>
        <p role="alert">{props.state.error}</p>
      </Show>
      <Show when={props.state.uncertain && props.state.intent}>
        <div class="space-y-2 rounded border border-[color:var(--vx-line)] p-3">
          <p role="status">
            This request’s outcome is not yet known. Check existing runs or retry its exact request key; Vector will not
            create a replacement automatically.
          </p>
          <Button disabled={!props.enabled || !!props.state.busy} onClick={() => void props.controller?.retry()}>
            Retry exact request
          </Button>
        </div>
      </Show>
      <Show when={props.state.current}>
        {(current) => (
          <article class="space-y-3 rounded border border-[color:var(--vx-line)] p-4" aria-label="Local review result">
            <div class="flex items-center justify-between gap-3">
              <h3 class="font-semibold">Review {current().run.status}</h3>
              <Show when={current().run.canStop && current().run.status === "running"}>
                <Button disabled={!!props.state.busy} onClick={() => void props.controller?.stop()}>
                  Stop local review
                </Button>
              </Show>
            </div>
            <p class="text-xs">
              {current().run.request.target.kind} · {current().run.request.target.head.slice(0, 12)} ·{" "}
              <code>{current().run.runID}</code>
            </p>
            <p>
              Verdict: <strong>{current().verdict.verdict}</strong>
            </p>
            <Show when={current().run.error}>
              <p role="status">{current().run.error}</p>
            </Show>
            <Show when={current().result?.error}>
              <p role="status">{current().result!.error}</p>
            </Show>
            <For each={current().verdict.causes}>{(cause) => <p class="text-sm">{cause}</p>}</For>
            <For each={current().verdict.notes}>{(note) => <p class="text-sm">{note}</p>}</For>
            <Show when={current().result?.outcome}>
              {(outcome) => (
                <>
                  <p class="whitespace-pre-wrap">{outcome().report.summary}</p>
                  <Show when={outcome().cost}>
                    <p class="text-sm">
                      Recorded cost: ${outcome().cost!.costUsd.toFixed(4)}
                      {outcome().cost!.partial ? " (partial)" : ""}
                    </p>
                  </Show>
                  <p class="text-sm">Read each finding in its file before deciding what to change.</p>
                  <Show when={findings().length > 0}>
                    <p class="text-sm">
                      Showing {Math.min(findings().length, 100)} of {findings().length} current findings.
                    </p>
                  </Show>
                  <For each={findings().slice(0, 100)}>
                    {(finding) => (
                      <div class="border-t border-[color:var(--vx-line)] pt-3">
                        <p class="font-medium">
                          {finding.severity} · {finding.title}
                        </p>
                        <p class="text-xs">
                          {finding.path}:{finding.line}
                        </p>
                        <p class="whitespace-pre-wrap text-sm">{finding.body}</p>
                      </div>
                    )}
                  </For>
                  <Show when={outcome().selection.stillOpen.length > 0}>
                    <h4 class="font-semibold">Earlier findings still open</h4>
                    <p class="text-sm">
                      Showing {Math.min(outcome().selection.stillOpen.length, 100)} of{" "}
                      {outcome().selection.stillOpen.length} earlier findings still open.
                    </p>
                    <For each={outcome().selection.stillOpen.slice(0, 100)}>
                      {(finding) => (
                        <div class="border-t border-[color:var(--vx-line)] pt-3">
                          <p class="font-medium">
                            {finding.severity} · {finding.title}
                          </p>
                          <p class="text-xs">
                            {finding.path}
                            {finding.line === null ? "" : `:${finding.line}`}
                          </p>
                        </div>
                      )}
                    </For>
                  </Show>
                  <Show when={!findings().length && !outcome().selection.stillOpen.length}>
                    <p class="text-sm">
                      No findings were retained. Check the verdict and coverage before relying on this review.
                    </p>
                  </Show>
                  <div class="space-y-2 border-t border-[color:var(--vx-line)] pt-3" aria-label="Local review coverage">
                    <h4 class="font-semibold">Review coverage</h4>
                    <Show when={outcome().partial}>{(reason) => <p>{partialNotice[reason()]}</p>}</Show>
                    <Show when={outcome().unreviewed.length > 0}>
                      <p>
                        {outcome().unreviewed.length} {outcome().unreviewed.length === 1 ? "file was" : "files were"}{" "}
                        not reviewed. Showing {Math.min(outcome().unreviewed.length, 100)}.
                      </p>
                      <ul>
                        <For each={outcome().unreviewed.slice(0, 100)}>{(path) => <li class="text-sm">{path}</li>}</For>
                      </ul>
                    </Show>
                    <Show when={outcome().skipped.length > 0}>
                      <p>
                        {outcome().skipped.length} {outcome().skipped.length === 1 ? "file was" : "files were"} skipped.
                        Showing {Math.min(outcome().skipped.length, 100)}.
                      </p>
                      <ul>
                        <For each={outcome().skipped.slice(0, 100)}>
                          {(file) => (
                            <li class="text-sm">
                              {file.path} · {file.reason.replaceAll("-", " ")}
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <Show when={outcome().selection.dropped.length > 0}>
                      <p>
                        Findings left out ({outcome().selection.dropped.reduce((total, item) => total + item.count, 0)}
                        ). Showing {Math.min(outcome().selection.dropped.length, 100)} of{" "}
                        {outcome().selection.dropped.length} reason groups.
                      </p>
                      <ul>
                        <For each={outcome().selection.dropped.slice(0, 100)}>
                          {(item) => (
                            <li class="text-sm">
                              {item.reason.replaceAll("-", " ")} · {item.count}
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <For each={outcome().notes.slice(0, 100)}>{(note) => <p class="text-sm">{note}</p>}</For>
                  </div>
                </>
              )}
            </Show>
          </article>
        )}
      </Show>
      <div class="space-y-2" aria-label="Retained local review runs">
        <h3 class="font-semibold">Existing runs</h3>
        <Show when={props.state.discovered && !props.state.runs.length}>
          <p class="text-sm">No retained local reviews were found.</p>
        </Show>
        <For each={props.state.runs}>
          {(run) => (
            <div class="flex flex-wrap items-center justify-between gap-2 rounded border border-[color:var(--vx-line)] p-3">
              <span class="text-sm">
                {run.request.target.kind} · {run.request.target.head.slice(0, 12)} · {run.status}
              </span>
              <Button
                variant="secondary"
                disabled={!!props.state.busy}
                onClick={() => void props.controller?.read(run)}
              >
                Open review
              </Button>
            </div>
          )}
        </For>
      </div>
    </section>
  )
}
