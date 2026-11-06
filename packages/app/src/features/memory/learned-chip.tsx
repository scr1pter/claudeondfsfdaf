import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import type { AssistantMessage, MemoryEntry } from "@vectordevai/sdk/v2/client"
import { ReplyFooter } from "@vectordevai/session-ui/message-part"
import { Icon } from "@vectordevai/ui/icon"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { ERASE_SESSION, UNDONE, entryText } from "@/components/settings-v2/memory-model"
import { SKILL_ID, chipLabel, learnedFrom, watchLearned } from "./learned"
import "./learned-chip.css"

/** Draws what Vector learned from a request under the reply that answered it. */
export function registerLearnedChip() {
  ReplyFooter.register(LearnedChip)
}

type Action = "undo" | "approve" | "reject"
type Done = "undone" | "approved" | "rejected" | `failed-${Action}`

/**
 * "Learned 2 things" under a reply: what Vector's learner kept from the request's typed words, or from what the user
 * ticked on the reply's plan card, and a skill it drafted from the run. Opened, it lists each item with Undo, or
 * Approve and Reject for one waiting for review, and offers to erase what Vector learned in this session. Each entry is
 * read from the owner's memory routes, a skill from the skill routes; one they refuse (a guest) or that is gone shows
 * nothing.
 */
function LearnedChip(props: { message: AssistantMessage }) {
  const sdk = useSDK()
  const sync = useSync()
  createEffect(() => watchLearned(sdk().event))
  const [open, setOpen] = createSignal(false)
  const [version, setVersion] = createSignal(0)
  const [done, setDone] = createSignal<Record<string, Done>>({})
  const [erasing, setErasing] = createSignal<"confirm" | "busy">()
  const [notice, setNotice] = createSignal("")

  // A request's learning is filed under the request; a plan card's under the reply that showed it, one of the turn's.
  const replies = createMemo(() =>
    (sync().data.message?.[props.message.sessionID] ?? []).flatMap((message) =>
      message.role === "assistant" && message.parentID === props.message.parentID ? [message.id] : [],
    ),
  )
  const ids = createMemo(() => learnedFrom(props.message.sessionID, [props.message.parentID, ...replies()]))
  const typed = createMemo(() => new Set(learnedFrom(props.message.sessionID, [props.message.parentID])))

  const [entries] = createResource(
    () => (ids().length > 0 ? { ids: ids(), version: version(), client: sdk().client } : false),
    (input) =>
      Promise.all(
        input.ids.map((memoryID) => {
          // A learned skill is read from its own route.
          const read: Promise<{ data?: { entry: MemoryEntry } }> = SKILL_ID.test(memoryID)
            ? input.client.memory.skills.get({ memoryID }, { throwOnError: false })
            : input.client.memory.get({ memoryID }, { throwOnError: false })
          return read.then((result) => result.data?.entry).catch(() => undefined)
        }),
      ).then((found) => found.filter((entry): entry is MemoryEntry => entry !== undefined)),
  )
  // Read only once resolved: reading a resource still loading for the first time suspends the whole timeline.
  const items = createMemo(() =>
    entries.state === "ready" || entries.state === "refreshing" ? (entries.latest ?? []) : [],
  )
  const label = createMemo(() =>
    chipLabel(
      items().map((entry) => ({
        text: entry.skill?.name ?? entryText(entry),
        status: entry.status,
        typed: typed().has(entry.id),
        skill: entry.skill !== undefined,
      })),
    ),
  )

  const act = async (entry: MemoryEntry, action: Action) => {
    const client = sdk().client
    // A learned skill changes only through its own routes.
    const change: Promise<unknown> = entry.skill
      ? client.memory.skills.update({ memoryID: entry.id, action })
      : client.memory.update({ memoryID: entry.id, action })
    const result = await change.then(
      (): Done => (action === "undo" ? "undone" : action === "approve" ? "approved" : "rejected"),
      (): Done => `failed-${action}`,
    )
    setDone((current) => ({ ...current, [entry.id]: result }))
  }

  const erase = async () => {
    setErasing("busy")
    const count = await sdk()
      .client.memory.eraseSession({ sessionID: props.message.sessionID })
      .then((result) => result.data ?? 0)
      .catch(() => undefined)
    setErasing(undefined)
    setNotice(
      count === undefined
        ? "Vector could not erase what it learned. Try again in a moment."
        : ERASE_SESSION.done(count),
    )
    if (count !== undefined) setVersion((value) => value + 1)
  }

  return (
    <Show when={items().length > 0 || notice()}>
      <div data-component="learned-chip" data-open={open() ? "" : undefined}>
        <Show when={items().length > 0}>
          <div data-slot="learned-chip-row">
            <button
              type="button"
              data-slot="learned-chip-trigger"
              aria-expanded={open()}
              title={label()}
              onClick={() => setOpen((value) => !value)}
            >
              <Icon name="brain" size="small" />
              <span data-slot="learned-chip-label">{label()}</span>
            </button>
            <Show when={!open() && items().length === 1 ? items()[0] : undefined}>
              {(entry) => <Actions entry={entry()} done={done()[entry().id]} act={act} />}
            </Show>
          </div>
        </Show>
        <Show when={open()}>
          <ul data-slot="learned-chip-items">
            <For each={items()}>
              {(entry) => (
                <li data-slot="learned-chip-item">
                  <p data-slot="learned-chip-text">
                    {entry.skill ? `${entry.skill.name}: ${entry.skill.description}` : entryText(entry)}
                  </p>
                  <p data-slot="learned-chip-meta">
                    {entry.skill
                      ? "A skill drafted from how this run turned a failing check green"
                      : typed().has(entry.id)
                        ? "From what you typed"
                        : "From what you ticked on the plan card"}
                    {entry.scope === "personal" ? " · every repository" : " · this repository"}
                  </p>
                  <Actions entry={entry} done={done()[entry.id]} act={act} />
                </li>
              )}
            </For>
          </ul>
          <div data-slot="learned-chip-erase">
            <Show
              when={erasing()}
              fallback={
                <ButtonV2 size="small" variant="ghost" onClick={() => setErasing("confirm")}>
                  {ERASE_SESSION.action}
                </ButtonV2>
              }
            >
              <p data-slot="learned-chip-meta">{ERASE_SESSION.confirm}</p>
              <ButtonV2 size="small" variant="danger" disabled={erasing() === "busy"} onClick={() => void erase()}>
                Erase
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" onClick={() => setErasing(undefined)}>
                Cancel
              </ButtonV2>
            </Show>
          </div>
        </Show>
        <Show when={notice()}>
          <p data-slot="learned-chip-notice" role="status">
            {notice()}
          </p>
        </Show>
      </div>
    </Show>
  )
}

function Actions(props: {
  entry: MemoryEntry
  done?: Done
  act: (entry: MemoryEntry, action: Action) => Promise<void>
}) {
  const waiting = () => props.entry.status === "proposed" || props.entry.status === "quarantined"
  const said = () =>
    props.done === "undone"
      ? UNDONE
      : props.done === "approved"
        ? "Approved. Vector will use it."
        : props.done === "rejected"
          ? "Rejected and forgotten."
          : props.entry.status === "archived"
            ? "Undone."
            : undefined
  return (
    <span data-slot="learned-chip-actions">
      <Show
        when={said()}
        fallback={
          <Show
            when={waiting()}
            fallback={
              <Show when={props.entry.status === "active"}>
                <ButtonV2 size="small" variant="ghost" icon="reset" onClick={() => void props.act(props.entry, "undo")}>
                  {props.done === "failed-undo" ? "Try Undo again" : "Undo"}
                </ButtonV2>
              </Show>
            }
          >
            <ButtonV2 size="small" variant="ghost" icon="check" onClick={() => void props.act(props.entry, "approve")}>
              Approve
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => void props.act(props.entry, "reject")}>
              Reject
            </ButtonV2>
            <Show when={props.done === "failed-approve" || props.done === "failed-reject"}>
              <span data-slot="learned-chip-failed" role="alert">
                {props.done === "failed-approve" ? "Vector could not approve it." : "Vector could not reject it."} Try
                again in a moment.
              </span>
            </Show>
          </Show>
        }
      >
        <span data-slot="learned-chip-done">{said()}</span>
      </Show>
    </span>
  )
}
