import type { MemorySettings, MemorySkillDetail, VectorClient } from "@vectordevai/sdk/v2/client"
import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { holdLabel } from "./memory-model"
import {
  BADGE_TITLES,
  DRAFTERS,
  LEARNING,
  SKILLS,
  badges,
  expiry,
  fared,
  idle,
  lastUsed,
  sections,
  shareable,
  sharePath,
  undoable,
  versionLabel,
  weight,
  why,
  type SkillEntryView,
  type SkillInfo,
} from "./memory-skills-model"

type Act = (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => Promise<boolean>

// Settings > Memory > Skills (section 12): the skills Vector drafted after a run turned a failing check green. Drafts
// wait here for the owner, with why they were drafted and what they hold; skills in use show how their loads fared,
// their versions and Undo; Share writes one for the team. Every change goes through the owner's skill routes, which
// check an edit as they check a draft. Steps, checks, commands and the failure excerpt are shown as plain text only.
export function SettingsMemorySkills(props: {
  client: () => VectorClient | undefined
  repository: boolean
  settings?: MemorySettings
  onSettings: (settings: MemorySettings) => void
}) {
  const [version, setVersion] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [error, setError] = createSignal("")
  const [list] = createResource(
    () => {
      const current = props.client()
      if (!current || !props.repository) return false
      return { client: current, version: version() }
    },
    (input) => input.client.memory.skills.list({ filter: "all" }).then((result) => result.data),
  )
  const groups = createMemo(() => sections((list.latest?.skills ?? []) as readonly SkillEntryView[]))
  const act: Act = async (run, done) => {
    const current = props.client()
    if (!current) return false
    const result = await run(current).catch((cause: unknown) => ({ error: cause }))
    if (result.error) {
      setNotice("")
      setError(errorMessage(result.error))
      return false
    }
    setError("")
    setNotice(done)
    setVersion((value) => value + 1)
    return true
  }
  const configure = (
    change: { skills?: MemorySettings["skills"]; skillDrafter?: MemorySettings["skillDrafter"] },
    done: string,
  ) =>
    act(
      (current) =>
        current.memory.settings.update(change).then((result) => {
          if (result.data) props.onSettings(result.data)
          return result
        }),
      done,
    )

  return (
    <>
      <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-skills">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Learned skills</h3>
            <p class="settings-v2-card-description">{SKILLS.intro}</p>
            <p class="settings-v2-card-description">
              {SKILLS.draft} {SKILLS.guests} {SKILLS.shares}
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">How Vector learns skills</div>
              <div class="settings-v2-row-description">
                Review first waits for your click. Apply automatically puts a draft in use only after a second matching
                success in another session, and never replaces a skill you approved or edited.
              </div>
            </div>
            <div class="settings-v2-row-control settings-v2-row-control--compact">
              <select
                class="settings-memory-kind"
                aria-label="How Vector learns skills"
                value={props.settings?.skills ?? "review"}
                onChange={(event) => {
                  const skills = event.currentTarget.value as MemorySettings["skills"]
                  void configure(
                    { skills },
                    skills === "off"
                      ? "Vector will not draft skills."
                      : skills === "auto"
                        ? "A draft goes live after a second matching success."
                        : "Drafts wait for your review.",
                  )
                }}
              >
                <For each={LEARNING}>{(item) => <option value={item.value}>{item.label}</option>}</For>
              </select>
            </div>
          </div>
          <div class="settings-v2-row-modern">
            <div class="settings-v2-row-copy">
              <div class="settings-v2-row-title">Let a model word drafts</div>
              <div class="settings-v2-row-description">{SKILLS.privacy}</div>
            </div>
            <div class="settings-v2-row-control settings-v2-row-control--compact">
              <select
                class="settings-memory-kind"
                aria-label="When a model may word a skill's draft"
                value={props.settings?.skillDrafter ?? "local-only"}
                onChange={(event) => {
                  const skillDrafter = event.currentTarget.value as MemorySettings["skillDrafter"]
                  void configure(
                    { skillDrafter },
                    skillDrafter === "off"
                      ? "Vector drafts skills with its rules only."
                      : skillDrafter === "always"
                        ? "A model may word drafts with any model you use."
                        : "A model words drafts only with Vector Local on.",
                  )
                }}
              >
                <For each={DRAFTERS}>{(item) => <option value={item.value}>{item.label}</option>}</For>
              </select>
            </div>
          </div>
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
        </div>
      </div>

      <Show
        when={props.repository}
        fallback={
          <div class="settings-v2-card settings-v2-card--wide">
            <p class="settings-memory-empty">Open a repository to see the skills Vector learned in it.</p>
          </div>
        }
      >
        <SkillSection
          title="Needs review"
          description="Drafts wait for you. Tidying drops one after 60 days."
          empty="No skill waits for your review."
          entries={groups().review}
          client={props.client}
          act={act}
          version={version()}
        />
        <SkillSection
          title="In use"
          description={`The agent may load these when they bear on a request. ${SKILLS.commands}`}
          empty={list.loading ? "Reading skills…" : "No learned skill is in use here yet."}
          entries={groups().inUse}
          client={props.client}
          act={act}
          version={version()}
        />
        <SkillSection
          title="Archived and shared"
          description={SKILLS.team}
          empty="Nothing archived or shared."
          entries={groups().archived}
          client={props.client}
          act={act}
          version={version()}
        />
      </Show>
    </>
  )
}

function SkillSection(props: {
  title: string
  description: string
  empty: string
  entries: readonly SkillEntryView[]
  client: () => VectorClient | undefined
  act: Act
  version: number
}) {
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-skill-section">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{props.title}</h3>
          <p class="settings-v2-card-description">{props.description}</p>
        </div>
      </div>
      <div class="settings-memory-list">
        <Show when={props.entries.length > 0} fallback={<p class="settings-memory-empty">{props.empty}</p>}>
          <For each={props.entries}>
            {(entry) => (
              <Show when={entry.skill}>
                {(skill) => (
                  <SkillRow
                    entry={entry}
                    skill={skill()}
                    client={props.client}
                    act={props.act}
                    version={props.version}
                  />
                )}
              </Show>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

function SkillRow(props: {
  entry: SkillEntryView
  skill: SkillInfo
  client: () => VectorClient | undefined
  act: Act
  version: number
}) {
  const [open, setOpen] = createSignal<"versions" | "edit" | "share" | "forget">()
  const [description, setDescription] = createSignal("")
  const [procedure, setProcedure] = createSignal("")
  const waiting = () => props.entry.status === "proposed" || props.entry.status === "quarantined"
  const id = () => props.entry.id
  // The runs behind a draft and every version, read once per change of the list.
  const [detail] = createResource(
    () => {
      const current = props.client()
      if (!current) return false
      return { client: current, id: id(), version: props.version }
    },
    (input) =>
      input.client.memory.skills
        .get({ memoryID: input.id }, { throwOnError: false })
        .then((result) => result.data)
        .catch(() => undefined),
  )
  const loaded = (): MemorySkillDetail | undefined =>
    detail.state === "ready" || detail.state === "refreshing" ? detail.latest : undefined
  const runs = createMemo(() => (loaded()?.evidence ?? []).filter((item) => item.type === "run"))
  const update = (change: Omit<Parameters<VectorClient["memory"]["skills"]["update"]>[0], "memoryID">, done: string) =>
    props.act((current) => current.memory.skills.update({ ...change, memoryID: id() }), done)

  return (
    <article
      class="settings-memory-row"
      classList={{ "is-waiting": waiting(), "is-off": !waiting() && props.entry.status !== "active" }}
      data-component="settings-memory-skill"
    >
      <div class="settings-memory-row-head">
        <span class="settings-memory-kind-badge" data-kind="skill">
          Learned skill
        </span>
        <span class="settings-memory-tag">v{props.skill.version}</span>
        <For each={badges(props.skill, props.entry)}>
          {(badge) => (
            <span class="settings-memory-tag settings-memory-tag--warn" title={BADGE_TITLES[badge]}>
              {badge}
            </span>
          )}
        </For>
        <Show when={props.entry.private}>
          <span class="settings-memory-tag">Private</span>
        </Show>
        <Show when={props.skill.sharedPath}>
          {(file) => <span class="settings-memory-tag">Shared to {file()}</span>}
        </Show>
        <span class="settings-memory-id">{props.skill.name}</span>
      </div>
      <p class="settings-memory-text">{props.skill.description}</p>

      <Show when={waiting()}>
        <p class="settings-memory-meta">
          {why({
            check: props.skill.checks[0],
            sessions: new Set(runs().flatMap((item) => (item.sessionID ? [item.sessionID] : []))).size,
            lastAt: runs().at(-1)?.createdAt ?? props.entry.updatedAt,
          })}{" "}
          · {expiry(props.entry)}
        </p>
        <Show when={props.entry.hold}>
          <p class="settings-memory-hold">{holdLabel(props.entry.hold, "agent")}</p>
        </Show>
      </Show>
      <Show when={props.skill.instructionLikeFailure}>
        <p class="settings-memory-hold">{SKILLS.instructionLike}. It cannot go live on its own.</p>
      </Show>
      <Show when={props.entry.status === "active"}>
        <div class="settings-memory-progress" title={`Proven ${weight(props.skill.proven)}%`}>
          <span style={{ width: `${weight(props.skill.proven)}%` }} />
        </div>
        <p class="settings-memory-meta">
          {fared(props.skill.uses)} · {lastUsed(props.entry)}
        </p>
      </Show>

      <details class="settings-memory-skill-body">
        <summary>Steps, checks and commands</summary>
        <pre class="settings-memory-pre">{props.skill.procedure}</pre>
        <p class="settings-memory-meta">Checks</p>
        <pre class="settings-memory-pre">{props.skill.checks.join("\n") || "none"}</pre>
        <p class="settings-memory-meta">Commands</p>
        <pre class="settings-memory-pre">{props.skill.commands.join("\n") || "none"}</pre>
        <Show when={props.skill.failure}>
          {(failure) => (
            <>
              <p class="settings-memory-meta">What failed last time (never shared)</p>
              <pre class="settings-memory-pre">{failure()}</pre>
            </>
          )}
        </Show>
      </details>

      <Show when={open() === "edit"}>
        <textarea
          class="settings-memory-edit"
          aria-label="Edit the skill's description"
          maxlength={200}
          value={description()}
          onInput={(event) => setDescription(event.currentTarget.value)}
        />
        <textarea
          class="settings-memory-edit settings-memory-edit--tall"
          aria-label="Edit the skill's steps"
          maxlength={4000}
          value={procedure()}
          onInput={(event) => setProcedure(event.currentTarget.value)}
        />
      </Show>
      <Show when={open() === "versions"}>
        <ul class="settings-memory-versions">
          <For each={loaded()?.versions ?? []}>
            {(item) => (
              <li>
                <span>{versionLabel(item, props.skill.version)}</span>
                <Show when={item.version !== props.skill.version}>
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    icon="reset"
                    onClick={() =>
                      update(
                        { action: "rollback", version: item.version },
                        `Restored version ${item.version} as a new version.`,
                      )
                    }
                  >
                    Restore
                  </ButtonV2>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={open() === "share"}>
        <SharePanel
          entry={props.entry}
          skill={props.skill}
          act={props.act}
          client={props.client}
          onDone={() => setOpen(undefined)}
        />
      </Show>

      <div class="settings-memory-actions">
        <Show when={open() === "edit"}>
          <ButtonV2
            size="small"
            disabled={!description().trim() || !procedure().trim()}
            onClick={async () => {
              if (
                await update(
                  { description: description(), procedure: procedure() },
                  "Saved your edit as a new version.",
                )
              )
                setOpen(undefined)
            }}
          >
            Save
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setOpen(undefined)}>
            Cancel
          </ButtonV2>
        </Show>
        <Show when={open() === "forget"}>
          <span class="settings-memory-confirm">
            Forget every version of this skill? Vector will not draft it again.
          </span>
          <ButtonV2
            size="small"
            variant="danger"
            onClick={() => props.act((current) => current.memory.skills.forget({ memoryID: id() }), "Forgotten.")}
          >
            Forget
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setOpen(undefined)}>
            Cancel
          </ButtonV2>
        </Show>
        <Show when={open() !== "edit" && open() !== "forget"}>
          <Show when={waiting()}>
            <ButtonV2
              size="small"
              variant="outline"
              icon="check"
              onClick={() => update({ action: "approve" }, "Approved. The agent may load it.")}
            >
              Approve
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => update({ action: "reject" }, "Rejected. Vector will not draft it again.")}
            >
              Reject
            </ButtonV2>
          </Show>
          <Show when={waiting() || props.entry.status === "active"}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="edit"
              onClick={() => {
                setDescription(props.skill.description)
                setProcedure(props.skill.procedure)
                setOpen("edit")
              }}
            >
              Edit
            </ButtonV2>
          </Show>
          <Show when={props.entry.status === "active"}>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => setOpen(open() === "versions" ? undefined : "versions")}
            >
              Versions
            </ButtonV2>
            <Show when={undoable(props.entry)}>
              <ButtonV2
                size="small"
                variant="ghost"
                icon="reset"
                onClick={() =>
                  update({ action: "undo" }, "Undone. The version it replaced is back, or Vector will not draft it.")
                }
              >
                Undo latest version
              </ButtonV2>
            </Show>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="archive"
              onClick={() => update({ action: "archive" }, "Archived. Restore it any time.")}
            >
              Archive
            </ButtonV2>
            <Show when={shareable(props.entry)}>
              <ButtonV2 size="small" variant="ghost" onClick={() => setOpen("share")}>
                Share to repository…
              </ButtonV2>
            </Show>
          </Show>
          <Show when={props.entry.status === "archived" || props.entry.status === "superseded"}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="reset"
              onClick={() => update({ action: "restore" }, "Restored.")}
            >
              Restore
            </ButtonV2>
          </Show>
          <Show when={!waiting()}>
            <ButtonV2 size="small" variant="ghost" onClick={() => setOpen("forget")}>
              Forget
            </ButtonV2>
          </Show>
        </Show>
      </div>
    </article>
  )
}

// Share to repository: the path and the file as it will be written, then the write. The server words the file, so what
// shows is byte for byte what it writes, or the refusal it would give. The directory reloads for the new settings once
// none of its sessions is busy, never in the middle of one.
function SharePanel(props: {
  entry: SkillEntryView
  skill: SkillInfo
  act: Act
  client: () => VectorClient | undefined
  onDone: () => void
}) {
  const [force, setForce] = createSignal(false)
  const [file] = createResource(
    () => {
      const current = props.client()
      return current ? { client: current, id: props.entry.id } : false
    },
    (input) =>
      input.client.memory.skills.sharePreview({ memoryID: input.id }).then(
        (result) =>
          result.data
            ? { text: result.data.text, exists: result.data.exists }
            : { refused: errorMessage(result.error) },
        (cause: unknown) => ({ refused: errorMessage(cause) }),
      ),
  )
  return (
    <div class="settings-memory-erase" data-component="settings-memory-skill-share">
      <p>
        Vector writes <code>{sharePath(props.skill.name)}</code> for you to commit. {SKILLS.share}
      </p>
      <Show when={file()} fallback={<p class="settings-memory-meta">Reading the file Share writes…</p>}>
        {(current) => {
          const shown = current()
          return "refused" in shown ? (
            <p class="settings-memory-meta" role="alert">
              {shown.refused}
            </p>
          ) : (
            <pre class="settings-memory-pre">{shown.text}</pre>
          )
        }}
      </Show>
      <label class="settings-memory-meta">
        <input type="checkbox" checked={force()} onChange={(event) => setForce(event.currentTarget.checked)} /> Replace
        the file if it is already there
      </label>
      <div class="settings-v2-action-grid">
        <ButtonV2
          variant="outline"
          onClick={async () => {
            const shared = await props.act(
              (current) => current.memory.skills.share({ memoryID: props.entry.id, force: force() }),
              `Wrote ${sharePath(props.skill.name)}. ${SKILLS.shared}`,
            )
            const current = props.client()
            if (shared && current) void reloadWhenIdle(current)
            if (shared) props.onDone()
          }}
        >
          Share
        </ButtonV2>
        <ButtonV2 variant="ghost" onClick={props.onDone}>
          Cancel
        </ButtonV2>
      </div>
    </div>
  )
}

const reloading = new WeakSet<VectorClient>()

// Reloads the directory once no session in it is at work, so the new settings ask for trust without cutting a run
// short. It outlives the page, since the owner may close Settings while a session runs.
async function reloadWhenIdle(client: VectorClient) {
  if (reloading.has(client)) return
  reloading.add(client)
  for (;;) {
    const statuses = await client.session
      .status()
      .then((result) => result.data)
      .catch(() => undefined)
    if (statuses && idle(statuses)) break
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  await client.instance.dispose().catch(() => undefined)
  reloading.delete(client)
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: unknown } }).data
    if (typeof data?.message === "string") return data.message
  }
  if (error instanceof Error) return error.message
  return "Vector could not change the skill. Try again in a moment."
}
