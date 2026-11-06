import type { MemoryImportResult, MemorySettings, VectorClient } from "@vectordevai/sdk/v2/client"
import { For, Index, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { getFilename } from "@vectordevai/core/util/path"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { LocalMemoryPanel } from "@/features/memory/local-memory-panel"
import { Markdown } from "@vectordevai/session-ui/markdown"
import { CITE_PREFIX, HELD, reportMarkdown, size, statusLabel } from "@/features/research/research-model"
import { SettingsMemoryDocuments } from "./memory-documents"
import { SettingsMemorySearchModel } from "./memory-search-model"
import { downloadResearch, type ReportFormat } from "@/features/research/report-download"
import {
  ABOUT,
  ERASE_SESSION,
  FACETS,
  MEMORY_FILTERS,
  MEMORY_KINDS,
  MEMORY_TABS,
  MODEL_LEARNER,
  RECENT,
  UNDO_DAYS,
  aboutYou,
  approvable,
  approvableImports,
  cameFrom,
  editable,
  entryText,
  exportName,
  facetOf,
  fileLabel,
  forgettable,
  holdLabel,
  importNotice,
  kindLabel,
  learnedWhen,
  originLabel,
  pinnable,
  rejectable,
  savedNotice,
  summary,
  undoable,
  UNDONE,
  usage,
  type AboutGroup,
  type MemoryEntryView,
  type MemoryFacet,
  type MemoryFiles,
  type MemoryFilter,
  type MemoryTab,
} from "./memory-model"
import "./settings-memory.css"
import "@/features/research/research.css"

type Scope = "repository" | "personal"

const PRIVATE =
  "Kept from guests and from models that may train on prompts: it was learned from a private document, or it names someone or something from what you typed."

// Settings > Memory: one place for what steers Vector. Rules people wrote and the user's MEMORY.md are shown as they
// are read (and changed in their files); what Vector learned is listed with where it came from, and can be searched,
// edited, pinned, approved, put away or forgotten. It replaces the Local memory card in General and the old rules page.
export function SettingsMemoryV2(props: { repositoryPath?: string; sessionDirectory?: string; tab?: MemoryTab }) {
  const global = useGlobal()
  const server = useServer()
  const directory = () => props.sessionDirectory ?? props.repositoryPath
  const [tab, setTab] = createSignal<MemoryTab>(props.tab ?? "memory")
  const [scope, setScope] = createSignal<Scope>(directory() ? "repository" : "personal")
  const [filter, setFilter] = createSignal<MemoryFilter>("active")
  const [query, setQuery] = createSignal("")
  const [search, setSearch] = createSignal("")
  const [version, setVersion] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [error, setError] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  const client = createMemo((): VectorClient | undefined => {
    const conn = server.current
    if (!conn) return undefined
    const sdk = global.ensureServerCtx(conn).sdk
    const dir = directory()
    return sdk.createClient(dir ? { directory: dir } : {})
  })

  const [list] = createResource(
    () => {
      const current = client()
      if (!current) return false
      return { client: current, scope: scope(), filter: filter(), query: search(), version: version() }
    },
    (input) =>
      input.client.memory
        .list({ scope: input.scope, filter: input.filter, ...(input.query ? { query: input.query } : {}) })
        .then((result) => result.data),
  )
  // What Vector put in use on its own, in this repository and about the user, newest first.
  const [learned] = createResource(
    () => {
      const current = client()
      if (!current) return false
      return { client: current, version: version() }
    },
    (input) => input.client.memory.list({ filter: "learned" }).then((result) => result.data),
  )
  const [settings, { mutate: setSettings }] = createResource(
    () => client() ?? false,
    (current) => current.memory.settings.get().then((result) => result.data),
  )

  const refresh = () => setVersion((value) => value + 1)
  const say = (message: string) => {
    setError("")
    setNotice(message)
  }
  // Every change goes through the engine, which applies the same checks to the user's edits as to the agent's. What
  // the page says afterwards can depend on what the engine answered.
  const act = async <T,>(
    run: (current: VectorClient) => Promise<{ error?: unknown; data?: T }>,
    done: string | ((data: T | undefined) => string),
  ) => {
    const current = client()
    if (!current) return
    const result = await run(current).catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (result.error) {
      setNotice("")
      setError(errorMessage(result.error))
      return
    }
    say(typeof done === "string" ? done : done(result.data))
    refresh()
  }

  const entries = (): readonly MemoryEntryView[] => list.latest?.entries ?? []
  const files = (): MemoryFiles | undefined => list.latest?.files

  return (
    <section class="settings-v2-page settings-memory">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Memory</p>
          <h2 class="settings-v2-page-title">What Vector remembers</h2>
          <p class="settings-v2-page-subtitle">
            The rules you and your team wrote, what you told Vector about yourself, what it learned while working, and
            the documents you gave it. All of it stays on this computer. A request carries your rules and only the
            memory that bears on it, so memory saves tokens instead of adding them, and a greeting carries none.
          </p>
        </div>
      </div>

      <div class="settings-memory-segments settings-memory-tabs" role="tablist" aria-label="Memory sections">
        <For each={MEMORY_TABS}>
          {(item) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab() === item.value}
              classList={{ "is-active": tab() === item.value }}
              data-tab={item.value}
              onClick={() => setTab(item.value)}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>

      <Show when={tab() === "documents"}>
        <SettingsMemoryDocuments client={client} repository={!!directory()} onModel={() => setTab("model")} />
      </Show>

      <Show when={tab() === "research"}>
        <ResearchRuns client={client} repository={!!directory()} />
      </Show>

      <Show when={tab() === "about"}>
        <AboutYou
          client={client}
          repository={!!directory()}
          settings={settings.latest}
          onSettings={(next) => setSettings(next)}
        />
      </Show>

      <Show when={tab() === "model"}>
        <SettingsMemorySearchModel client={client} />
      </Show>

      <Show when={tab() === "memory"}>
        <div class="settings-v2-card settings-v2-card--wide">
          <div class="settings-v2-card-head">
            <div class="settings-v2-card-copy">
              <h3 class="settings-v2-card-title">
                {scope() === "repository" ? getFilename(directory() ?? "") || "This repository" : "Your memory"}
              </h3>
              <p class="settings-v2-card-description">
                <Show when={list.latest} fallback={list.loading ? "Reading memory…" : "Memory is not available."}>
                  {(current) => <>{summary(current().stats)}</>}
                </Show>
              </p>
            </div>
          </div>
          <div class="settings-v2-card-body">
            <div class="settings-v2-row-modern">
              <div class="settings-v2-row-copy">
                <div class="settings-v2-row-title">Let Vector learn as it works</div>
                <div class="settings-v2-row-description">
                  Vector saves a short lesson, decision or preference as it works, when you state one, when a fix makes
                  a failing check pass, or when a lasting decision is made, and uses it from the next request. Each one
                  is listed under Recently learned, where one click undoes it. It never writes rules: only you do. What
                  it learns in a session that read web pages or other outside content, ran MCP tools, or had a guest or
                  a subagent in it waits for your review instead. {ABOUT.agents}
                </div>
              </div>
              <div class="settings-v2-row-control settings-v2-row-control--compact">
                <Switch
                  checked={settings.latest?.learning ?? true}
                  onChange={(learning) => {
                    setSettings((current) => current && { ...current, learning })
                    void act(
                      (current) => current.memory.settings.update({ learning }),
                      learning ? "Vector will learn as it works." : "Vector will not add to its memory.",
                    )
                  }}
                />
              </div>
            </div>
            <Show when={list.latest?.held}>
              <p class="settings-memory-warning">
                This repository has settings you have not trusted, so memory it ships (its BRAIN.md) waits for review.
                Trust it in Repository trust to use that memory.
              </p>
            </Show>
          </div>
        </div>

        <RecentlyLearned entries={learned.latest?.entries ?? []} act={act} />

        <div class="settings-v2-card settings-v2-card--wide">
          <div class="settings-memory-toolbar">
            <div class="settings-memory-segments" role="tablist" aria-label="Whose memory">
              <Show when={directory()}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope() === "repository"}
                  classList={{ "is-active": scope() === "repository" }}
                  onClick={() => setScope("repository")}
                >
                  This repository
                </button>
              </Show>
              <button
                type="button"
                role="tab"
                aria-selected={scope() === "personal"}
                classList={{ "is-active": scope() === "personal" }}
                onClick={() => setScope("personal")}
              >
                Every repository
              </button>
            </div>
            <div class="settings-memory-segments" role="tablist" aria-label="Which entries">
              <For each={MEMORY_FILTERS}>
                {(item) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={filter() === item.value}
                    classList={{ "is-active": filter() === item.value }}
                    onClick={() => setFilter(item.value)}
                  >
                    {item.label}
                    <Show when={item.value === "review" && (list.latest?.stats.review ?? 0) > 0}>
                      <span class="settings-memory-count">{list.latest?.stats.review}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <input
              class="settings-memory-search"
              type="search"
              placeholder="Search memory"
              aria-label="Search memory"
              value={query()}
              onInput={(event) => {
                const value = event.currentTarget.value
                setQuery(value)
                clearTimeout(timer)
                timer = setTimeout(() => setSearch(value.trim()), 200)
              }}
            />
          </div>

          <AddMemory
            scope={scope()}
            onAdd={(input) =>
              act(
                (current) => current.memory.create({ ...input, scope: scope() }),
                (entry) => (entry ? savedNotice(entry, input.text) : "Saved. Vector will use it when it is relevant."),
              )
            }
          />

          <Show when={notice()}>
            <p class="settings-memory-notice" role="status">
              {notice()}
            </p>
          </Show>
          <Show when={error()}>
            <p class="settings-memory-error" role="alert">
              {error()}
            </p>
          </Show>

          <div class="settings-memory-list">
            <Show
              when={entries().length > 0}
              fallback={
                <p class="settings-memory-empty">
                  {filter() === "review"
                    ? "Nothing waits for your review."
                    : search()
                      ? "Nothing in memory matches."
                      : scope() === "repository"
                        ? "Nothing remembered for this repository yet. Rules in .vector/RULES.md and what Vector learns here show up in this list."
                        : "Nothing remembered about you yet. Add a preference above, or write it in your memory file below."}
                </p>
              }
            >
              <For each={entries()}>
                {(entry) => <MemoryRow entry={entry} files={files()} root={directory()} act={act} />}
              </For>
            </Show>
          </div>
        </div>

        <Show when={scope() === "personal"}>
          <LocalMemoryPanel />
        </Show>

        <TransferCard
          client={client}
          repository={!!directory()}
          scope={scope()}
          onImported={() => {
            setFilter("review")
            refresh()
          }}
        />

        <EraseCard scope={scope()} repository={!!directory()} act={act} />
      </Show>
    </section>
  )
}

function RecentlyLearned(props: {
  entries: readonly MemoryEntryView[]
  act: (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => Promise<void>
}) {
  const [all, setAll] = createSignal(false)
  const shown = () => (all() ? props.entries : props.entries.slice(0, RECENT))
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-learned">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">Recently learned</h3>
          <p class="settings-v2-card-description">
            What Vector put in use on its own, newest first. Undo takes one back, and Vector does not learn it again.
          </p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <Show
          when={props.entries.length > 0}
          fallback={<p class="settings-memory-empty">Vector has not learned anything on its own yet.</p>}
        >
          <div class="settings-memory-list">
            <For each={shown()}>
              {(entry) => (
                <article class="settings-memory-row" data-component="settings-memory-learned-entry">
                  <div class="settings-memory-row-head">
                    <span class="settings-memory-kind-badge" data-kind={entry.kind}>
                      {kindLabel(entry.kind)}
                    </span>
                    <Show when={entry.scope === "personal"}>
                      <span class="settings-memory-tag">Every repository</span>
                    </Show>
                    <Show when={entry.private}>
                      <span class="settings-memory-tag" title={PRIVATE}>
                        Private
                      </span>
                    </Show>
                    <span class="settings-memory-id">{entry.id}</span>
                  </div>
                  <p class="settings-memory-text">{entryText(entry)}</p>
                  <div class="settings-memory-actions">
                    <ButtonV2
                      size="small"
                      variant="ghost"
                      icon="reset"
                      onClick={() =>
                        props.act((current) => current.memory.update({ memoryID: entry.id, action: "undo" }), UNDONE)
                      }
                    >
                      Undo
                    </ButtonV2>
                  </div>
                </article>
              )}
            </For>
          </div>
          <Show when={props.entries.length > shown().length}>
            <ButtonV2 size="small" variant="ghost" onClick={() => setAll(true)}>
              Show all {props.entries.length}
            </ButtonV2>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function AddMemory(props: {
  scope: Scope
  onAdd: (input: { kind: "preference" | "decision" | "lesson" | "fact"; text: string }) => Promise<void>
}) {
  const [text, setText] = createSignal("")
  const [kind, setKind] = createSignal<"preference" | "decision" | "lesson" | "fact">("lesson")
  const [busy, setBusy] = createSignal(false)
  const submit = async () => {
    if (!text().trim() || busy()) return
    setBusy(true)
    await props.onAdd({ kind: props.scope === "personal" ? "preference" : kind(), text: text().trim() })
    setBusy(false)
    setText("")
  }
  return (
    <form
      class="settings-memory-add"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Show when={props.scope === "repository"}>
        <select
          class="settings-memory-kind"
          aria-label="Kind of memory"
          value={kind()}
          onChange={(event) => setKind(event.currentTarget.value as "preference" | "decision" | "lesson" | "fact")}
        >
          <For each={MEMORY_KINDS}>{(item) => <option value={item.value}>{item.label}</option>}</For>
        </select>
      </Show>
      <input
        class="settings-memory-input"
        placeholder={
          props.scope === "personal"
            ? "Something about how you work, for every repository"
            : "Something Vector should remember about this repository"
        }
        aria-label="New memory"
        maxlength={1000}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <ButtonV2 type="submit" variant="outline" icon="plus" disabled={busy() || !text().trim()}>
        Remember
      </ButtonV2>
    </form>
  )
}

function MemoryRow(props: {
  entry: MemoryEntryView
  files?: MemoryFiles
  root?: string
  act: (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => Promise<void>
}) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [confirming, setConfirming] = createSignal(false)
  const id = () => props.entry.id
  const update = (
    change: { text?: string; pinned?: boolean; action?: "approve" | "reject" | "archive" | "restore" },
    done: string,
  ) => props.act((current) => current.memory.update({ memoryID: id(), ...change }), done)
  const waiting = () => props.entry.status === "proposed" || props.entry.status === "quarantined"

  return (
    <article
      class="settings-memory-row"
      classList={{
        "is-waiting": waiting(),
        "is-off": props.entry.status === "archived" || props.entry.status === "superseded",
      }}
      data-component="settings-memory-entry"
    >
      <div class="settings-memory-row-head">
        <span class="settings-memory-kind-badge" data-kind={props.entry.kind}>
          {kindLabel(props.entry.kind)}
        </span>
        <Show when={props.entry.pinned}>
          <span class="settings-memory-tag">Pinned</span>
        </Show>
        <Show when={props.entry.scope === "personal"}>
          <span class="settings-memory-tag">Every repository</span>
        </Show>
        <Show when={props.entry.private}>
          <span class="settings-memory-tag" title={PRIVATE}>
            Private
          </span>
        </Show>
        <Show when={props.entry.stale}>
          <span class="settings-memory-tag settings-memory-tag--warn">Its cited code changed</span>
        </Show>
        <span class="settings-memory-id">{props.entry.id}</span>
      </div>

      <Show when={editing()} fallback={<p class="settings-memory-text">{entryText(props.entry)}</p>}>
        <textarea
          class="settings-memory-edit"
          aria-label="Edit memory"
          maxlength={1000}
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
      </Show>

      <p class="settings-memory-meta">
        {originLabel(props.entry, props.files)}
        <Show when={props.entry.paths.length > 0 && props.entry.kind !== "rule"}>
          {" "}
          · about {props.entry.paths.slice(0, 3).join(", ")}
        </Show>
        <Show when={props.entry.kind === "review"}> · only code reviews read this</Show> · {usage(props.entry)}
      </p>
      <Show when={waiting()}>
        <p class="settings-memory-hold">{holdLabel(props.entry.hold, props.entry.origin)}</p>
      </Show>

      <div class="settings-memory-actions">
        <Show when={editing()}>
          <ButtonV2
            size="small"
            disabled={!draft().trim()}
            onClick={async () => {
              await update({ text: draft() }, "Saved your edit.")
              setEditing(false)
            }}
          >
            Save
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </ButtonV2>
        </Show>
        <Show when={!editing() && !confirming()}>
          <Show when={approvable(props.entry)}>
            <ButtonV2
              size="small"
              variant="outline"
              icon="check"
              onClick={() => update({ action: "approve" }, "Approved. Vector will use it.")}
            >
              Approve
            </ButtonV2>
          </Show>
          <Show when={rejectable(props.entry)}>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => update({ action: "reject" }, "Rejected and forgotten.")}
            >
              Reject
            </ButtonV2>
          </Show>
          <Show when={pinnable(props.entry)}>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() =>
                update(
                  { pinned: !props.entry.pinned },
                  props.entry.pinned ? "Unpinned." : "Pinned: it now goes with every request.",
                )
              }
            >
              {props.entry.pinned ? "Unpin" : "Pin"}
            </ButtonV2>
          </Show>
          <Show when={editable(props.entry)}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="edit"
              onClick={() => {
                setDraft(props.entry.text)
                setEditing(true)
              }}
            >
              Edit
            </ButtonV2>
          </Show>
          <Show when={editable(props.entry) && props.entry.status === "active"}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="archive"
              onClick={() => update({ action: "archive" }, "Archived. Restore it any time.")}
            >
              Archive
            </ButtonV2>
          </Show>
          <Show
            when={editable(props.entry) && (props.entry.status === "archived" || props.entry.status === "superseded")}
          >
            <ButtonV2
              size="small"
              variant="ghost"
              icon="reset"
              onClick={() => update({ action: "restore" }, "Restored.")}
            >
              Restore
            </ButtonV2>
          </Show>
          <Show when={forgettable(props.entry)}>
            <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(true)}>
              Forget
            </ButtonV2>
          </Show>
          <Show when={!editable(props.entry) && props.entry.origin === "file"}>
            <span class="settings-memory-file-hint">
              Change it in{" "}
              {props.entry.source ? fileLabel(props.entry.source.file, props.files, props.root) : "its file"}
            </span>
          </Show>
        </Show>
        <Show when={confirming()}>
          <span class="settings-memory-confirm">Forget this for good? Vector will not learn it again.</span>
          <ButtonV2
            size="small"
            variant="danger"
            onClick={async () => {
              await props.act((current) => current.memory.remove({ memoryID: id() }), "Forgotten.")
              setConfirming(false)
            }}
          >
            Forget
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </ButtonV2>
        </Show>
      </div>
    </article>
  )
}

function EraseCard(props: {
  scope: Scope
  repository: boolean
  act: (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => Promise<void>
}) {
  const [confirming, setConfirming] = createSignal<"repository" | "personal" | "all" | "research" | undefined>()
  const what = (scope: "repository" | "personal" | "all" | "research") =>
    scope === "research"
      ? "all research in this repository: every run's pages, notes and reports"
      : scope === "all"
        ? "everything Vector learned, in every repository and about you, and every Deep research run"
        : scope === "personal"
          ? "everything Vector learned about you"
          : "everything Vector learned in this repository, its failure memory and Deep research runs included"
  return (
    <div class="settings-v2-card settings-v2-card--wide">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">Tidy and erase</h3>
          <p class="settings-v2-card-description">
            Vector tidies its memory on its own every few hours, with no model call: it merges duplicates, archives what
            goes unused, and drops what waited for your review for 30 days. Erasing never touches files you or your team
            wrote.
          </p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <Show
          when={confirming()}
          fallback={
            <div class="settings-v2-action-grid">
              <ButtonV2
                variant="outline"
                onClick={() =>
                  props.act(
                    (current) => current.memory.tidy(),
                    "Tidied: duplicates merged and unused entries archived.",
                  )
                }
              >
                Tidy now
              </ButtonV2>
              <Show when={props.repository}>
                <ButtonV2 variant="outline" onClick={() => setConfirming("repository")}>
                  Erase what Vector learned here
                </ButtonV2>
                <ButtonV2 variant="outline" onClick={() => setConfirming("research")}>
                  Erase all research in this repository
                </ButtonV2>
              </Show>
              <ButtonV2 variant="outline" onClick={() => setConfirming("personal")}>
                Erase what Vector learned about you
              </ButtonV2>
              <ButtonV2 variant="danger" onClick={() => setConfirming("all")}>
                Erase all learned memory
              </ButtonV2>
            </div>
          }
        >
          {(scope) => (
            <div class="settings-memory-erase">
              <p>
                This erases {what(scope())}. Vector cannot restore it. {ABOUT.erase}
              </p>
              <div class="settings-v2-action-grid">
                <ButtonV2
                  variant="danger"
                  onClick={async () => {
                    const chosen = scope()
                    await props.act(
                      (current) =>
                        chosen === "research"
                          ? current.memory.research.forgetAll()
                          : current.memory.erase({ scope: chosen }),
                      "Erased.",
                    )
                    setConfirming(undefined)
                  }}
                >
                  Erase
                </ButtonV2>
                <ButtonV2 variant="ghost" onClick={() => setConfirming(undefined)}>
                  Cancel
                </ButtonV2>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

// Settings > Memory > Research (section 6.5): the runs this repository's brain keeps, with Open, Keep, Export and
// Forget, and Forget for a single source. A run nobody keeps is deleted after `retain` days.
function ResearchRuns(props: { client: () => VectorClient | undefined; repository: boolean }) {
  const [version, setVersion] = createSignal(0)
  const [open, setOpen] = createSignal<string>()
  const [confirming, setConfirming] = createSignal<string>()
  const [notice, setNotice] = createSignal("")
  const [list] = createResource(
    () => {
      const current = props.client()
      if (!current || !props.repository) return false
      return { client: current, version: version() }
    },
    (input) => input.client.memory.research.list().then((result) => result.data),
  )
  const act = async (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => {
    const current = props.client()
    if (!current) return
    const result = await run(current).catch((cause: unknown) => ({ error: cause }))
    setNotice(result.error ? errorMessage(result.error) : done)
    if (!result.error) setVersion((value) => value + 1)
  }
  const download = async (runID: string, question: string, created: number, format: ReportFormat) => {
    const current = props.client()
    if (!current) return
    await downloadResearch(current, { runID, question, created, format }).then(
      () => setNotice("Exported the research."),
      (cause: unknown) => setNotice(errorMessage(cause)),
    )
  }

  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-research">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">Research</h3>
          <p class="settings-v2-card-description">
            Deep research runs this repository's brain keeps: each question, the pages read and the notes and report
            written from them. {HELD} Runs you do not keep are deleted after {list.latest?.retain ?? 30} days.
            <Show when={list.latest}>
              {(current) => (
                <>
                  {" "}
                  Research here takes {size(current().bytes)} of the {size(current().limit)} it may keep; past that, the
                  oldest runs you did not keep go first.
                </>
              )}
            </Show>
          </p>
        </div>
      </div>
      <Show when={notice()}>
        <p class="settings-memory-notice" role="status">
          {notice()}
        </p>
      </Show>
      <div class="settings-memory-list">
        <Show
          when={props.repository && (list.latest?.runs.length ?? 0) > 0}
          fallback={
            <p class="settings-memory-empty">
              {!props.repository
                ? "Open a repository to see its research."
                : list.loading
                  ? "Reading research…"
                  : "No research in this repository yet. Pick Deep research in the composer's Mode menu to start one."}
            </p>
          }
        >
          <For each={list.latest?.runs}>
            {(item) => (
              <article class="settings-memory-row" data-component="settings-memory-research-run">
                <div class="settings-memory-row-head">
                  <span class="settings-memory-tag">{item.run.depth === "deep" ? "Deep" : "Focused"}</span>
                  <span class="settings-memory-tag">{item.run.kept ? "Kept" : "Not kept"}</span>
                  <span class="settings-memory-id">{item.run.id}</span>
                </div>
                <p class="settings-memory-text">{item.run.question}</p>
                <p class="settings-memory-meta">
                  {new Date(item.run.created_at).toLocaleDateString()} · {item.sources} source
                  {item.sources === 1 ? "" : "s"} · {item.notes} note{item.notes === 1 ? "" : "s"} · {size(item.bytes)}
                </p>
                <div class="settings-memory-actions">
                  <Show
                    when={confirming() === item.run.id}
                    fallback={
                      <>
                        <ButtonV2
                          size="small"
                          variant="outline"
                          onClick={() => setOpen((id) => (id === item.run.id ? undefined : item.run.id))}
                        >
                          {open() === item.run.id ? "Close" : "Open the report"}
                        </ButtonV2>
                        <Show when={!item.run.kept}>
                          <ButtonV2
                            size="small"
                            variant="ghost"
                            onClick={() =>
                              act(
                                (current) => current.memory.research.keep({ runID: item.run.id }),
                                "Kept: the report is used like your other private documents.",
                              )
                            }
                          >
                            Keep
                          </ButtonV2>
                        </Show>
                        <ButtonV2
                          size="small"
                          variant="ghost"
                          onClick={() => download(item.run.id, item.run.question, item.run.created_at, "markdown")}
                        >
                          Export Markdown
                        </ButtonV2>
                        <ButtonV2
                          size="small"
                          variant="ghost"
                          onClick={() => download(item.run.id, item.run.question, item.run.created_at, "json")}
                        >
                          Export JSON
                        </ButtonV2>
                        <ButtonV2
                          size="small"
                          variant="ghost"
                          onClick={() => download(item.run.id, item.run.question, item.run.created_at, "docx")}
                        >
                          Export Word
                        </ButtonV2>
                        <ButtonV2
                          size="small"
                          variant="ghost"
                          onClick={() => download(item.run.id, item.run.question, item.run.created_at, "pdf")}
                        >
                          Export PDF
                        </ButtonV2>
                        <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(item.run.id)}>
                          Forget
                        </ButtonV2>
                      </>
                    }
                  >
                    <span class="settings-memory-meta">Forget this run's report, pages and notes?</span>
                    <ButtonV2
                      size="small"
                      variant="danger"
                      onClick={async () => {
                        setConfirming(undefined)
                        await act(
                          (current) => current.memory.research.forget({ runID: item.run.id }),
                          "Forgot the research.",
                        )
                      }}
                    >
                      Forget
                    </ButtonV2>
                    <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(undefined)}>
                      Cancel
                    </ButtonV2>
                  </Show>
                </div>
                <Show when={open() === item.run.id}>
                  <ResearchRunDetail client={props.client} runID={item.run.id} version={version()} act={act} />
                </Show>
              </article>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

function ResearchRunDetail(props: {
  client: () => VectorClient | undefined
  runID: string
  version: number
  act: (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => Promise<void>
}) {
  const [detail] = createResource(
    () => {
      const current = props.client()
      if (!current) return false
      return { client: current, runID: props.runID, version: props.version }
    },
    (input) => input.client.memory.research.get({ runID: input.runID }).then((result) => result.data),
  )
  return (
    <div class="settings-memory-research-detail">
      <Show when={detail.latest?.report} fallback={<p class="settings-memory-meta">No report saved for this run.</p>}>
        {(report) => (
          <div
            onClick={(event) => {
              // A citation opens its source in the session's Sources tab; here it only shows its quote on hover.
              if (event.target instanceof Element && event.target.closest(`a[href^="${CITE_PREFIX}"]`))
                event.preventDefault()
            }}
          >
            <Markdown text={reportMarkdown(report())} cacheKey={`settings-research:${props.runID}`} />
          </div>
        )}
      </Show>
      <For each={detail.latest?.sources}>
        {(source) => (
          <p class="settings-memory-meta">
            {source.id} · {source.title || source.url} · {source.site} · {statusLabel(source)}{" "}
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() =>
                props.act(
                  (current) => current.memory.research.forgetSource({ runID: props.runID, sourceID: source.id }),
                  `Forgot ${source.id}. Notes that quoted it say so.`,
                )
              }
            >
              Forget source
            </ButtonV2>
          </p>
        )}
      </For>
    </div>
  )
}

type Act = <T>(
  run: (current: VectorClient) => Promise<{ error?: unknown; data?: T }>,
  done: string | ((data: T | undefined) => string),
) => Promise<void>

// Settings > Memory > About you (section 6.5): what Vector learned about how the user works, grouped by facet, each
// with the words it came from and the session it was learned in. Undo in its first week, then Forget; a switch per
// kind for "Don't learn this kind". The routes are the owner's, so a guest is told whose it is.
function AboutYou(props: {
  client: () => VectorClient | undefined
  repository: boolean
  settings?: MemorySettings
  /** The settings the engine answered with, for the page's other sections. */
  onSettings: (settings: MemorySettings) => void
}) {
  const [version, setVersion] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [error, setError] = createSignal("")
  const [all, setAll] = createSignal<Record<string, boolean>>({})
  const [erasing, setErasing] = createSignal(false)
  const [list] = createResource(
    () => {
      const current = props.client()
      if (!current) return false
      return { client: current, version: version() }
    },
    (input) =>
      input.client.memory
        .list({ scope: "personal", filter: "all" }, { throwOnError: false })
        .then((result) => ({
          entries: result.data?.entries ?? [],
          status: result.response?.status ?? 0,
          failed: result.error !== undefined || !result.data,
        }))
        .catch(() => ({ entries: [], status: 0, failed: true })),
  )
  // Read only once resolved, so a first read still loading suspends nothing around the page.
  const loaded = () => (list.state === "ready" || list.state === "refreshing" ? list.latest : undefined)
  const guest = () => loaded()?.status === 401 || loaded()?.status === 403
  // A read that failed for another reason says so, rather than showing every kind as empty.
  const failed = () => loaded()?.failed === true && !guest()
  // An entry that did not change keeps its row, so reading the list again neither redraws nor re-reads it.
  const kept = new Map<string, { json: string; entry: MemoryEntryView }>()
  const stable = (entry: MemoryEntryView) => {
    const json = JSON.stringify(entry)
    const previous = kept.get(entry.id)
    if (previous?.json === json) return previous.entry
    kept.set(entry.id, { json, entry })
    return entry
  }
  const groups = createMemo(() => aboutYou(((loaded()?.entries ?? []) as readonly MemoryEntryView[]).map(stable)))
  // Each item's evidence, read once per version of the item.
  const evidence = new Map<string, Promise<readonly { type: string; quote?: string; sessionID?: string }[]>>()
  const evidenceOf = (entry: MemoryEntryView) => {
    const key = `${entry.id}:${entry.updatedAt}`
    const current = props.client()
    const found = evidence.get(key)
    if (found || !current) return found ?? Promise.resolve([])
    const read = current.memory
      .get({ memoryID: entry.id }, { throwOnError: false })
      .then((result) => result.data?.evidence ?? [])
      .catch(() => [])
    evidence.set(key, read)
    return read
  }
  const act: Act = async (run, done) => {
    const current = props.client()
    if (!current) return
    const result = await run(current).catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (result.error) {
      setNotice("")
      setError(errorMessage(result.error))
      return
    }
    setError("")
    setNotice(typeof done === "string" ? done : done(result.data))
    setVersion((value) => value + 1)
  }
  const shown = (group: AboutGroup) => (all()[group.value] ? group.entries : group.entries.slice(0, RECENT))
  // A kind turned off, or when a model may help, as the engine keeps it; the page shows what it answered.
  const configure = (
    change: { facets?: Partial<Record<MemoryFacet, boolean>>; modelLearner?: MemorySettings["modelLearner"] },
    done: string,
  ) => {
    const before = props.settings
    if (before) props.onSettings({ ...before, ...change, facets: { ...before.facets, ...change.facets } })
    return act(
      (current) =>
        current.memory.settings.update(change).then((result) => {
          // What the engine kept, or, refused, what was there before.
          if (result.data) props.onSettings(result.data)
          if (result.error && before) props.onSettings(before)
          return result
        }),
      done,
    )
  }

  return (
    <>
      <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-about">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">{ABOUT.title}</h3>
            <p class="settings-v2-card-description">{ABOUT.intro}</p>
            <p class="settings-v2-card-description">
              {ABOUT.sensitive} {ABOUT.agents}
            </p>
            <p class="settings-v2-card-description">{ABOUT.storage}</p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          {/* The owner's setting: a guest is told whose this is and can change none of it. */}
          <Show when={loaded() && !guest()}>
            <div class="settings-v2-row-modern">
              <div class="settings-v2-row-copy">
                <div class="settings-v2-row-title">Let a model help Vector learn</div>
                <div class="settings-v2-row-description">
                  Vector learns from your own words with plain rules, at no cost and with no model call. When you
                  correct it ("no, I meant…") and the rules find nothing to keep, a small model can suggest what to
                  learn from your typed words. Its tokens count in that session, and what it suggests after a session
                  read outside content waits for your review. With Vector Local only, it runs on the model servers you
                  list.
                </div>
              </div>
              <div class="settings-v2-row-control settings-v2-row-control--compact">
                <select
                  class="settings-memory-kind"
                  aria-label="When a model may help Vector learn"
                  value={props.settings?.modelLearner ?? "local-only"}
                  onChange={(event) => {
                    const modelLearner = event.currentTarget.value as MemorySettings["modelLearner"]
                    void configure(
                      { modelLearner },
                      modelLearner === "off"
                        ? "Vector learns from your words with its rules only."
                        : modelLearner === "always"
                          ? "A model may help Vector learn with any model you use."
                          : "A model helps Vector learn only with Vector Local on.",
                    )
                  }}
                >
                  <For each={MODEL_LEARNER}>{(item) => <option value={item.value}>{item.label}</option>}</For>
                </select>
              </div>
            </div>
          </Show>
          <Show when={notice()}>
            <p class="settings-memory-notice" role="status">
              {notice()}
            </p>
          </Show>
          <Show when={error()}>
            <p class="settings-memory-error" role="alert">
              {error()}
            </p>
          </Show>
          <Show when={guest()}>
            <p class="settings-memory-empty">{ABOUT.guest}</p>
          </Show>
          <Show when={failed()}>
            <p class="settings-memory-error" role="alert">
              {ABOUT.failed}
            </p>
            <div class="settings-v2-action-grid">
              <ButtonV2 variant="outline" onClick={() => setVersion((value) => value + 1)}>
                Try again
              </ButtonV2>
            </div>
          </Show>
        </div>
      </div>

      <Show when={!guest()}>
        <Index each={failed() ? [] : groups()}>
          {(group) => {
            // The groups keep their order, so each place in the list is always the same facet.
            const facet = group().value === "other" ? undefined : (group().value as MemoryFacet)
            const on = () => (facet ? (props.settings?.facets[facet] ?? true) : true)
            return (
              <div
                class="settings-v2-card settings-v2-card--wide"
                data-component="settings-memory-facet"
                data-facet={group().value}
              >
                <div class="settings-v2-card-head settings-memory-facet-head">
                  <div class="settings-v2-card-copy">
                    <h3 class="settings-v2-card-title">{group().label}</h3>
                    <p class="settings-v2-card-description">{group().description}</p>
                  </div>
                  <Show when={facet}>
                    {(value) => (
                      <div class="settings-v2-row-control settings-v2-row-control--compact">
                        <Switch
                          checked={on()}
                          hideLabel
                          onChange={(checked) =>
                            void configure(
                              { facets: { [value()]: checked } },
                              checked
                                ? `Vector will learn ${group().label.toLowerCase()} again.`
                                : `Vector will not learn ${group().label.toLowerCase()}.`,
                            )
                          }
                        >
                          Learn {group().label.toLowerCase()}
                        </Switch>
                      </div>
                    )}
                  </Show>
                </div>
                <Show when={!on()}>
                  <p class="settings-memory-hold settings-memory-pad">{ABOUT.off}</p>
                </Show>
                <div class="settings-memory-list">
                  <Show
                    when={group().entries.length > 0}
                    fallback={
                      <p class="settings-memory-empty">
                        {loaded() ? "Nothing of this kind yet." : "Reading what Vector learned…"}
                      </p>
                    }
                  >
                    <For each={shown(group())}>
                      {(entry) => <AboutRow entry={entry} evidence={evidenceOf} act={act} />}
                    </For>
                    <Show when={group().entries.length > shown(group()).length}>
                      <ButtonV2
                        size="small"
                        variant="ghost"
                        onClick={() => setAll((current) => ({ ...current, [group().value]: true }))}
                      >
                        Show all {group().entries.length}
                      </ButtonV2>
                    </Show>
                  </Show>
                </div>
              </div>
            )
          }}
        </Index>

        <TransferCard
          client={props.client}
          repository={props.repository}
          scope="personal"
          onImported={() => setVersion((value) => value + 1)}
        />

        <div class="settings-v2-card settings-v2-card--wide">
          <div class="settings-v2-card-head">
            <div class="settings-v2-card-copy">
              <h3 class="settings-v2-card-title">Erase what Vector learned about you</h3>
              <p class="settings-v2-card-description">{ABOUT.erase}</p>
            </div>
          </div>
          <div class="settings-v2-card-body">
            <Show
              when={erasing()}
              fallback={
                <div class="settings-v2-action-grid">
                  <ButtonV2 variant="outline" onClick={() => setErasing(true)}>
                    Erase what Vector learned about you
                  </ButtonV2>
                </div>
              }
            >
              <div class="settings-memory-erase">
                <p>This erases everything Vector learned about you, in every repository. Vector cannot restore it.</p>
                <div class="settings-v2-action-grid">
                  <ButtonV2
                    variant="danger"
                    onClick={async () => {
                      await act((current) => current.memory.erase({ scope: "personal" }), "Erased.")
                      setErasing(false)
                    }}
                  >
                    Erase
                  </ButtonV2>
                  <ButtonV2 variant="ghost" onClick={() => setErasing(false)}>
                    Cancel
                  </ButtonV2>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </>
  )
}

function AboutRow(props: {
  entry: MemoryEntryView
  evidence: (entry: MemoryEntryView) => Promise<readonly { type: string; quote?: string; sessionID?: string }[]>
  act: Act
}) {
  const server = useServer()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [confirming, setConfirming] = createSignal<"forget" | "session">()
  // The words it came from and the session it was learned in.
  const [detail] = createResource(() => props.entry, props.evidence)
  const from = createMemo(() =>
    cameFrom(props.entry, detail.state === "ready" || detail.state === "refreshing" ? (detail.latest ?? []) : []),
  )
  const waiting = () => props.entry.status === "proposed" || props.entry.status === "quarantined"
  const update = (
    change: { text?: string; facet?: MemoryFacet; action?: "approve" | "reject" | "undo" },
    done: string,
  ) => props.act((current) => current.memory.update({ memoryID: props.entry.id, ...change }), done)
  const open = (sessionID: string) => {
    if (dialog.active) dialog.close()
    navigate(sessionHref(server.key, sessionID))
  }

  return (
    <article
      class="settings-memory-row"
      classList={{ "is-waiting": waiting() }}
      data-component="settings-memory-about-entry"
    >
      <div class="settings-memory-row-head">
        <span class="settings-memory-kind-badge" data-kind={props.entry.kind}>
          {kindLabel(props.entry.kind)}
        </span>
        <Show when={props.entry.pinned}>
          <span class="settings-memory-tag">Pinned</span>
        </Show>
        <Show when={props.entry.private}>
          <span class="settings-memory-tag" title={PRIVATE}>
            Private
          </span>
        </Show>
        <span class="settings-memory-id">{props.entry.id}</span>
      </div>

      <Show when={editing()} fallback={<p class="settings-memory-text">{entryText(props.entry)}</p>}>
        <textarea
          class="settings-memory-edit"
          aria-label="Edit memory"
          maxlength={1000}
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
      </Show>
      <Show when={from().quote}>{(quote) => <p class="settings-memory-quote">From your words: "{quote()}"</p>}</Show>
      <p class="settings-memory-meta">
        {learnedWhen(props.entry)} · {usage(props.entry)}
        <Show when={from().sessionID}>
          {(sessionID) => (
            <>
              {" · "}
              <button type="button" class="settings-memory-link" onClick={() => open(sessionID())}>
                Open the session it came from
              </button>
              <Show when={props.entry.origin === "agent" && !confirming()}>
                {" · "}
                <button type="button" class="settings-memory-link" onClick={() => setConfirming("session")}>
                  {ERASE_SESSION.there}
                </button>
              </Show>
            </>
          )}
        </Show>
      </p>
      <Show when={waiting()}>
        <p class="settings-memory-hold">{holdLabel(props.entry.hold, props.entry.origin)}</p>
      </Show>

      <div class="settings-memory-actions">
        <Show when={editing()}>
          <ButtonV2
            size="small"
            disabled={!draft().trim()}
            onClick={async () => {
              await update({ text: draft() }, "Saved your edit.")
              setEditing(false)
            }}
          >
            Save
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </ButtonV2>
        </Show>
        <Show when={!editing() && !confirming()}>
          <Show when={approvable(props.entry)}>
            <ButtonV2
              size="small"
              variant="outline"
              icon="check"
              onClick={() => update({ action: "approve" }, "Approved. Vector will use it.")}
            >
              Approve
            </ButtonV2>
          </Show>
          <Show when={rejectable(props.entry)}>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => update({ action: "reject" }, "Rejected and forgotten.")}
            >
              Reject
            </ButtonV2>
          </Show>
          <Show when={undoable(props.entry)}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="reset"
              title={`Undo is offered for ${UNDO_DAYS} days after Vector learns something.`}
              onClick={() => update({ action: "undo" }, UNDONE)}
            >
              Undo
            </ButtonV2>
          </Show>
          <Show when={editable(props.entry)}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="edit"
              onClick={() => {
                setDraft(props.entry.text)
                setEditing(true)
              }}
            >
              Edit
            </ButtonV2>
          </Show>
          <Show when={props.entry.kind === "preference" || props.entry.kind === "term"}>
            <select
              class="settings-memory-kind"
              aria-label="What it is about"
              value={facetOf(props.entry) ?? "style"}
              onChange={(event) => {
                const facet = event.currentTarget.value as MemoryFacet
                const label = FACETS.find((item) => item.value === facet)?.label ?? facet
                void update({ facet }, `Moved to ${label}.`)
              }}
            >
              <For each={FACETS}>{(item) => <option value={item.value}>{item.label}</option>}</For>
            </select>
          </Show>
          <Show when={forgettable(props.entry)}>
            <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming("forget")}>
              Forget
            </ButtonV2>
          </Show>
        </Show>
        <Show when={confirming() === "forget"}>
          <span class="settings-memory-confirm">Forget this for good? Vector will not learn it again.</span>
          <ButtonV2
            size="small"
            variant="danger"
            onClick={async () => {
              await props.act((current) => current.memory.remove({ memoryID: props.entry.id }), "Forgotten.")
              setConfirming(undefined)
            }}
          >
            Forget
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(undefined)}>
            Cancel
          </ButtonV2>
        </Show>
        <Show when={confirming() === "session" ? from().sessionID : undefined}>
          {(sessionID) => (
            <>
              <span class="settings-memory-confirm">{ERASE_SESSION.confirm}</span>
              <ButtonV2
                size="small"
                variant="danger"
                onClick={async () => {
                  await props.act(
                    (current) => current.memory.eraseSession({ sessionID: sessionID() }),
                    (count) => ERASE_SESSION.done(count ?? 0),
                  )
                  setConfirming(undefined)
                }}
              >
                Erase
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(undefined)}>
                Cancel
              </ButtonV2>
            </>
          )}
        </Show>
      </div>
    </article>
  )
}

/** The most an import may be (the engine's IMPORT_CHARS). */
const IMPORT_CHARS = 2 * 1024 * 1024
const TOO_LONG = "Vector imports at most 2 MB at a time."

// Export and Import (section 6.5): what Vector keeps as Markdown to read or JSON to import elsewhere, and an export read
// back in, where every item waits for approval, so a changed file cannot put memory in use. "Approve all" is one click
// for the items held for nothing else; one held as an instruction or for hidden characters stays for its own review.
function TransferCard(props: {
  client: () => VectorClient | undefined
  repository: boolean
  scope: "personal" | "repository"
  onImported: () => void
}) {
  const [scope, setScope] = createSignal<"personal" | "repository" | "all">()
  const [notice, setNotice] = createSignal("")
  const [imported, setImported] = createSignal<MemoryImportResult>()
  const [busy, setBusy] = createSignal(false)
  const chosen = () => scope() ?? props.scope
  const waiting = createMemo(() => approvableImports(imported()?.entries ?? []))

  const download = async (format: "markdown" | "json") => {
    const current = props.client()
    if (!current) return
    const result = await current.memory.export({ scope: chosen(), format }).catch(() => undefined)
    const body = result?.data as unknown
    if (body === undefined || body === null || result?.error) {
      setNotice("Vector could not export its memory. Try again in a moment.")
      return
    }
    const text = typeof body === "string" ? body : JSON.stringify(body, null, 2)
    const url = URL.createObjectURL(
      new Blob([text], { type: format === "json" ? "application/json" : "text/markdown" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = exportName(chosen(), format)
    link.click()
    URL.revokeObjectURL(url)
    setNotice(`Exported as ${link.download}.`)
  }

  const read = async (file: File | undefined) => {
    const current = props.client()
    if (!file || !current) return
    // A character takes at most 4 bytes, so a file larger than that is too long before a byte of it is read.
    if (file.size > IMPORT_CHARS * 4) return setNotice(TOO_LONG)
    const text = await file.text().catch(() => undefined)
    if (text === undefined) return setNotice("Vector could not read that file.")
    if (text.length > IMPORT_CHARS) return setNotice(TOO_LONG)
    setBusy(true)
    const result = await current.memory.import({ text }).catch((cause: unknown) => ({ error: cause, data: undefined }))
    setBusy(false)
    if (result.error || !result.data) {
      setImported(undefined)
      setNotice(errorMessage(result.error))
      return
    }
    setImported(result.data)
    setNotice(importNotice(result.data))
    props.onImported()
  }

  const approveAll = async () => {
    const current = props.client()
    const items = waiting()
    if (!current || items.length === 0) return
    setBusy(true)
    // A few at a time: one import brings in at most 500.
    const results = await Array.from({ length: Math.ceil(items.length / 8) }, (_, index) =>
      items.slice(index * 8, index * 8 + 8),
    ).reduce(
      (chain, batch) =>
        chain.then(async (done) => [
          ...done,
          ...(await Promise.all(
            batch.map((entry) =>
              current.memory
                .update({ memoryID: entry.id, action: "approve" })
                .then((result) => !result.error)
                .catch(() => false),
            ),
          )),
        ]),
      Promise.resolve([] as boolean[]),
    )
    setBusy(false)
    const approved = results.filter(Boolean).length
    setImported(undefined)
    setNotice(
      approved === items.length
        ? `Approved ${approved}. Vector uses them now.`
        : `Approved ${approved} of ${items.length}. The rest still wait in Needs review.`,
    )
    props.onImported()
  }

  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-transfer">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">Export and import</h3>
          <p class="settings-v2-card-description">
            Export what Vector keeps as Markdown to read, or as JSON to import on another computer. Never the files of
            your documents. {IMPORTED_COPY}
          </p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <div class="settings-v2-action-grid">
          <select
            class="settings-memory-kind"
            aria-label="What to export"
            value={chosen()}
            onChange={(event) => setScope(event.currentTarget.value as "personal" | "repository" | "all")}
          >
            <option value="personal">About you</option>
            <Show when={props.repository}>
              <option value="repository">This repository</option>
              <option value="all">Both</option>
            </Show>
          </select>
          <ButtonV2 variant="outline" onClick={() => void download("markdown")}>
            Export as Markdown
          </ButtonV2>
          <ButtonV2 variant="outline" onClick={() => void download("json")}>
            Export as JSON
          </ButtonV2>
          <label class="settings-memory-file">
            <input
              type="file"
              class="sr-only"
              accept=".md,.markdown,.json,.txt,text/markdown,application/json,text/plain"
              aria-label="Import memory from a file"
              disabled={busy()}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ""
                void read(file)
              }}
            />
            <span>{busy() ? "Importing…" : "Import a file…"}</span>
          </label>
        </div>
        <Show when={notice()}>
          <p class="settings-memory-notice" role="status">
            {notice()}
          </p>
        </Show>
        <Show when={waiting().length > 0}>
          <div class="settings-v2-action-grid">
            <ButtonV2 variant="outline" icon="check" disabled={busy()} onClick={() => void approveAll()}>
              Approve all {waiting().length}
            </ButtonV2>
          </div>
        </Show>
      </div>
    </div>
  )
}

const IMPORTED_COPY =
  "What you import waits for your approval, so a changed file cannot put memory in use, and what you forgot is not imported again."

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: unknown } }).data
    if (typeof data?.message === "string") return data.message
  }
  if (error instanceof Error) return error.message
  return "Vector could not change its memory. Try again in a moment."
}
