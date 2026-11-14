export * as SessionTaskSize from "./task-size"

import { TaskSize } from "@vectordevai/core/task-size"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Computer } from "@vectordevai/schema/computer"
import { Schema } from "effect"
import { isRecord } from "@/util/record"

// Sizes the request a run is answering from the projected history alone, on every step. Nothing is decided at
// admission: a prompt stores only what the sender chose (`size`, `judge`), and a completed escalate call is the durable
// record of a raise, so the size survives a restart and every step of a request agrees on it.

/** The hidden instruction the app sent with every prompt while LLM-as-a-judge was on, before Vector ran the judge. */
export const LEGACY_JUDGE_POLICY = "<vector_verified_completion>"

/** Where a compaction marker records the request it summarised, on a hidden text part's metadata. */
export const CARRIED = "vector_request"

/**
 * What a compaction keeps of the request it summarised. The summary replaces the message that opened the request, so
 * without this the request would lose its size, its judge and its words, and a "continue" after it would have nothing
 * to continue.
 */
export type Carried = {
  /** The user message that opened the request. */
  readonly opened: string
  readonly tier: TaskSize.Tier
  readonly judge: TaskSize.JudgeMode
  /** What the user typed, for the judge's brief. */
  readonly text: string
  /** Files the summarised part of the request changed since its last verdict. */
  readonly files: readonly string[]
  readonly agents: readonly string[]
  /** The request's snapshot, which was recorded on the message the summary replaced. */
  readonly snapshot?: readonly TaskSize.Running[]
}

/** Where a request's opening message records the subagents still working when it opened, on a synthetic text part. */
export const SNAPSHOT = "subagentSnapshot"

/** Reason a request gains when a message that joined it said "no subagents". */
export const CAPPED_JOINED = "capped:joined"

/** A size note and the user message it rides on. */
export type Note = {
  readonly user: SessionV1.WithParts
  /** What the rules said over the request's user messages up to this one. */
  readonly result: TaskSize.Result
  readonly judge: TaskSize.JudgeMode
}

export type Request = {
  /** The user's own messages in this request, oldest first: the one that opened it and any that joined it. */
  readonly users: readonly SessionV1.WithParts[]
  /** Every message of the request from the one that opened it, oldest first. */
  readonly messages: readonly SessionV1.WithParts[]
  /**
   * What the rules said. A Chat request the agent escalated is Work here, reason "escalated": the agent read it as a
   * request for work, so it is something the user asked for and work a reply can continue.
   */
  readonly result: TaskSize.Result
  /** The request's size: the rules' size, raised once if the agent called escalate. */
  readonly tier: TaskSize.Tier
  readonly escalated: boolean
  /** The size whose tools and policies the request is sent with; see `offered` in `size`. */
  readonly offered: TaskSize.Tier
  /**
   * Whether the provider's prompt cache still holds the work before this request: it caches, an earlier request was
   * more than a greeting, and this one started within the cache's lifetime of that one's end. A learned workflow
   * default keeps the effort the request before it ran with while this holds, so thinking settings never change on a
   * warm cache.
   */
  readonly warm: boolean
  readonly judge: TaskSize.JudgeMode
  /** What a compaction recorded of this request, when the summary replaced the message that opened it. */
  readonly carried?: Carried
  /** The subagents launched earlier that were still working when the request opened, as its opening message records. */
  readonly snapshot: readonly TaskSize.Running[]
  /**
   * The highest size of the requests that launched the subagents whose completion notes arrived in this one, so a
   * report can be acted on with the tools it was launched with.
   */
  readonly notified?: TaskSize.Tier
  /**
   * Size notes, oldest first: one on the opening message, and one on each joined message that changed the size, the
   * "no subagents" cap or the judge. Each comes from the messages up to its own, so a later join changes no earlier one.
   */
  readonly notes: readonly Note[]
  /**
   * The request whose delegated spend ledger this one's subagents share: the opening message, or for a Chat message a
   * note made work, the request that launched the subagent or command it is about, so a "thanks" never opens a fresh
   * ledger.
   */
  readonly ledgerRequestID: string
}

export type Input = {
  readonly messages: readonly SessionV1.WithParts[]
  /**
   * Whether the provider caches prompt prefixes. Then the tools and policies keep the highest size the session has
   * used while its cache is warm, so a smaller follow-up reuses the cached prefix instead of writing a new one. A model
   * without caching (the shared free models) follows each request's own size at once.
   */
  readonly caching: boolean
  /** How long the provider keeps a cached prefix, in milliseconds. */
  readonly lifetime: number
  /** Config `sizing.auto`. */
  readonly auto?: boolean
  /** Config `sizing.judge`, used when a prompt carries no judge setting of its own. */
  readonly judge?: TaskSize.JudgeMode
}

/** Every request in the history, oldest first; the last is the one being answered. Empty when no user has spoken. */
export function size(input: Input): Request[] {
  const sized: Request[] = []
  // On a caching provider the tools offered only grow while the cache is warm; a cold cache or a compaction (which
  // starts the visible history again) resets them to the request's own size.
  let sticky: TaskSize.Tier | undefined
  let end = 0
  // A compaction that recorded nothing (one from before Vector recorded requests) still leaves work to continue: a
  // "continue" or a "yes" after it is work of unknown size, so Standard with tools and history, never a bare reply.
  const compacted = input.messages.some((message) => message.parts.some((part) => part.type === "compaction"))
  const all = groups(input.messages)
  const launches = launchesOf(all)
  for (const [position, group] of all.entries()) {
    const previous = sized.at(-1)
    // What a "continue" or a "yes" continues: the last request that was more than a greeting, since a "thanks" and its
    // reply in between are not the work.
    const index = sized.findLastIndex((request) => request.tier !== "chat")
    const prior = sized[index]
    // The request before is still open when its reply asked the user a question, or its run did not finish, or had not
    // when the user wrote (a message sent during its final step opens a request of its own): then the user's next
    // message, a social one included, answers or follows up that work. A greeting's reply is never open: its "How about
    // you?" waits on nothing.
    const sent = group.users[0]?.info.time.created ?? Infinity
    const open =
      previous && previous.tier !== "chat"
        ? sent < Math.max(...previous.messages.map(finishedAt)) || waiting(previous)
        : false
    // Whether that work is a plan from Plan mode that nobody has carried out yet, so "yes" or "build it" carries it out.
    const plan = prior?.messages.findLast((message) => message.info.role === "assistant")?.info.agent === "plan"
    // What a compaction recorded stands in for the opening message it replaced.
    const summarised: TaskSize.Result | undefined = group.carried && {
      tier: group.carried.tier,
      source: "auto",
      reasons: ["compacted"],
      judge: group.carried.judge !== "off",
      agents: group.carried.agents,
    }
    // The rules after each user message of the request.
    const states = group.users.reduce<{ user: SessionV1.WithParts; result: TaskSize.Result }[]>((list, user) => {
      const current = list.at(-1)?.result ?? summarised
      const next = TaskSize.classify({
        ...describe(user),
        previous: current?.tier ?? prior?.tier ?? (compacted ? "standard" : undefined),
        open: current ? false : open,
        plan: current ? false : plan,
        auto: input.auto,
      })
      return [...list, { user, result: current ? joined(current, next) : next }]
    }, [])
    const rules = states.at(-1)?.result ?? summarised!
    // The quick lane offers escalate, so a message the rules took for social can still go on as Work.
    const escalated: TaskSize.Result =
      rules.tier === "chat" && escalatedChat(group.messages)
        ? { ...rules, tier: "standard", reasons: ["escalated"] }
        : rules
    // The notes that started a turn in the request, by the request that launched the work each is about (undefined
    // when that launch is out of view, as after a compaction): a child's result, a child's report sent with wake, and a
    // background command's exit. A Chat message a note joined is work: the note is handled with the tools of the
    // request that launched the work, never on the quick lane.
    const notes = reported(group.messages)
    const launchers = notes.map((note) => launcher(launches, note, position))
    const tierOf = (list: readonly (number | undefined)[]) => {
      const sources = list.flatMap((at) =>
        at !== undefined && at < position && sized[at]!.tier !== "chat" ? [at] : [],
      )
      const top = sources.reduce<TaskSize.Tier | undefined>(
        (highest, at) => TaskSize.max(highest ?? sized[at]!.tier, sized[at]!.tier),
        list.includes(undefined) ? "standard" : undefined,
      )
      return { sources, top }
    }
    const { sources, top: reportedTier } = tierOf(launchers)
    // `notified` counts children's completion notes alone: on Light it lets the agent resume the child that reported.
    const completions = launchers.filter((_, index) => notes[index]!.kind === "result")
    const completedTier = tierOf(completions).top
    const upgraded = launchers.length > 0 && escalated.tier === "chat"
    const result: TaskSize.Result = upgraded
      ? { ...escalated, tier: TaskSize.max("standard", reportedTier ?? "standard"), reasons: ["notified"] }
      : escalated
    // The user's "no subagents" or "don't be thorough" in the message that opened the request holds against escalate
    // and a judge FAIL alike. Said in a message that joined the run, it stops new launches and lowers nothing.
    const raised = !group.carried && states[0] && held(states[0].result) ? undefined : escalation(group.messages)
    const tier = raised ? TaskSize.max(result.tier, raised) : result.tier
    // A child this request launched itself reports at this request's size.
    const notified = completions.includes(position) ? TaskSize.max(completedTier ?? tier, tier) : completedTier
    const start = (group.users[0] ?? group.messages[0]).info.time.created
    const warm = tier !== "chat" && input.caching && sticky !== undefined && start - end <= input.lifetime
    const offered = warm ? TaskSize.max(sticky!, tier) : tier
    // A greeting goes out on its own small request shape, so it neither reads nor refreshes the main cached prefix.
    if (tier !== "chat") {
      sticky = offered
      end = Math.max(start, ...group.messages.map(finishedAt))
    }
    const configured = group.carried?.judge ?? input.judge
    const opened = group.carried?.opened ?? group.users[0]?.info.id ?? group.messages[0]!.info.id
    // The launching request that set the size, the latest of equals; else, with the launch out of view, the work before.
    const source = sources.reduce<number | undefined>((best, at) => {
      if (best === undefined) return at
      const rank = TaskSize.rank(sized[at]!.tier) - TaskSize.rank(sized[best]!.tier)
      return rank > 0 || (rank === 0 && at > best) ? at : best
    }, undefined)
    sized.push({
      users: group.users,
      messages: group.messages,
      result,
      tier,
      escalated: raised !== undefined,
      offered,
      warm,
      judge: judgeMode(group.users, configured, result.judge, result.reasons.includes("explicit:judge")),
      ...(group.carried ? { carried: group.carried } : {}),
      snapshot: group.carried ? (group.carried.snapshot ?? []) : ((group.users[0] && snapshotOf(group.users[0])) ?? []),
      ...(notified && notified !== "chat" ? { notified } : {}),
      notes: noteEntries(group, summarised, states, configured, result === rules ? undefined : result),
      ledgerRequestID: upgraded
        ? source !== undefined
          ? sized[source]!.ledgerRequestID
          : (prior?.ledgerRequestID ?? opened)
        : opened,
    })
  }
  return sized
}

/** The text a request's user typed, for the judge's brief. */
export function requestText(request: Pick<Request, "users" | "carried">) {
  return [...(request.carried ? [request.carried.text] : []), ...request.users.map((user) => typed(user))]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * What a compaction records of the request it is about to summarise, from the messages its summary replaces: the
 * request's size, judge and words, and the files it changed since its last verdict.
 */
export function carry(request: Request, hidden: (message: SessionV1.WithParts) => boolean): Carried | undefined {
  if (request.tier === "chat") return
  const opened = request.users[0]?.info.id ?? request.carried?.opened
  if (!opened) return
  const messages = request.messages.filter(hidden)
  const verdict = judgeRuns({ messages }).at(-1)?.messageID
  return {
    opened,
    tier: request.tier,
    judge: request.judge,
    text: requestText(request).slice(0, 8000),
    files: [...new Set([...(verdict ? [] : (request.carried?.files ?? [])), ...changedFiles({ messages }, verdict)])],
    agents: request.result.agents,
    ...(request.snapshot.length > 0 ? { snapshot: request.snapshot } : {}),
  }
}

/**
 * The work Vector's judge checks when a run ends: every request the run answered, with the requests they continue (a
 * "yes" to the agent's question carries the work it answers), when one of them qualifies for the judge. A message that
 * joined during the final step opens its own request, so judging only the last one would miss the work before it.
 * Undefined when nothing qualifies or no file changed since the last verdict.
 */
export function judgeable(requests: readonly Request[], since: string) {
  const touched = requests.findIndex((request) =>
    request.messages.some((message) => message.info.role === "assistant" && message.info.id > since),
  )
  const last = requests.at(-1)
  if (touched === -1 || !last || !last.result.judge) return
  // A greeting or a question about Vector answers nothing, so a "hi" never brings in the judge for the work before it,
  // even when it is sent while that work waits on the user and so runs at its size.
  const unit = requests.slice(
    answersNothing(requests[touched]!) ? touched : settled(requests, origin(requests, touched)),
  )
  // "thorough" judges Thorough work; "changes" judges any work.
  const qualifies = unit.some(
    (request) =>
      request.judge !== "off" &&
      request.tier !== "chat" &&
      (request.judge === "changes" || request.tier === "thorough"),
  )
  if (!qualifies) return
  const verdict = unit.flatMap(judgeRuns).at(-1)?.messageID
  const files = [
    ...new Set([
      // A verdict the summary kept in view is newer than anything the summary replaced.
      ...(verdict ? [] : unit.flatMap((request) => request.carried?.files ?? [])),
      ...unit.flatMap((request) => changedFiles(request, verdict)),
    ]),
  ]
  if (files.length === 0) return
  // The judge reads everything the user asked for in that work, not only the request that qualified it. A thanks that a
  // FAIL raised to the work's size, or a "hi" sent while the work waited on the user, is still not something they asked
  // for.
  const work = unit.filter((request) => request.result.tier !== "chat" && !answersNothing(request))
  return {
    requests: work,
    files,
    tier: unit.reduce<TaskSize.Tier>(
      (top, request) => (request.tier === "chat" ? top : TaskSize.max(top, request.tier)),
      "standard",
    ),
    // What the work's own last change reported, not a later "You're welcome!".
    report: closingText(
      (unit.findLast((request) => changedFiles(request).length > 0) ?? work.at(-1) ?? unit.at(-1)!).messages,
    ),
    // Where the agent stopped to ask or offer something, and what the user answered: a "no" narrows the work's scope.
    // A greeting in between answers nothing.
    exchanges: unit.flatMap((request, index) => {
      const asked = closingText(request.messages)
      const answer = unit.slice(index + 1).find((next) => !answersNothing(next))
      const reply = answer ? requestText(answer) : ""
      return TaskSize.asks(asked) && reply ? [{ asked: asked.slice(-600), reply: reply.slice(0, 2000) }] : []
    }),
  }
}

/**
 * Whether a request ended with its work still open: the agent's reply asked the user a question, it asked through the
 * question tool and the user dismissed it, or the run did not finish (interrupted, failed, stopped or cut off).
 */
export function waiting(request: Pick<Request, "messages">) {
  if (TaskSize.asks(closingText(request.messages))) return true
  const last = request.messages.findLast((message) => message.info.role === "assistant")
  if (!last || last.info.role !== "assistant") return true
  if (dismissed(request.messages)) return true
  return last.info.error !== undefined || UNFINISHED.has(last.info.finish ?? "")
}

/**
 * Whether the agent asked through the question tool in these messages and the user dismissed the question (or has not
 * answered it): the work waits on the user, and Vector does not judge it yet.
 */
export function dismissed(messages: readonly SessionV1.WithParts[]) {
  return messages.some(
    (message) =>
      message.info.role === "assistant" &&
      message.parts.some(
        (part) => part.type === "tool" && part.tool === "question" && part.state.status !== "completed",
      ),
  )
}

/**
 * The user said "no subagents": no new subagents for the request. Said in the message that opened it, the request also
 * stays Work and escalate may not raise it.
 */
export function capped(result: TaskSize.Result) {
  return result.reasons.includes("capped") || result.reasons.includes(CAPPED_JOINED)
}

/** The user kept the request at its size ("no subagents" or "don't be thorough"): escalate may not raise it. */
export function held(result: TaskSize.Result) {
  return capped(result) || result.reasons.includes(TaskSize.CAPPED_THOROUGH)
}

/**
 * The subagents a request's opening message records as still working when it opened; undefined when it records none.
 */
export function snapshotOf(message: SessionV1.WithParts): TaskSize.Running[] | undefined {
  for (const part of message.parts) {
    const value = part.type === "text" ? part.metadata?.[SNAPSHOT] : undefined
    if (!isRecord(value) || !Array.isArray(value.ids)) continue
    const titles: unknown[] = Array.isArray(value.titles) ? value.titles : []
    return value.ids.flatMap((id: unknown, index) =>
      typeof id === "string" ? [{ id, title: typeof titles[index] === "string" ? titles[index] : "" }] : [],
    )
  }
  return undefined
}

/** The synthetic text part that records a request's snapshot on its opening message. */
export function snapshotPart(children: readonly TaskSize.Running[], at: number) {
  return {
    text: TaskSize.running(children, "work") ?? "",
    metadata: {
      [SNAPSHOT]: { ids: children.map((child) => child.id), titles: children.map((child) => child.title), at },
    },
  }
}

// A message that joined the run raises the request; it never shrinks what the request already is. Its "no subagents"
// caps the request from then on, whether or not it raised it.
function joined(current: TaskSize.Result, next: TaskSize.Result): TaskSize.Result {
  const raised =
    TaskSize.rank(next.tier) > TaskSize.rank(current.tier) ? { ...next, judge: next.judge && current.judge } : current
  if (!next.reasons.includes("capped") || raised.reasons.includes(CAPPED_JOINED)) return raised
  return { ...raised, reasons: [...raised.reasons, CAPPED_JOINED] }
}

// The request's size notes: the opening message always has one, and a joined message one only when the size, the cap
// or the judge changed. On a request whose opening a compaction summarised, the first note rides on the first user
// message still in view. A Chat request the agent escalated or a report made work is noted at the size it runs at.
function noteEntries(
  group: Group,
  summarised: TaskSize.Result | undefined,
  states: readonly { user: SessionV1.WithParts; result: TaskSize.Result }[],
  configured: TaskSize.JudgeMode | undefined,
  // The request's result when escalate or a note made a Chat request work.
  adjusted: TaskSize.Result | undefined,
): Note[] {
  const mode = (users: readonly SessionV1.WithParts[], result: TaskSize.Result) =>
    judgeMode(users, configured, result.judge, result.reasons.includes("explicit:judge"))
  const first = group.messages.find((message) => message.info.role === "user")
  const start: Note[] =
    summarised && first && first !== group.users[0]
      ? [{ user: first, result: summarised, judge: mode([], summarised) }]
      : []
  return states
    .reduce<Note[]>((notes, state, index) => {
      const note = {
        user: state.user,
        result: state.result,
        judge: mode(group.users.slice(0, index + 1), state.result),
      }
      const last = notes.at(-1)
      return last &&
        last.result.tier === note.result.tier &&
        capped(last.result) === capped(note.result) &&
        (last.judge === "off") === (note.judge === "off")
        ? notes
        : [...notes, note]
    }, start)
    .map((note) =>
      adjusted && note.result.tier === "chat"
        ? { ...note, result: { ...note.result, tier: adjusted.tier, reasons: adjusted.reasons } }
        : note,
    )
}

type Reported = { taskID: string; messageID: string; kind: "result" | "message" | "shell" }

// Notes in these messages that start a turn (4.6): a child's result that was not cancelled or recorded quiet, a
// child's `task_manage report` delivered with a turn, and a background command's exit that was not a stop. A note
// delivered without a turn carries `taskQuiet`. `taskID` is the child's session, or the command's `shl_` ID.
function reported(messages: readonly SessionV1.WithParts[]) {
  return messages.flatMap((message) =>
    message.info.role !== "user"
      ? []
      : message.parts.flatMap((part): Reported[] => {
          if (part.type !== "text" || part.metadata?.[QUIET] === true) return []
          const messageID = message.info.id
          const note = part.metadata?.taskNotification
          if (isRecord(note))
            return typeof note.taskID !== "string" || note.state === "cancelled" || note.quiet === true
              ? []
              : [{ taskID: note.taskID, messageID, kind: "result" }]
          const report = part.metadata?.taskMessage
          if (isRecord(report))
            return typeof report.taskID === "string" ? [{ taskID: report.taskID, messageID, kind: "message" }] : []
          const shell = part.metadata?.shellNotification
          if (isRecord(shell))
            return typeof shell.shellID !== "string" || shell.state === "stopped" || shell.state === "interrupted"
              ? []
              : [{ taskID: shell.shellID, messageID, kind: "shell" }]
          return []
        }),
  )
}

type Launch = { messageID: string; request: number }

// Every task call's children, by child, and every background command, by its `shl_` ID: the request whose message
// launched or resumed it, oldest first.
function launchesOf(list: readonly Group[]) {
  const launches = new Map<string, Launch[]>()
  const add = (id: string, launch: Launch) => launches.set(id, [...(launches.get(id) ?? []), launch])
  for (const [request, group] of list.entries())
    for (const message of group.messages) {
      if (message.info.role !== "assistant") continue
      for (const part of message.parts) {
        if (part.type !== "tool" || !("metadata" in part.state)) continue
        const metadata = part.state.metadata
        if (!isRecord(metadata)) continue
        // The shell tool's part names a command it started in the background (5.H).
        if (metadata.background === true && typeof metadata.shellID === "string" && metadata.shellID.startsWith("shl_"))
          add(metadata.shellID, { messageID: message.info.id, request })
        if (part.tool !== "task") continue
        const entries: unknown[] = Array.isArray(metadata.tasks) ? metadata.tasks : [metadata]
        for (const entry of entries)
          if (isRecord(entry) && typeof entry.sessionId === "string")
            add(entry.sessionId, { messageID: message.info.id, request })
      }
    }
  return launches
}

// The request that last launched or resumed a child before its note; undefined when that launch is out of view.
function launcher(
  launches: ReadonlyMap<string, readonly Launch[]>,
  note: { taskID: string; messageID: string },
  at: number,
) {
  const launch = launches.get(note.taskID)?.findLast((item) => item.messageID < note.messageID)
  return launch && launch.request <= at ? launch.request : undefined
}

// Whether the agent escalated a Chat request: the quick lane's escalate raised it from Chat to Work.
function escalatedChat(messages: readonly SessionV1.WithParts[]) {
  return messages.some(
    (message) =>
      message.info.role === "assistant" &&
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          part.tool === "escalate" &&
          part.state.status === "completed" &&
          part.state.metadata?.from === "chat",
      ),
  )
}

// A greeting, emoji or a question about Vector answers nothing the agent asked.
function answersNothing(request: Request) {
  return request.result.reasons.some((reason) => UNANSWERING.has(reason))
}

const UNANSWERING = new Set(["greeting", "emoji", "about-vector"])

// Finish reasons of a run that stopped before its answer was done.
const UNFINISHED = new Set(["length", "tool-calls", "unknown", "error", "content-filter"])

// Work that stopped on a question was not judged then. When the user declines, thanks or moves on instead of continuing
// it, it is judged with the run that answered them, so a finished large task that closed with a question still gets
// its verdict.
function settled(requests: readonly Request[], index: number): number {
  const before = requests.slice(0, index).findLastIndex((item) => item.tier !== "chat")
  const work = requests[before]
  if (!work || !(TaskSize.asks(closingText(work.messages)) || dismissed(work.messages)) || judgeRuns(work).length > 0)
    return index
  return settled(requests, origin(requests, before))
}

// The request a continuation goes back to: "yes" or "continue" inherits the last request before it that was work.
function origin(requests: readonly Request[], index: number): number {
  if (requests[index]?.result.source !== "inherited") return index
  const prior = requests.slice(0, index).findLastIndex((request) => request.tier !== "chat")
  return prior === -1 ? index : origin(requests, prior)
}

/** Files the request changed after the given message: its recorded patches, and its completed edits and writes. */
export function changedFiles(request: Pick<Request, "messages">, after?: string) {
  return [
    ...new Set(
      request.messages
        .filter((message) => message.info.role === "assistant" && (after === undefined || message.info.id > after))
        .flatMap((message) => message.parts.flatMap(changed)),
    ),
  ]
}

function changed(part: SessionV1.Part): string[] {
  if (part.type === "patch") return part.files
  if (part.type !== "tool" || part.state.status !== "completed") return []
  if (part.tool === "edit" || part.tool === "write")
    return typeof part.state.input.filePath === "string" ? [part.state.input.filePath] : []
  if (part.tool === "apply_patch" && Array.isArray(part.state.metadata?.files))
    return part.state.metadata.files.flatMap((file: unknown) =>
      file && typeof file === "object" && "filePath" in file && typeof file.filePath === "string"
        ? [file.filePath]
        : [],
    )
  return []
}

/** The judge runs Vector started in this request, oldest first. */
export function judgeRuns(request: Pick<Request, "messages">) {
  return request.messages.flatMap((message) =>
    message.info.role === "assistant"
      ? message.parts.flatMap((part) =>
          part.type === "tool" && part.tool === "task" && part.metadata?.judge !== undefined
            ? [{ messageID: message.info.id, part }]
            : [],
        )
      : [],
  )
}

/** The agent's closing text in a request: what it told the user it did. */
export function closingText(messages: readonly SessionV1.WithParts[]) {
  const last = messages.findLast(
    (message) =>
      message.info.role === "assistant" &&
      message.parts.some((part) => part.type === "text" && !part.synthetic && part.text.trim()),
  )
  return (
    last?.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
      .join("\n")
      .trim() ?? ""
  )
}

/** The user's own words in a message: not attached file contents, and not Vector's or a client's hidden instructions. */
export function typed(message: SessionV1.WithParts) {
  return message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n")
    .trim()
}

/** A message from the user, as opposed to a task notification, a judge's findings or a compaction marker. */
export function real(message: SessionV1.WithParts) {
  if (message.info.role !== "user") return false
  return message.parts.some(
    (part) =>
      (part.type === "text" && !part.synthetic && !part.ignored) || part.type === "file" || part.type === "agent",
  )
}

/** Where a note Vector recorded without starting a turn is marked, on its text parts' metadata. */
export const QUIET = "taskQuiet"

// A user message made only of such notes.
function quiet(message: SessionV1.WithParts) {
  return (
    message.info.role === "user" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === "text" && part.metadata?.[QUIET] === true)
  )
}

type Group = { users: SessionV1.WithParts[]; messages: SessionV1.WithParts[]; closed: boolean; carried?: Carried }

function groups(messages: readonly SessionV1.WithParts[]) {
  // The projected history can be reordered around a compaction; message IDs are monotonic.
  const sorted = messages.toSorted((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))
  const visible = new Set<string>(sorted.map((message) => message.info.id))
  return sorted.reduce<Group[]>((list, message) => {
    const carried = carriedOf(message)
    if (carried && !visible.has(carried.opened)) {
      // The summary replaced the message that opened this request: the request goes on from what the compaction
      // recorded, with every message after its opening that is still in view.
      const joined = list.filter((group) => group.messages[0]!.info.id > carried.opened)
      return [
        ...list.filter((group) => group.messages[0]!.info.id < carried.opened),
        {
          users: joined.flatMap((group) => group.users),
          messages: [...joined.flatMap((group) => group.messages), message],
          closed: false,
          carried,
        },
      ]
    }
    // A note recorded without a turn (noReply) belongs to no request, so it never reopens a finished one.
    if (quiet(message)) return list
    const current = list.at(-1)
    if (real(message)) {
      // A message sent while the run is going joins it; one sent after the run answered opens the next request.
      if (!current || current.closed) return [...list, { users: [message], messages: [message], closed: false }]
      current.users.push(message)
      current.messages.push(message)
      return list
    }
    if (!current) return list
    current.messages.push(message)
    if (message.info.role === "assistant" && terminal(message.info)) current.closed = true
    // Vector's own follow-ups (a judge's findings, a task notification, a compaction's continue) continue the run.
    if (message.info.role === "user") current.closed = false
    return list
  }, [])
}

function terminal(info: SessionV1.Assistant) {
  if (info.error) return true
  return info.finish !== undefined && !["tool-calls", "unknown"].includes(info.finish)
}

function finishedAt(message: SessionV1.WithParts) {
  return message.info.role === "assistant" ? (message.info.time.completed ?? message.info.time.created) : 0
}

function describe(message: SessionV1.WithParts) {
  const files = message.parts.filter((part) => part.type === "file")
  const info = message.info.role === "user" ? message.info : undefined
  return {
    text: typed(message),
    files: files.filter((part) => part.type === "file" && !part.mime.startsWith("image/")).length,
    images: files.filter((part) => part.type === "file" && part.mime.startsWith("image/")).length,
    agents: message.parts.flatMap((part) => (part.type === "agent" ? [part.name] : [])),
    computer: message.parts.some(
      (part) => part.type === "text" && !part.ignored && Schema.is(Computer.MentionPart)(part),
    ),
    choice: info?.size,
    structured: info?.format?.type === "json_schema",
  }
}

// The highest size the request was raised to; a raise only ever goes up. The agent raises it with escalate, and a judge
// FAIL raises it to the size of the work it judged, so the repair runs with that work's tools even when the run that
// answered was only a "thanks". A research plan the user started deep on its card raises it to Thorough (section 5.2):
// only the user's own answer counts, which research_plan records with source "user" on the root plan card alone, so a
// plan approved on its own (a child's, or a headless run's) never raises anything (RC7). Only root sessions are sized.
function escalation(messages: readonly SessionV1.WithParts[]) {
  return messages
    .flatMap((message) => (message.info.role === "assistant" ? message.parts : []))
    .flatMap((part) => {
      if (part.type !== "tool") return []
      if (part.tool === "task" && isRecord(part.metadata?.judge) && part.metadata.judge.verdict === "FAIL")
        return isTier(part.metadata.judge.size) ? [part.metadata.judge.size] : []
      if (part.tool === "research_plan" && part.state.status === "completed")
        return part.state.metadata?.source === "user" && isTier(part.state.metadata.to) ? [part.state.metadata.to] : []
      if (part.tool !== "escalate" || part.state.status !== "completed") return []
      const to = part.state.metadata?.to
      return isTier(to) ? [to] : []
    })
    .reduce<TaskSize.Tier | undefined>((highest, to) => (highest ? TaskSize.max(highest, to) : to), undefined)
}

function carriedOf(message: SessionV1.WithParts): Carried | undefined {
  if (message.info.role !== "user") return
  const value = message.parts.flatMap((part) =>
    part.type === "text" && part.synthetic && part.ignored && isRecord(part.metadata?.[CARRIED])
      ? [part.metadata[CARRIED]]
      : [],
  )[0]
  if (!value || typeof value.opened !== "string" || !isTier(value.tier)) return
  return {
    opened: value.opened,
    tier: value.tier,
    judge: value.judge === "thorough" || value.judge === "changes" ? value.judge : "off",
    text: typeof value.text === "string" ? value.text : "",
    files: Array.isArray(value.files) ? value.files.filter((file): file is string => typeof file === "string") : [],
    agents: Array.isArray(value.agents)
      ? value.agents.filter((agent): agent is string => typeof agent === "string")
      : [],
    ...(Array.isArray(value.snapshot)
      ? {
          snapshot: value.snapshot.flatMap((child: unknown) =>
            isRecord(child) && typeof child.id === "string"
              ? [{ id: child.id, title: typeof child.title === "string" ? child.title : "" }]
              : [],
          ),
        }
      : {}),
  }
}

function isTier(value: unknown): value is TaskSize.Tier {
  return value === "chat" || value === "light" || value === "standard" || value === "thorough"
}

function judgeMode(
  users: readonly SessionV1.WithParts[],
  // The config's setting, or what a compaction recorded for the request.
  configured: TaskSize.JudgeMode | undefined,
  allowed: boolean,
  // The user's message told Vector to run the judge ("run the judge", "use llm-as-a-judge").
  asked: boolean,
): TaskSize.JudgeMode {
  if (!allowed) return "off"
  const mode = chosenMode(users) ?? configured ?? "off"
  // The ask is a Thorough request of its own, so the judge looks at it even with the setting off.
  return asked && mode === "off" ? "thorough" : mode
}

function chosenMode(users: readonly SessionV1.WithParts[]): TaskSize.JudgeMode | undefined {
  const chosen = users.findLast((user) => user.info.role === "user" && user.info.judge !== undefined)
  if (chosen?.info.role === "user" && chosen.info.judge) return chosen.info.judge
  // Older clients turned the judge on by sending its policy as a hidden instruction with each prompt.
  const legacy = users.some((user) =>
    user.parts.some((part) => part.type === "text" && part.synthetic && part.text.startsWith(LEGACY_JUDGE_POLICY)),
  )
  return legacy ? "thorough" : undefined
}
