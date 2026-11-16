import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@vectordevai/ui/button"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import {
  emptyReviewMemory,
  reviewMemoryController,
  type ReviewMemorySelection,
  type ReviewMemoryViewState,
} from "./review-memory"

export interface ReviewMemoryEvents {
  /** The binding also invalidates its selected owner proof so a remount cannot reuse it. */
  listen(changed: () => void): () => void
}

/** Owner data controls, mounted once through the connected adapter. Model consumption remains unavailable. */
export function ReviewMemoryPanel(props: { selection: ReviewMemorySelection; events?: ReviewMemoryEvents }) {
  const [state, setState] = createStore({ value: emptyReviewMemory() })
  const controller = reviewMemoryController({
    selection: props.selection,
    changed: (value) => setState("value", reconcile(value)),
  })
  let started = false
  createEffect(() => {
    const changed = controller.update(props.selection)
    if (!started || changed) {
      started = true
      if (controller.canRead()) void controller.refresh(0)
    }
  })
  createEffect(() => {
    const unsubscribe = props.events?.listen(() => controller.retire())
    onCleanup(() => unsubscribe?.())
  })
  onCleanup(() => controller.dispose())
  return <ReviewMemoryView state={state.value} controller={controller} directory={props.selection.directory} />
}

function EntryText(props: {
  entry: Pick<ReviewMemoryControl.Entry, "text" | "reason" | "paths" | "citations"> & {
    source?: ReviewMemoryControl.Source
  }
}) {
  return (
    <div class="space-y-2 text-sm">
      <p class="whitespace-pre-wrap break-words">{props.entry.text}</p>
      <p class="whitespace-pre-wrap break-words">Reason: {props.entry.reason}</p>
      <p>
        Paths: <For each={props.entry.paths}>{(value) => <code class="mr-2 break-all">{value}</code>}</For>
      </p>
      <Show when={props.entry.source}>
        {(source) => (
          <div class="space-y-1 text-xs">
            <p>
              Source conversation: <code>{source().parentID}</code>
            </p>
            <p>
              Source review: <code>{source().reviewID}</code>
            </p>
            <p>
              Source revision: <code>{source().head}</code>
            </p>
          </div>
        )}
      </Show>
      <For each={props.entry.citations}>
        {(citation) => (
          <blockquote class="space-y-1 border-l-2 pl-3">
            <p>
              <code class="break-all">
                {citation.path}:{citation.line}
              </code>{" "}
              at <code>{citation.head}</code>
            </p>
            <pre class="whitespace-pre-wrap break-words font-mono">{citation.quote}</pre>
          </blockquote>
        )}
      </For>
    </div>
  )
}

export function ReviewMemoryView(props: {
  state: ReviewMemoryViewState
  directory: string
  controller: ReturnType<typeof reviewMemoryController>
}) {
  const canPrepare = () =>
    props.state.status === "ready" &&
    !!props.state.read &&
    !props.state.busy &&
    !props.state.preview &&
    !props.state.retry &&
    props.controller.canPrepare()
  const canRead = () => {
    void props.state.status
    return props.controller.canRead()
  }
  const preview = () => props.state.preview
  const configure = () => {
    const value = preview()
    return value?.operation === "configure" ? value : undefined
  }
  const record = () => {
    const value = preview()
    return value?.operation === "record" ? value : undefined
  }
  const approve = () => {
    const value = preview()
    return value?.operation === "approve" ? value : undefined
  }
  const reopen = () => {
    const value = preview()
    return value?.operation === "reopen" ? value : undefined
  }
  const forget = () => {
    const value = preview()
    return value?.operation === "forget" ? value : undefined
  }
  const forgotten = () => props.state.read?.state.entries.find((entry) => entry.id === forget()?.payload.id)
  return (
    <section
      aria-label="Repository review memory"
      data-component="vectorscope-review-memory"
      class="mx-auto w-full max-w-[960px] space-y-5 p-6"
    >
      <div>
        <h2 class="text-[19px] font-semibold">Review memory for this repository</h2>
        <p class="mt-2 text-sm text-[color:var(--vx-text-subtle)]">
          Store and manage repository preferences, checks and approved review outcomes on this engine. Stored entries
          are not included in reviews yet. No GitHub sign-in is required.
        </p>
      </div>
      <Show when={props.state.message}>
        <p role="status" class="whitespace-pre-wrap">
          {props.state.message}
        </p>
      </Show>
      <Show when={props.state.busy}>
        <p role="status">
          {props.state.busy === "confirming"
            ? "Sending this exact confirmation…"
            : props.state.busy === "preparing"
              ? "Checking current owner state and preparing a preview…"
              : props.state.busy === "discarding"
                ? "Discarding this preview…"
                : "Reading current owner memory…"}
        </p>
      </Show>
      <Button
        variant="secondary"
        disabled={!!props.state.busy || !canRead()}
        onClick={() => void props.controller.refresh()}
      >
        Refresh current memory
      </Button>
      <Show when={props.state.read}>
        {(read) => (
          <>
            <p class="text-sm">
              Selected local repository: <code>{props.directory}</code>
            </p>
            <details class="text-xs">
              <summary>Repository details</summary>
              <p>
                Repository: <code>{read().repository}</code>
              </p>
              <p>
                Verified scope: <code>{read().scope}</code>
              </p>
            </details>
            <p role="status">
              {read().state.enabled
                ? "Use of approved entries in supported reviews is allowed. Stored entries are not included in reviews yet."
                : "Use in supported reviews is off. Stored entries are not included in reviews yet."}
            </p>
            <div class="flex flex-wrap gap-2">
              <Button
                disabled={!canPrepare()}
                onClick={() => void props.controller.prepare({ action: "configure", enabled: !read().state.enabled })}
              >
                {read().state.enabled ? "Preview disallowing review use" : "Preview allowing review use"}
              </Button>
              <Button
                variant="secondary"
                disabled={!canPrepare()}
                onClick={() => void props.controller.prepare({ action: "erase" })}
              >
                Preview erasing repository memory
              </Button>
            </div>
            <Show when={read().state.enabled}>
              <fieldset class="space-y-3 rounded-lg border p-4" disabled={!canPrepare()}>
                <legend>New owner preference or check</legend>
                <label class="grid gap-1 text-sm">
                  Entry type
                  <select
                    aria-label="Memory entry type"
                    value={props.state.draft.kind}
                    onChange={(event) =>
                      props.controller.editDraft({
                        kind: event.currentTarget.value === "check" ? "check" : "preference",
                      })
                    }
                  >
                    <option value="preference">Preference</option>
                    <option value="check">Check</option>
                  </select>
                </label>
                <label class="grid gap-1 text-sm">
                  Text
                  <textarea
                    aria-label="Memory entry text"
                    rows={3}
                    maxLength={ReviewMemoryControl.LIMIT.body}
                    value={props.state.draft.text}
                    onInput={(event) => props.controller.editDraft({ text: event.currentTarget.value })}
                  />
                </label>
                <label class="grid gap-1 text-sm">
                  Reason
                  <textarea
                    aria-label="Memory entry reason"
                    rows={2}
                    maxLength={ReviewMemoryControl.LIMIT.reason}
                    value={props.state.draft.reason}
                    onInput={(event) => props.controller.editDraft({ reason: event.currentTarget.value })}
                  />
                </label>
                <label class="grid gap-1 text-sm">
                  Relative path patterns, one per line
                  <textarea
                    aria-label="Memory entry paths"
                    rows={2}
                    maxLength={ReviewMemoryControl.LIMIT.paths * 513}
                    value={props.state.draft.paths}
                    onInput={(event) => props.controller.editDraft({ paths: event.currentTarget.value })}
                  />
                </label>
                <label class="grid gap-1 text-sm">
                  Use in reviews
                  <select
                    aria-label="Memory entry visibility"
                    value={props.state.draft.visibility}
                    onChange={(event) =>
                      props.controller.editDraft({
                        visibility: event.currentTarget.value === "private" ? "private" : "repository",
                      })
                    }
                  >
                    <option value="repository">Available to this repository’s reviews</option>
                    <option value="private">Store privately, exclude from reviews</option>
                  </select>
                </label>
                <Button
                  disabled={
                    !canPrepare() ||
                    !props.state.draft.text.trim() ||
                    !props.state.draft.reason.trim() ||
                    !props.state.draft.paths.trim()
                  }
                  onClick={() => void props.controller.prepareDraft()}
                >
                  Preview new entry
                </Button>
              </fieldset>
            </Show>
            <div class="space-y-3" aria-label="Stored review memory entries">
              <Show when={read().state.entries.length === 0}>
                <p>No stored entries on this page.</p>
              </Show>
              <For each={read().state.entries}>
                {(entry) => (
                  <article aria-label={`Memory entry ${entry.id}`} class="space-y-3 rounded-lg border p-4">
                    <h3 class="font-medium">
                      {entry.kind === "outcome"
                        ? "Review outcome"
                        : entry.kind === "check"
                          ? "Owner check"
                          : "Owner preference"}{" "}
                      · {entry.status === "proposed" ? "Awaiting approval" : "Approved"}
                    </h3>
                    <EntryText entry={entry} />
                    <p class="text-xs">
                      {entry.visibility === "private"
                        ? "Private entry, excluded from supported reviews."
                        : "Repository entry. Stored entries are not included in reviews yet."}
                    </p>
                    <div class="flex gap-2">
                      <Show when={entry.status === "proposed"}>
                        <Button
                          disabled={!canPrepare()}
                          onClick={() => void props.controller.prepare({ action: "approve", id: entry.id })}
                        >
                          Preview approving outcome
                        </Button>
                      </Show>
                      <Show when={entry.origin === "review" && entry.kind === "outcome" && entry.status === "active"}>
                        <Button
                          variant="secondary"
                          disabled={!canPrepare()}
                          onClick={() => props.controller.selectReopen(entry.id)}
                        >
                          Reopen approved outcome
                        </Button>
                      </Show>
                      <Button
                        variant="secondary"
                        disabled={!canPrepare()}
                        onClick={() => void props.controller.prepare({ action: "forget", id: entry.id })}
                      >
                        Preview forgetting entry
                      </Button>
                    </div>
                    <Show when={props.state.reopening?.id === entry.id}>
                      <section aria-label="Reopen this outcome" class="space-y-3 rounded-lg border p-3">
                        <p>
                          Explain why you want to reconsider this approved outcome. Confirmation will move it back to
                          awaiting approval.
                        </p>
                        <label class="block space-y-1">
                          <span class="text-sm">Your reason for reopening</span>
                          <textarea
                            aria-label="Reason to reopen outcome"
                            class="w-full rounded border bg-transparent p-2 text-sm"
                            rows={3}
                            maxLength={ReviewMemoryControl.LIMIT.reason}
                            readOnly={!canPrepare()}
                            value={props.state.reopening?.reason ?? ""}
                            onInput={(event) => props.controller.editReopen(event.currentTarget.value)}
                          />
                        </label>
                        <div class="flex gap-2">
                          <Button
                            disabled={!canPrepare() || !props.state.reopening?.reason.trim()}
                            onClick={() => void props.controller.prepareReopen()}
                          >
                            Preview reopening outcome
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={!canPrepare()}
                            onClick={() => props.controller.cancelReopen()}
                          >
                            Cancel reopening
                          </Button>
                        </div>
                      </section>
                    </Show>
                  </article>
                )}
              </For>
            </div>
            <div class="flex gap-2">
              <Button
                variant="secondary"
                disabled={!!props.state.busy || props.state.offset === 0}
                onClick={() =>
                  void props.controller.refresh(Math.max(0, props.state.offset - ReviewMemoryControl.LIMIT.page))
                }
              >
                Previous page
              </Button>
              <Button
                variant="secondary"
                disabled={
                  !!props.state.busy ||
                  read().state.entries.length < ReviewMemoryControl.LIMIT.page ||
                  props.state.offset + ReviewMemoryControl.LIMIT.page > ReviewMemoryControl.LIMIT.records
                }
                onClick={() => void props.controller.refresh(props.state.offset + ReviewMemoryControl.LIMIT.page)}
              >
                Next page
              </Button>
            </div>
          </>
        )}
      </Show>
      <Show when={preview()}>
        {(value) => (
          <section aria-label="Exact memory change preview" class="space-y-3 rounded-lg border p-4">
            <h3 class="font-semibold">Review this exact change</h3>
            <p class="text-sm">
              Selected local repository: <code>{props.directory}</code>
            </p>
            <details class="text-xs">
              <summary>Approval details</summary>
              <p>
                Repository: <code>{value().repository}</code>
              </p>
              <p>Generation: {value().expected}</p>
              <p class="break-all">
                Approval digest: <code>{value().sha256}</code>
              </p>
            </details>
            <Show when={configure()}>
              {(current) => (
                <p>
                  {current().payload.enabled
                    ? "Allow approved entries from this repository in supported reviews. Stored entries are not included in reviews yet."
                    : "Disallow use of stored entries in reviews. Stored entries remain available to manage. Stored entries are not included in reviews yet."}
                </p>
              )}
            </Show>
            <Show when={record()}>
              {(current) => (
                <>
                  <p>
                    New owner {current().payload.kind}.{" "}
                    {current().payload.visibility === "private"
                      ? "Store privately, excluded from supported reviews."
                      : "Store as an approved repository entry. Stored entries are not included in reviews yet."}
                  </p>
                  <EntryText entry={current().payload} />
                </>
              )}
            </Show>
            <Show when={approve()}>
              {(current) => (
                <>
                  <p>
                    Approve this complete proposed outcome for use in supported reviews when allowed by your repository
                    setting. Stored entries are not included in reviews yet.
                  </p>
                  <EntryText entry={current().payload.entry} />
                </>
              )}
            </Show>
            <Show when={reopen()}>
              {(current) => (
                <>
                  <section aria-label="Original approved outcome" class="space-y-3">
                    <h3 class="font-medium">Original approved outcome</h3>
                    <EntryText entry={current().payload.entry} />
                    <details class="space-y-1 text-xs">
                      <summary>Original approval details</summary>
                      <p>
                        Entry: <code>{current().payload.entry.id}</code>
                      </p>
                      <p>Kind: {current().payload.entry.kind}</p>
                      <p>Origin: {current().payload.entry.origin}</p>
                      <p>Status: {current().payload.entry.status}</p>
                      <p>Visibility: {current().payload.entry.visibility}</p>
                      <p>
                        Approved by: <code>{current().payload.entry.approvedBy}</code>
                      </p>
                      <p>
                        Approved at: <code>{current().payload.entry.approvedAt}</code>
                      </p>
                      <p>
                        Created at: <code>{current().payload.entry.createdAt}</code>
                      </p>
                      <p>
                        Updated at: <code>{current().payload.entry.updatedAt}</code>
                      </p>
                    </details>
                  </section>
                  <section aria-label="New human reason" class="space-y-2">
                    <h3 class="font-medium">Your reason for reopening</h3>
                    <p class="whitespace-pre-wrap break-words">{current().payload.reason}</p>
                  </section>
                  <p>
                    Confirmation removes approval from this same outcome. It must be approved again to be eligible for
                    supported reviews when review use is allowed. Stored entries are not included in reviews yet. Your
                    reason replaces its stored reason; the earlier reason is shown here for this confirmation.
                  </p>
                </>
              )}
            </Show>
            <Show when={forget()}>
              <p>Forget this stored entry.</p>
              <Show when={forgotten()}>{(entry) => <EntryText entry={entry()} />}</Show>
            </Show>
            <Show when={value().operation === "erase"}>
              <p>
                Erase this repository’s stored review preferences, checks and outcomes. This does not erase ordinary
                chat memory.
              </p>
            </Show>
            <label class="flex items-start gap-2">
              <input
                type="checkbox"
                aria-label="I reviewed this exact memory change"
                checked={props.state.approved}
                disabled={!!props.state.busy}
                onChange={(event) => props.controller.approve(event.currentTarget.checked)}
              />
              I reviewed this exact memory change.
            </label>
            <div class="flex gap-2">
              <Button
                disabled={!props.state.approved || !!props.state.busy}
                onClick={() => void props.controller.confirm()}
              >
                Confirm this change
              </Button>
              <Button variant="secondary" disabled={!!props.state.busy} onClick={() => void props.controller.discard()}>
                Discard preview
              </Button>
            </div>
          </section>
        )}
      </Show>
      <Show when={props.state.retry}>
        <section aria-label="Uncertain memory confirmation" class="space-y-3 rounded-lg border p-4">
          <p>
            The earlier change may have completed. Reading the current state does not identify which request changed it.
            A retry uses the same approval and cannot create a fresh change.
          </p>
          <label class="flex items-start gap-2">
            <input
              type="checkbox"
              aria-label="Retry only the change I already approved"
              checked={props.state.retryApproved}
              disabled={!!props.state.busy}
              onChange={(event) => props.controller.approveRetry(event.currentTarget.checked)}
            />
            Retry only the change I already approved.
          </label>
          <Button
            disabled={!props.state.retryApproved || !!props.state.busy}
            onClick={() => void props.controller.retry()}
          >
            Retry same confirmation
          </Button>
        </section>
      </Show>
    </section>
  )
}
