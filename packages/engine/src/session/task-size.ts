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
  readonly judge: TaskSize.JudgeMode
  /** What a compaction recorded of this request, when the summary replaced the message that opened it. */
  readonly carried?: Carried
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
  for (const group of groups(input.messages)) {
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
    const rules = group.users.reduce<TaskSize.Result | undefined>(
      (current, user) => {
        const next = TaskSize.classify({
          ...describe(user),
          previous: current?.tier ?? prior?.tier ?? (compacted ? "standard" : undefined),
          open: current ? false : open,
          plan: current ? false : plan,
          auto: input.auto,
        })
        if (!current) return next
        // A message that joined the run raises it; it never shrinks what the request already is.
        return TaskSize.rank(next.tier) > TaskSize.rank(current.tier)
          ? { ...next, judge: next.judge && current.judge }
          : current
      },
      group.carried && {
        tier: group.carried.tier,
        source: "auto",
        reasons: ["compacted"],
        judge: group.carried.judge !== "off",
        agents: group.carried.agents,
      },
    )!
    // The quick lane offers escalate, so a message the rules took for social can still go on as Work.
    const result: TaskSize.Result =
      rules.tier === "chat" && escalatedChat(group.messages)
        ? { ...rules, tier: "standard", reasons: ["escalated"] }
        : rules
    // The user's "no subagents" or "don't be thorough" holds against escalate and a judge FAIL alike.
    const raised = capped(result) ? undefined : escalation(group.messages)
    const tier = raised ? TaskSize.max(result.tier, raised) : result.tier
    const start = (group.users[0] ?? group.messages[0]).info.time.created
    const offered =
      tier === "chat" || !input.caching || sticky === undefined || start - end > input.lifetime
        ? tier
        : TaskSize.max(sticky, tier)
    // A greeting goes out on its own small request shape, so it neither reads nor refreshes the main cached prefix.
    if (tier !== "chat") {
      sticky = offered
      end = Math.max(start, ...group.messages.map(finishedAt))
    }
    sized.push({
      users: group.users,
      messages: group.messages,
      result,
      tier,
      escalated: raised !== undefined,
      offered,
      judge: judgeMode(
        group.users,
        group.carried?.judge ?? input.judge,
        result.judge,
        result.reasons.includes("explicit:judge"),
      ),
      ...(group.carried ? { carried: group.carried } : {}),
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

/** The user said "no subagents" or "don't be thorough": the request stays Work, and escalate may not raise it. */
export function capped(result: TaskSize.Result) {
  return result.reasons.includes("capped")
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
