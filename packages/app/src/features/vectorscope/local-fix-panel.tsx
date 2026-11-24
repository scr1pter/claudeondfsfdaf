import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@vectordevai/ui/button"
import { CHECK_COMMANDS } from "@vectordevai/core/review/permission"
import { ReviewFixControl } from "@vectordevai/schema/review-fix"
import type { ReviewOutcomeLite } from "@/features/pull-requests/ai-review"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import {
  candidateLines,
  LOCAL_FIX_DWELL_MS,
  localFixActions,
  localFixCancel,
  localFixCandidates,
  localFixController,
  localFixTransport,
  offerLines,
  previewLines,
  resultLines,
  visible,
  type LocalFixPullRequest,
  type LocalFixSource,
  type LocalFixState,
} from "./local-fix"
import { localFixesEnabled } from "./local-fix-slot"

const empty = (): LocalFixState => ({ fixes: [], results: [], uncertain: false, error: "" })

/** Whether a server event retires the fix panel of the conversation in `directory`. */
export function localFixRetires(event: { name: string; details: { type: string } }, directory: string) {
  const type = event.details.type
  return (
    type === "server.connected" ||
    type === "global.disposed" ||
    (type === "server.instance.disposed" && pathKey(event.name) === pathKey(directory))
  )
}
const VERB = { apply: "apply", checks: "run checks", commit: "commit", push: "push" } as const

/**
 * The fix panel under a pull request's review result (SF-10b). One controller per server, conversation, folder and
 * owner authority, as LocalReviewPanel, never per review; a reconnect or a settings reload retires it.
 */
export function LocalFixPanel(props: {
  outcome: ReviewOutcomeLite
  pr: LocalFixPullRequest
  dismissed: ReadonlySet<string>
  applied: ReadonlySet<string>
  parentID?: string
  directory?: string
}) {
  const sdk = useServerSDK()
  const sync = useServerSync()
  const [state, setState] = createStore({ value: empty(), revision: 0, authority: 0, unavailable: "" })
  let controller: ReturnType<typeof localFixController> | undefined
  const enabled = () => localFixesEnabled(sync().globalConfig())
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
        "Open an existing main conversation in this checkout to fix in a separate checkout. Vector will not create or move a conversation for this action.",
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
    const active = localFixController({
      scope: { ...scope, api: localFixTransport(captured.current.client, scope) },
      enabled,
      dismissed: () => props.dismissed,
      changed: (value) => {
        setState("value", reconcile(value))
        setState("revision", (revision) => revision + 1)
      },
    })
    controller = active
    void active.check()
    const unsubscribe = captured.current.event.listen((event) => {
      // A reconnect or the server's own disposal, or this checkout's instance disposed (a settings reload). Another
      // folder's instance going (a retired isolated task's worktree, another project's reload) leaves the fix alone.
      if (!localFixRetires(event, scope.directory)) return
      // Owner authority may have changed: retire the fix and its offer at once, before another request settles.
      active.dispose()
      setState("value", reconcile(empty()))
      setState("authority", (revision) => revision + 1)
    })
    onCleanup(() => {
      unsubscribe()
      active.dispose()
    })
  })
  onCleanup(() => controller?.dispose())
  const currentController = () => {
    void state.revision
    return controller
  }
  const fixSource = (): LocalFixSource => ({
    outcome: props.outcome,
    pr: props.pr,
    dismissed: props.dismissed,
    applied: props.applied,
  })
  return (
    <LocalFixView
      state={state.value}
      enabled={enabled()}
      unavailable={state.unavailable}
      source={fixSource}
      controller={currentController()}
    />
  )
}

/**
 * The fix panel's view, for any controller: the fixes the review offers, the preview, four separate step buttons, the
 * offer card with its own Approve away from them, results and open fixes. Text only, never HTML.
 */
export function LocalFixView(props: {
  state: LocalFixState
  enabled: boolean
  unavailable?: string
  source: () => LocalFixSource
  controller?: ReturnType<typeof localFixController>
  dwellMs?: number
}) {
  const [draft, setDraft] = createStore({ checks: [] as string[], remote: "", mode: "branch" as "branch" | "draft-pr" })
  // Re-evaluated when an offer's pause ends and when it expires, so Approve's state follows the clock.
  const [tick, setTick] = createSignal(0)
  createEffect(() => {
    const offer = props.state.offer
    const offeredAt = props.state.offeredAt
    if (!offer || offeredAt === undefined) return
    const dwell = setTimeout(
      () => setTick((value) => value + 1),
      Math.max(0, offeredAt + (props.dwellMs ?? LOCAL_FIX_DWELL_MS) - Date.now()) + 10,
    )
    const expiry = setTimeout(() => setTick((value) => value + 1), Math.max(0, offer.expiresAt - Date.now()) + 10)
    onCleanup(() => {
      clearTimeout(dwell)
      clearTimeout(expiry)
    })
  })
  const candidates = createMemo(() => localFixCandidates(props.source()))
  const offered = () => {
    const value = candidates()
    return value.ok ? value.found : undefined
  }
  const refusal = () => {
    const value = candidates()
    return value.ok ? undefined : value.reason
  }
  const actions = createMemo(() => {
    void tick()
    return localFixActions(props.state, {
      enabled: props.enabled && !!props.controller,
      dismissed: props.source().dismissed,
      now: Date.now(),
      dwellMs: props.dwellMs,
    })
  })
  const prepared = (fixID: string) => props.state.preview?.fixID === fixID
  return (
    <section
      class="space-y-3 border-t border-[color:var(--vx-line)] px-4 py-4 text-[12.5px]"
      aria-label="Local VectorScope fixes"
      data-component="vectorscope-local-fix"
    >
      <div>
        <h3 class="text-[13px] font-semibold">Fix in a separate checkout (experimental)</h3>
        <p class="mt-1.5 leading-relaxed text-[color:var(--vx-text-subtle)]">
          Vector can apply the suggestions of findings this review’s double-check confirmed, in a separate checkout of
          this pull request’s head commit. The engine did not check those findings again. Your checkout, branch, index
          and files are not changed. Each step (apply, checks, commit, push) is previewed first and needs its own
          approval. Posting this review to GitHub, suggestions included, approves none of them. This is separate from
          “Apply” on a finding, which edits your checkout.
        </p>
        <p class="mt-1.5 leading-relaxed text-[color:var(--vx-text-muted)]">
          Reviewing again, opening another pull request or your changes, merging, switching repositories, closing this panel,
          a reconnect or a settings change closes this section: a running step stops (its approval is spent) and Vector
          cancels the fix checkout it prepared here; a commit on its new branch is kept. At most{" "}
          {ReviewFixControl.LIMIT.fixes} fixes can be open in a repository, other conversations’ included. A fix left open
          is removed when the engine restarts.
        </p>
      </div>
      <Show when={props.unavailable}>
        <p role="status">{props.unavailable}</p>
      </Show>
      <Show when={!props.enabled}>
        <p role="status">
          Fixes are off in the owner’s global VectorScope settings. Open fixes can still be cancelled.
        </p>
      </Show>

      <Show when={!props.state.preview}>
        <Show when={refusal()}>{(reason) => <p role="status">{reason()}</p>}</Show>
        <Show when={offered()}>
          {(found) => (
            <div class="space-y-2" aria-label="Fixes this review offers">
              <p>{found().source.replace(/^Fix source: /, "From ")}</p>
              <Show when={found().fixes.length} fallback={<p role="status">Nothing to fix: {found().none}</p>}>
                <pre class="whitespace-pre-wrap text-[11.5px]">
                  {candidateLines(found(), props.state.plan).join("\n")}
                </pre>
              </Show>
              <Button
                disabled={!actions().prepare.enabled || !found().fixes.length}
                title={actions().prepare.reason}
                onClick={() => void props.controller?.prepare(props.source())}
              >
                Prepare a fix checkout
              </Button>
            </div>
          )}
        </Show>
      </Show>

      <Show when={props.state.preview}>
        {(preview) => (
          <div class="space-y-2" aria-label="Fix preview">
            <pre class="whitespace-pre-wrap text-[11.5px]">{previewLines(preview()).join("\n")}</pre>
            <For each={preview().notes}>{(note) => <p class="text-[11.5px]">{visible(note, false)}</p>}</For>
            <Show when={props.state.found}>
              {(found) => (
                <pre class="whitespace-pre-wrap text-[11.5px]" aria-label="Fixes in this checkout">
                  {candidateLines(found(), props.state.plan).join("\n")}
                </pre>
              )}
            </Show>
            <pre
              class="max-h-[420px] overflow-auto rounded border border-[color:var(--vx-line)] p-2 text-[11.5px]"
              aria-label="Fix patch"
            >
              {visible(preview().patch)}
            </pre>
            <div class="flex flex-wrap items-end gap-2" role="group" aria-label="Fix steps">
              <Button
                disabled={!actions().apply.enabled}
                title={actions().apply.reason}
                onClick={() => void props.controller?.offer({ kind: "apply" })}
              >
                Preview apply
              </Button>
              <fieldset class="grid gap-1" aria-label="Checks to run">
                <For each={CHECK_COMMANDS}>
                  {(command) => (
                    <label class="flex items-center gap-1.5 text-[11.5px]">
                      <input
                        type="checkbox"
                        checked={draft.checks.includes(command)}
                        disabled={!!props.state.busy || !!props.state.offer}
                        onChange={(event) =>
                          setDraft("checks", (checks) =>
                            event.currentTarget.checked
                              ? CHECK_COMMANDS.filter((item) => item === command || checks.includes(item))
                              : checks.filter((item) => item !== command),
                          )
                        }
                      />
                      {command}
                    </label>
                  )}
                </For>
              </fieldset>
              <Button
                disabled={!actions().checks.enabled || !draft.checks.length}
                title={actions().checks.reason ?? (draft.checks.length ? undefined : "Choose at least one check.")}
                onClick={() =>
                  void props.controller?.offer({
                    kind: "checks",
                    commands: draft.checks.map((command) => ({ argv: command.split(" "), cwd: "." })),
                  })
                }
              >
                Preview checks
              </Button>
              <Button
                disabled={!actions().commit.enabled}
                title={actions().commit.reason}
                onClick={() => void props.controller?.offer({ kind: "commit" })}
              >
                Preview commit
              </Button>
              <label class="grid gap-1 text-[11.5px]">
                Push to (a configured https remote, or file:///path)
                <input
                  aria-label="Fix push remote"
                  value={draft.remote}
                  disabled={!!props.state.busy || !!props.state.offer}
                  onInput={(event) => setDraft("remote", event.currentTarget.value)}
                />
              </label>
              <label class="grid gap-1 text-[11.5px]">
                Push mode
                <select
                  aria-label="Fix push mode"
                  value={draft.mode}
                  disabled={!!props.state.busy || !!props.state.offer}
                  onChange={(event) =>
                    setDraft("mode", event.currentTarget.value === "draft-pr" ? "draft-pr" : "branch")
                  }
                >
                  <option value="branch">branch</option>
                  <option value="draft-pr">draft-pr</option>
                </select>
              </label>
              <Button
                disabled={!actions().push.enabled || !draft.remote.trim()}
                title={actions().push.reason ?? (draft.remote.trim() ? undefined : "Enter a remote.")}
                onClick={() =>
                  void props.controller?.offer({ kind: "push", remote: draft.remote.trim(), mode: draft.mode })
                }
              >
                Preview push
              </Button>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.state.busy}>
        <p role="status">
          {props.state.busy === "running"
            ? "Running the approved step… Closing this panel stops it."
            : props.state.busy === "preparing"
              ? "Preparing the fix checkout…"
              : props.state.busy === "offering"
                ? "Asking the engine for this step’s exact offer…"
                : props.state.busy === "cancelling"
                  ? "Cancelling the fix…"
                  : "Checking open fixes…"}
        </p>
      </Show>
      <Show when={props.state.error}>
        <p role="alert">{props.state.error}</p>
      </Show>
      <Show when={props.state.uncertain}>
        <div class="space-y-2 rounded border border-[color:var(--vx-line)] p-3">
          <p role="status">
            The last answer did not arrive. Check open fixes before anything else; Vector does not send a step again on
            its own.
          </p>
          <Button disabled={!!props.state.busy || !props.controller} onClick={() => void props.controller?.check()}>
            Check open fixes
          </Button>
        </div>
      </Show>

      <Show when={props.state.offer}>
        {(offer) => (
          <div class="space-y-2 rounded border border-[color:var(--vx-line)] p-3" aria-label="Fix step offer">
            <h4 class="font-semibold">Approve this step?</h4>
            <pre class="whitespace-pre-wrap text-[11.5px]">{offerLines(offer()).join("\n")}</pre>
            <div class="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => props.controller?.dismiss()}>
                Dismiss
              </Button>
              <Button
                variant="primary"
                disabled={!actions().approve.enabled}
                title={actions().approve.reason}
                onClick={(event: MouseEvent) =>
                  void props.controller?.approve({ trusted: event.isTrusted, clicks: event.detail })
                }
              >
                Approve and {VERB[offer().operation.kind]}
              </Button>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.state.results.length}>
        <div class="space-y-2" aria-label="Fix results">
          <For each={props.state.results}>
            {(result) => <pre class="whitespace-pre-wrap text-[11.5px]">{resultLines(result).join("\n")}</pre>}
          </For>
        </div>
      </Show>

      <div class="space-y-2" aria-label="Open fixes">
        <h4 class="font-semibold">Open fixes</h4>
        <Show when={!props.state.fixes.length}>
          <p class="text-[11.5px]">No fix is open for this conversation.</p>
        </Show>
        <For each={props.state.fixes}>
          {(fix) => (
            <div class="flex flex-wrap items-center justify-between gap-2 rounded border border-[color:var(--vx-line)] p-2">
              <span class="text-[11.5px]">
                {visible(fix.destinationBranch, false)} · {fix.state} · {fix.head.slice(0, 7)}
                {fix.commit ? ` · commit ${fix.commit.slice(0, 7)}` : ""}
                {prepared(fix.fixID) ? "" : " · prepared elsewhere: it can only be cancelled here"}
              </span>
              <Button
                variant="secondary"
                disabled={!props.controller || !localFixCancel(props.state, fix.fixID).enabled}
                title={localFixCancel(props.state, fix.fixID).reason}
                onClick={() => void props.controller?.cancel(fix.fixID)}
              >
                {props.state.busy === "running" && prepared(fix.fixID) ? "Stop and cancel this fix" : "Cancel this fix"}
              </Button>
            </div>
          )}
        </For>
      </div>
    </section>
  )
}
