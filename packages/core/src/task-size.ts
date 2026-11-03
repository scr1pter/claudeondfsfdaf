export * as TaskSize from "./task-size"

import type { Choice, Tier } from "@vectordevai/schema/task-size"

export { Tier, Choice, JudgeMode } from "@vectordevai/schema/task-size"

// Sizes a request with no model call, so "hi" gets one direct reply and only work that the user or the agent calls large
// brings in subagents and the judge. The engine, the V2 runner, the app and desktop all use this one classifier.
//
// It is built so that a wrong guess costs little and can be undone:
// - Chat (one direct reply) is only a social message, and never while work waits on the user. It is offered one tool,
//   escalate, so a message misread as social goes on as Work.
// - Everything else is Work: every tool but subagents, at the provider's default effort. Light and Standard behave the
//   same, except that Light, a size only a sender picks, skips the to-do list.
// - Thorough (subagents, high effort, the judge) comes only from the user's own ask in the message, from the agent's
//   escalate call, or from a message that continues Thorough work. Never from words about the work's scope. Thorough
//   ends with its run: the next message is sized fresh unless the reply asked the user a question or the message
//   carries the work on.

/** Reasoning effort for a request when the user left effort on its default. */
export type Effort = "off" | "default" | "high"

/** Where a size came from: Vector's rules, the sender's own choice, or the work the message continues. */
export type Source = "auto" | "user" | "inherited"

export type Input = {
  /** What the user typed for this request, without attached file contents or Vector's own hidden instructions. */
  readonly text: string
  /** Attached files and images. */
  readonly files?: number
  readonly images?: number
  /** Subagents the user named with @. */
  readonly agents?: readonly string[]
  /** The sender's explicit size; "auto" or undefined lets the rules decide. */
  readonly choice?: Choice
  /** The size of the work before this message: the last request in the session that was not Chat. */
  readonly previous?: Tier
  /**
   * Whether the request right before this message is still open: its reply asked the user a question (`asks`), the
   * user dismissed a question it asked through the question tool, or its run did not finish (it was interrupted,
   * failed or stopped). Then the message answers or follows up that work, so it is never a bare reply, and it continues
   * that work at its size. A Chat reply is never open: its small talk ("How about you?") waits on nothing.
   */
  readonly open?: boolean
  /**
   * Whether the work before this message is a plan nobody has carried out yet: its reply came from Plan mode. Then an
   * approval ("yes", "approved", "go ahead") or an ask to build it ("build it", "implement the plan") carries it out at
   * its size. Any other finished work is done, so only a carry-on ("continue", "the rest") continues it.
   */
  readonly plan?: boolean
  /** The request asks for structured output, which needs a tool call. */
  readonly structured?: boolean
  /** false turns automatic sizing off: every request gets the full harness unless the sender picks a size. */
  readonly auto?: boolean
}

export type Result = {
  readonly tier: Tier
  readonly source: Source
  /**
   * Stable reason codes, such as "greeting", "work" or "explicit:thorough"; clients turn them into copy. "capped" means
   * the user said "no subagents" or "don't be thorough": nothing, escalate included, takes the request past Work.
   */
  readonly reasons: readonly string[]
  /** false when the user said to skip the judge for this request. */
  readonly judge: boolean
  /** Subagents the user named; they may be launched below Thorough. */
  readonly agents: readonly string[]
}

const ORDER = { chat: 0, light: 1, standard: 2, thorough: 3 } as const satisfies Record<Tier, number>

export function rank(tier: Tier) {
  return ORDER[tier]
}

export function max(a: Tier, b: Tier): Tier {
  return ORDER[a] >= ORDER[b] ? a : b
}

export function effort(tier: Tier): Effort {
  if (tier === "chat") return "off"
  if (tier === "thorough") return "high"
  return "default"
}

/** User-facing name of a size. */
export function label(tier: Tier) {
  return { chat: "Chat", light: "Light", standard: "Standard", thorough: "Thorough" }[tier]
}

/**
 * Built-in tools a request of this size is not offered. Chat is offered no tools at all and goes out on its own lane,
 * so this is for Work and Thorough. MCP, plugin and custom tools are never removed: the user installed them.
 */
export function withheld(tier: Tier, agents = 0): ReadonlySet<string> {
  if (tier === "thorough") return new Set()
  return new Set([
    // A subagent the user named keeps the task tool; only that subagent may run.
    ...(agents > 0 ? [] : ["task", "task_manage"]),
    // Light is a small action the sender picked: it skips the to-do list, and nothing else.
    ...(tier === "light" ? ["todowrite"] : []),
  ])
}

/**
 * The size guidance attached to a request's user message. It is worked out from that request alone, so a message renders
 * the same on every later request and the provider's prompt cache keeps it.
 */
export function note(tier: Tier, options: { readonly escalate: boolean; readonly judge: boolean }) {
  const escalate = options.escalate
    ? " Call escalate only for exceptionally hard work across the whole system or dozens of files; an app, a feature, bug fixes or a deploy never need it."
    : ""
  if (tier === "light")
    return `<task_size>Light request: do it directly, without a to-do list. Subagents are not offered.${escalate}</task_size>`
  if (tier === "standard")
    return `<task_size>Standard request: do the work yourself. Track only substantial milestones or a user-requested plan. Subagents are not offered.${escalate}</task_size>`
  if (tier === "thorough")
    return `<task_size>Thorough request: plan with the to-do list, split independent substantial parts across subagents when that is cheaper, and verify with the strongest checks available.${options.judge ? " Vector runs the judge after you finish, so do not launch it yourself." : ""}</task_size>`
  // A greeting goes out on the quick lane, which carries no note.
  return undefined
}

export function classify(input: Input): Result {
  const text = prose(input.text)
  const lower = text.toLowerCase().replace(/[’‘]/g, "'")
  const agents = [...new Set(input.agents ?? [])]
  // A greeting before this message is not work it could continue.
  const previous = input.previous === "chat" ? undefined : input.previous
  const result = (tier: Tier, source: Source, reasons: readonly string[], judge = true): Result => ({
    // A structured answer needs its tool and a named subagent needs the task tool, so neither is ever a bare reply.
    tier: tier === "chat" && (input.structured || agents.length > 0) ? "standard" : tier,
    source,
    reasons,
    judge,
    agents,
  })

  if (input.choice && input.choice !== "auto") return result(input.choice, "user", ["user"])
  if (input.auto === false) return result("thorough", "auto", ["auto-off"])

  // The user's own "no subagents", "skip the judge" and "don't be thorough" come out first, so they never read as the
  // ask itself. "No subagents" and "don't be thorough" keep the request at Work, Thorough work it continues included.
  const noJudge = NO_JUDGE.test(lower)
  const capped = NO_SUBAGENTS.test(lower) || NOT_THOROUGH.test(lower)
  const cap = capped ? ["capped"] : []
  // A force word counts only as the user's instruction about this request: a clause that asks for it ("be thorough",
  // "use subagents", "run the judge"), never a mention ("fix the bug with subagents not starting").
  const forced = instructions([NO_SUBAGENTS, NO_JUDGE, NOT_THOROUGH].reduce(strip, lower))
  if (forced.length > 0) return result(capped ? "standard" : "thorough", "user", [...forced, ...cap], !noJudge)

  // A greeting, thanks, a farewell, emoji, small talk or a question about Vector is a direct reply, unless work is
  // waiting on the user: then it answers or follows up that work.
  const kind = socialKind(input, text, lower)
  if (kind && !input.open) return result("chat", "auto", [kind])

  // Everything else is Work. A message continues the work before it when that work is still open, or when it carries
  // that work on (see `continues`). Continuing Thorough work keeps it Thorough, so an answer to the agent's question,
  // a "continue" or "build it" after a plan from Plan mode still has subagents and the judge. Nothing in a message
  // lowers Work: "keep it simple" or "quick question" shapes the answer, not the tools.
  const follows = input.open === true || (previous !== undefined && continues(lower, input.plan === true))
  const reasons = [follows ? (input.open ? "answer" : "continue") : "work", ...(kind ? [kind] : []), ...cap]
  const tier = previous === "thorough" && follows && !capped ? "thorough" : "standard"
  return result(tier, follows && previous ? "inherited" : "auto", reasons, !noJudge)
}

// Whether a message carries on the finished work before it. Finished work is done, whatever it changed: only a
// carry-on continues it ("continue", "keep going", "do the rest"), and after a plan from Plan mode an approval or an ask
// to build it ("yes", "approved, but skip billing", "build it", "implement the plan"). Anything else is sized fresh,
// "ship to vercel" and "fix the typo in README" after a large migration included, and Work can still escalate.
function continues(lower: string, plan: boolean) {
  const answer = lower.replace(LEAD, "")
  return [answer, polite(answer)].some(
    (opening) => CARRY_ON.test(opening) || (plan && (APPROVE.test(opening) || BUILD.test(opening))),
  )
}

/**
 * Whether a reply asks the user something, so the message after it answers that work: a sentence ending in "?" in its
 * last paragraph. While it does, Vector does not judge the work, and the answer continues it at its size. A closing
 * pleasantry ("Anything else?") asks nothing, and an offer or a closing line without a question mark ("I can also add
 * tests if you want.", "Let me know if this works for you.") asks nothing either. Courtesy after the question ("Let me
 * know!", an emoji) and a summary list after it do not hide it.
 */
export function asks(text: string) {
  const last = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split(/\n\s*\n/)
    .map((block) => {
      const said = sentences(block)
        .map((sentence) => sentence.replace(EDGES_START, "").replace(EDGES_END, "").trim())
        .filter(
          (sentence) => sentence !== "" && !pleasantry(sentence) && !(courtesy(sentence) && !sentence.endsWith("?")),
        )
      const question = said.some((sentence) => sentence.endsWith("?"))
      // A block of list items or headings after the reply's prose (a summary of the changes) is not where it ends.
      const listed = block.split("\n").every((line) => !line.trim() || STRUCTURE.test(line))
      return said.length > 0 && (question || !listed) ? question : undefined
    })
    .findLast((question) => question !== undefined)
  return last === true
}

// A closing line that asks nothing on its own: a nudge to answer ("Let me know!"), an offer to help ("Happy to adjust if
// needed."), a hope or a suggestion that leaves the choice open ("Let me know if this works for you.").
function courtesy(sentence: string) {
  return COURTESY.test(
    sentence
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[\s!.]+$/, ""),
  )
}

// A closing courtesy that offers no particular work: the whole sentence is one, so "What would you like me to do
// first?" after a plan is still a question.
function pleasantry(sentence: string) {
  return PLEASANTRY.test(
    sentence
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[\s*_`)\]!?.:;,😊🙂👋]+$/u, "")
      .replace(/^[\s*_`(\[]+/, "")
      .trim(),
  )
}

// "ack" ("got it", "sounds great") names a message only when it is a bare acknowledgement ("ok", "got it"); beside
// another social kind it is that kind ("got it, thanks" is a thanks), and a bare "sounds good" may mean "go ahead".
type Kind = "greeting" | "thanks" | "farewell" | "reaction" | "success" | "about-vector" | "emoji" | "ack"

// A short message of prose, every clause of it social: "thanks, that works", "hey, how are you doing today?", "ok
// thanks bye". Any clause that is something else ("thanks, now fix the other one", "thanks but it's still broken")
// makes it not social. The strongest kind names it.
function socialKind(input: Input, text: string, lower: string): Kind | undefined {
  if (input.files || input.images || (input.agents?.length ?? 0) > 0) return
  if (PATH.test(input.text) || URL_PATTERN.test(input.text) || input.text.includes("`") || text.length > 80) return
  // A log pasted under a greeting ("hi" and an npm error) is work: prose() dropped its lines, the user did not.
  if (lines(input.text) > lines(text)) return
  if (EMOJI_ONLY.test(lower)) return "emoji"
  const all = words(lower)
  // A question about Vector is read whole first, so the "vector" in "what is vector?" is not dropped as a name.
  if (VECTOR_QUESTIONS.has(all.join(" "))) return "about-vector"
  // Only a name or two ("vector?", "hey there" without the hey): someone checking that Vector is there.
  if (all.length > 0 && dropVocatives(all).length === 0) return "greeting"
  // A bare acknowledgement ("ok", "got it") answers nothing while nothing waits on it. After a plan from Plan mode it
  // may mean "go ahead", so there it carries the plan out.
  if (!input.plan && ACKNOWLEDGEMENTS.has(dropVocatives(all).join(" "))) return "ack"
  const kinds = sentences(lower).flatMap((sentence) =>
    clauses(sentence).map((clause) => clauseKinds(clause, sentence.trim().endsWith("?"))),
  )
  if (kinds.length === 0 || kinds.some((kind) => kind === undefined)) return
  const found = new Set(kinds.flatMap((kind) => [...(kind ?? [])]))
  return SOCIAL_ORDER.find((kind) => found.has(kind))
}

function clauseKinds(clause: string, question: boolean): ReadonlySet<Kind> | undefined {
  const typed = plainWords(clause)
  const all = typed.map(collapse)
  if (all.length === 0) return new Set()
  if (VECTOR_QUESTIONS.has(all.join(" "))) return new Set(["about-vector"])
  const trimmed = dropVocatives(typed).join(" ")
  // "it works now", "that fixed it": the user reporting back. Asked ("fixed?", "the tests passed?"), it asks the agent
  // to check the work, which needs the history and tools.
  if (SUCCESS.test(trimmed)) return question ? undefined : new Set(["success"])
  if (!question && thanked(trimmed)) return new Set(["thanks"])
  return sequence(all)
}

function lines(text: string) {
  return text.split("\n").filter((line) => line.trim()).length
}

// A thanks with what it thanks for ("thanks for the fix", "thank you for fixing that"), but never a new ask hidden in
// it ("thanks for that, can you now add tests", "thanks for the update ship it to vercel").
function thanked(typed: string) {
  const match = /^(.+?) for (.+)$/.exec(typed)
  if (!match || ASKING.test(match[2]!)) return false
  if (sequence(words(match[1]!))?.has("thanks") !== true) return false
  const rest = match[2]!.split(" ")
  return thing(rest.slice(0, rest.findLastIndex((word) => !FILLERS.has(collapse(word))) + 1))
}

// What a thanks is for: one short noun phrase that ends the sentence ("the fix", "all your help", "the quick fix to the
// parser") or a short -ing phrase ("fixing that", "looking into it"). These are built from closed word classes
// (determiners, pronouns, prepositions, question words), so a word that starts another clause shows: "the fix ship it",
// "that run the tests", "the fix what about tests" are not one phrase. Such a message is Work, and a phrase this misses
// costs one Work request.
function thing(phrase: readonly string[]) {
  const [head = "", ...rest] = phrase
  if (phrase.some((word) => QUESTION_WORDS.has(word))) return false
  // "fixing that", "looking into it", "taking care of it": a pronoun only as the last word.
  if (head.length > 4 && head.endsWith("ing"))
    return rest.length <= 4 && rest.every((word, index) => !PRONOUNS.has(word) || index === rest.length - 1)
  // "everything", "that", "help": one word.
  if (rest.length === 0) return head !== ""
  // "the fix", "all the help", "your quick fix to the parser": determiners, at most two words, and one phrase after a
  // preposition that starts with a determiner of its own.
  const start = phrase.findIndex((word) => !DETERMINERS.has(word))
  if (start < 1 || start > 2) return false
  const preposition = phrase.findIndex((word, index) => index > start && PREPOSITIONS.has(word))
  const noun = phrase.slice(start, preposition === -1 ? undefined : preposition)
  const after = preposition === -1 ? [] : phrase.slice(preposition + 1)
  return (
    noun.length <= 2 &&
    noun.every(plain) &&
    (preposition === -1 ||
      (after.length >= 2 && after.length <= 3 && DETERMINERS.has(after[0]!) && after.slice(1).every(plain)))
  )
}

function plain(word: string) {
  return !DETERMINERS.has(word) && !PRONOUNS.has(word) && !PREPOSITIONS.has(word)
}

// Splits a clause into known social phrases, longest first, or gives up when any word is left over. A filler ("ok",
// "again", a name) may sit between them but is not social on its own.
function sequence(words: readonly string[]): ReadonlySet<Kind> | undefined {
  if (words.length === 0) return new Set()
  return [4, 3, 2, 1]
    .filter((size) => size <= words.length)
    .map((size) => {
      const kind = PHRASES.find(([, items]) => items.has(words.slice(0, size).join(" ")))?.[0]
      const rest = kind ? sequence(words.slice(size)) : undefined
      return kind && rest ? new Set<Kind>([...(kind === "filler" ? [] : [kind]), ...rest]) : undefined
    })
    .find((kinds) => kinds !== undefined)
}

// Force words are instructions about this request: a clause that starts with one ("be thorough", "use subagents", "run
// the judge"), or an imperative clause that says "thoroughly" or ends with "with subagents". The same words in a
// statement or a question ("the subagents are not starting", "how would you judge this?") are only mentions.
function instructions(lower: string) {
  return [
    ...new Set(
      clauses(lower).flatMap((clause) => {
        const asked = polite(clause)
        if (!asked) return []
        return FORCE.flatMap(([code, start, inside]) =>
          start.test(asked) || (inside !== undefined && imperative(asked) && inside.test(asked)) ? [code] : [],
        )
      }),
    ),
  ]
}

// Splits a message into clauses at sentence breaks, commas and "and" / "then". A dot inside a word ("utils.ts") is not
// a break.
function clauses(lower: string) {
  return lower
    .split(/[!?;\n]+\s*|[.:](?:\s+|$)|,\s*|\s+(?:and then|then|and|but|&)\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

// A clause without the politeness around the ask: "please", "can you", "just", a trailing "for me".
function polite(clause: string) {
  return clause
    .trim()
    .replace(POLITE_START, "")
    .replace(/\s+(?:please|pls|for me|now|thanks|thank you)$/, "")
    .replace(/[?.!\s]+$/, "")
    .trim()
}

// An imperative clause starts with its verb, not with a subject, a determiner or a question word. "do" starts both:
// "do it properly with subagents" is an instruction, "do you use subagents?" a question.
function imperative(clause: string) {
  const [first = "", second = ""] = clause.split(/\s+/)
  if (first === "do") return !SUBJECTS.has(second)
  return !NOT_IMPERATIVE.has(first)
}

function words(text: string) {
  return plainWords(text).map(collapse)
}

function plainWords(text: string) {
  return text
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

function sentences(text: string) {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim())
}

function strip(text: string, pattern: RegExp) {
  return text.replace(new RegExp(pattern.source, "g"), " ")
}

function dropVocatives(words: readonly string[]) {
  const start = words.findIndex((word) => !VOCATIVES.has(collapse(word)))
  if (start === -1) return []
  const end = words.findLastIndex((word) => !VOCATIVES.has(collapse(word)))
  return words.slice(start, end + 1)
}

// Letters typed more than once in a row ("hiii", "heyyy", "thanksss") match their plain spelling. Both sides of every
// comparison go through it, so "good" and "god" never need telling apart.
function collapse(value: string) {
  return value.replace(/(\p{L})\1+/gu, "$1")
}

function set(items: readonly string[]) {
  return new Set(items.map(collapse))
}

// Pasted code and logs say what went wrong, not how much the user wrote, so only prose counts.
function prose(text: string) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split("\n")
    .filter((line) => !LOG_LINE.test(line))
    .join("\n")
    .trim()
}

// A message that carries finished work on: "continue", "keep going", "go on with the views", "do the rest of the files".
const CARRY_ON =
  /^(?:continue|go on|keep going|carry on|resume|proceed|(?:(?:do|finish|complete) )?(?:the rest|(?:the )?remaining))\b/
// How an approval of a plan starts: "yes", "approved, but skip billing", "please go ahead with phases 1 and 2", "the
// plan looks good".
const APPROVE =
  /^(?:please )?(?:yes|yeah|yep|yup|sure|ok|okay|approved?|go ahead|lgtm|looks good|sounds good|(?:the )?plan (?:looks|sounds) good|do it|let'?s do it|go for it)\b/
// An ask to carry a plan out: "build it", "build the app", "implement the plan", "implement it exactly like that".
const BUILD =
  /^(?:build|implement|execute|carry out|start on|do) (?:it|this|that|them|everything|all of it|the [\w-]+(?: [\w-]+){0,2})\b/
// Words before an answer that are not the answer: "ok, build it", "great plan! go ahead", "perfect, implement it".
const LEAD =
  /^(?:(?:(?:great|nice|good|solid) plan|(?:looks|sounds) great|ok|okay|alright|great|perfect|awesome|nice|cool|excellent|thanks|thank you)[\s,.!:;-]+)+/

const VOCATIVES = set([
  "vector",
  "claude",
  "there",
  "team",
  "everyone",
  "all",
  "buddy",
  "friend",
  "mate",
  "guys",
  "folks",
])
const GREETINGS = set([
  "hi",
  "hey",
  "hello",
  "hiya",
  "howdy",
  "yo",
  "sup",
  "wassup",
  "whats up",
  "gm",
  "good morning",
  "good afternoon",
  "good evening",
  "morning",
  "evening",
  "hola",
  "bonjour",
  "hallo",
  "ciao",
  "namaste",
  "salut",
  "hej",
  "你好",
  "こんにちは",
  "안녕하세요",
])
const SMALL_TALK = set([
  "how are you",
  "how are you doing",
  "how r u",
  "how are u",
  "hows it going",
  "how is it going",
  "how have you been",
  "hope you are well",
  "hope youre well",
  "you there",
  "are you there",
  "can you help me",
  "can you help",
  "could you help me",
  "nice to meet you",
  // Answers to the agent's own small talk ("How about you?").
  "im good",
  "im fine",
  "im great",
  "im well",
  "im doing well",
  "im doing good",
  "im doing great",
  "doing well",
  "doing good",
  "doing great",
  "not bad",
  "pretty good",
  "you",
  "and you",
  "how about you",
  "what about you",
  "hows your day",
  "hows your day going",
])
const THANKS = set([
  "thanks",
  "thank you",
  "thank u",
  "thankyou",
  "thanku",
  "thx",
  "thnx",
  "thanx",
  "thnks",
  "tnx",
  "ty",
  "tysm",
  "cheers",
  "appreciate it",
  "much appreciated",
  "many thanks",
  "gracias",
  "merci",
  "danke",
])
const FAREWELLS = set([
  "bye",
  "goodbye",
  "bye bye",
  "see you",
  "see ya",
  "cya",
  "later",
  "bye for now",
  "good night",
  "gn",
  "ttyl",
  "talk soon",
  "talk later",
  "have a good one",
  "have a nice day",
  "have a good day",
])
const REACTIONS = set([
  "nice",
  "cool",
  "great",
  "awesome",
  "perfect",
  "lol",
  "haha",
  "wow",
  "amazing",
  "sweet",
  "neat",
  "nice work",
  "great job",
  "good job",
  "well done",
  "love it",
  "nice one",
  "great work",
  "good work",
  "excellent",
  "brilliant",
  "fantastic",
  "wonderful",
  "thats great",
  "thats awesome",
  "youre the best",
  "you rock",
  // Answers to the agent's own courtesy: "No problem!", "You too!".
  "np",
  "no problem",
  "no worries",
  "you too",
  "same to you",
])
// Acknowledgements, social only beside another social phrase: "got it, thanks", "sounds great, thanks", "good, thanks".
const ACKS = set([
  "got it",
  "gotcha",
  "understood",
  "noted",
  "sounds great",
  "sounds good",
  "good",
  "fine",
  "fair enough",
])
// Acknowledgements that are social on their own, unless a plan waits on them: "ok", "got it".
const ACKNOWLEDGEMENTS = set(["ok", "okay", "okey", "okie", "k", "kk", "alright", "got it", "gotcha", "ok got it", "okay got it"])
// Words that may sit inside a social message without being one: "ok thanks", "thanks a lot", "hello again", "how are
// you doing today", a name.
const FILLERS = set([
  ...VOCATIVES,
  "ok",
  "okay",
  "alright",
  "oh",
  "ah",
  "again",
  "today",
  "tomorrow",
  "so much",
  "a lot",
  "a ton",
  "in advance",
  "very much",
  "man",
  "dude",
  "bro",
])
// Questions about Vector itself, read whole: "vector" in them is the subject, not a name.
const VECTOR_QUESTIONS = set([
  "who are you",
  "what are you",
  "what can you do",
  "what can you help with",
  "what can you help me with",
  "what model are you",
  "which model are you",
  "what model is this",
  "which model is this",
  "what model are you using",
  "which model are you using",
  "what llm are you",
  "are you claude",
  "is this claude",
  "whats your name",
  "what is your name",
  "who made you",
  "who built you",
  "what is vector",
  "whats vector",
  "who made vector",
  "who built vector",
  "who makes vector",
  "who created vector",
  "what does vector do",
  "what can vector do",
  "how does vector work",
  "how do i use vector",
  "how to use vector",
  "help",
  "are you an ai",
  "are you a bot",
  "are you human",
])
const PHRASES = [
  ["greeting", GREETINGS],
  ["greeting", SMALL_TALK],
  ["thanks", THANKS],
  ["farewell", FAREWELLS],
  ["reaction", REACTIONS],
  ["ack", ACKS],
  ["filler", FILLERS],
] as const
// The kind that names a social message: a thanks or a report that it works settles the work before it, a greeting
// answers nothing.
const SOCIAL_ORDER = [
  "thanks",
  "success",
  "farewell",
  "reaction",
  "greeting",
  "about-vector",
] as const satisfies readonly Kind[]
// The user reporting that it works, as typed: "it works now", "that fixed it", "thats what i wanted".
const SUCCESS =
  /^(?:(?:it|its|that|thats|this|everything|all|the (?:build|tests?|app|fix|deploy|site|page))(?: is| was| are| now)? )?(?:works?|worked|working|fixed|solved|resolved|passing|passes|passed|green|builds)(?: now| again| perfectly| great| fine| well| as expected| for me)*$|^(?:that|it|this) (?:did it|did the trick|fixed it|solved it|helped|was it)$|^thats (?:what i (?:wanted|needed)|perfect|exactly it|exactly what i wanted)$|^(?:problem solved|all set|all good now|looks good now)$/
// Words that make a thanks also a new ask: "thanks for that, can you now ...".
const ASKING = /\b(?:can|could|would|will|please|pls|now|also|next|then|but|need|want)\b/
// The closed word classes a thanks's object is read with (see `thing`).
const DETERMINERS = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "all",
  "every",
  "everything",
  "such",
])
const PRONOUNS = new Set(["it", "them", "me", "us", "him", "you", "i", "we", "they"])
const PREPOSITIONS = new Set([
  "to",
  "of",
  "on",
  "in",
  "into",
  "with",
  "for",
  "across",
  "from",
  "at",
  "around",
  "about",
  "over",
  "under",
])
const QUESTION_WORDS = new Set(["what", "why", "how", "where", "when", "which", "who", "whose"])
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|‍|️|[\u{1F3FB}-\u{1F3FF}]|\s)+$/u

const LOG_LINE =
  /^\s*(?:at\s+\S.*(?:\(.*:\d+(?::\d+)?\)|:\d+:\d+)$|File ".+", line \d+|Traceback \(most recent call last\)|\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|npm (?:ERR!|WARN)|Caused by:|\s*\^+\s*$)/
const PATH =
  /(?:^|[\s"'(])(?:[\w@.-]+\/)+[\w@.-]+|\b[\w@-]+\.(?:tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|html|py|rb|go|rs|java|kt|swift|cc?|cpp|hpp?|cs|php|vue|svelte|astro|ya?ml|toml|sql|sh|txt|lock)\b/i
const URL_PATTERN = /\bhttps?:\/\/\S+/i

const NO_SUBAGENTS =
  /\b(?:no|don'?t|do not|without|never|skip(?: the)?)\s+(?:use\s+|using\s+|launch(?:ing)?\s+|spawn(?:ing)?\s+|any\s+|the\s+)*(?:sub-?agents?|parallel agents|agents)\b/
const NO_JUDGE =
  /\b(?:no|don'?t|do not|without|never|skip(?: the)?)\s+(?:use\s+|using\s+|run(?:ning)?\s+|the\s+|any\s+|an?\s+)*(?:llm[- ]as[- ]a[- ])?judge\b/
// "Don't be thorough", "no need to go deep", "don't think too hard": the user taking back a force word. Style words such
// as "keep it simple" or "don't overthink it" describe the answer they want, not the size of the job, so they are not
// here.
const NOT_THOROUGH =
  /\b(?:no|don'?t|do not|no need to|needn'?t|without|stop)\s+(?:be(?:ing)?\s+|get(?:ting)?\s+|too\s+|so\s+|very\s+|overly\s+|super\s+|extra\s+|that\s+|a\s+)*(?:thorough(?:ly)?|exhaustive(?:ly)?|deep[- ]dive|go(?:ing)? (?:too )?deep|think (?:too )?hard(?:er)?|take your time)\b/
const SUBAGENTS = "(?:some |a few |multiple |several |parallel |many |the |\\d+ )?(?:sub-?agents?|parallel agents)"
const JUDGE = "(?:the |an? )?(?:llm[- ]as[- ]an?[- ])?judge"
// What may follow an ask for subagents or the judge so it is about this request: nothing, what to use them on or for
// ("on this", "for the migration", "to port each package"), or when ("at the end", "when you're done"). Anything else
// is a request about the feature itself: "run the judge tests", "use the judge agent's prompt", "use the judge only for
// large tasks", "use subagents in background mode by default", "start the subagents service", "run subagents.test.ts".
const FOR_THIS =
  "(?=$|\\s+(?:on|for|over|across|against|to|in parallel|here|again|too|as well|now|first|afterwards|at the end|as needed|if (?:needed|useful|it helps)|where (?:possible|useful|it helps|it makes sense)|when (?:you(?:'re| are) )?(?:done|finished)|after (?:this|that|it|you(?:'re| are)? (?:done|finished)|the (?:work|change|changes|fix|migration)))(?:\\s|$))"
// A check the user asks the judge to make: "have the judge check it", "get the judge to review the diff".
const CHECK = "(?=\\s+(?:check|verify|review|look at|inspect|grade|confirm|validate)(?:\\s|$))"
// Each force word as an instruction: how a clause that asks for it starts, and what an imperative clause may say inside.
const FORCE: ReadonlyArray<readonly [code: string, start: RegExp, inside?: RegExp]> = [
  [
    "explicit:thorough",
    /^(?:be (?:very |extra |really |super |more |as |fully )?(?:thorough|exhaustive)|be (?:very|extra|really|super) careful|(?:thorough|thoroughly|exhaustively)$|(?:i (?:want|need)|i'?d like|i would like) (?:this|it|that|the [\w-]+(?: [\w-]+)?) (?:done |handled |checked |reviewed |tested |looked at )?(?:thoroughly|exhaustively|in depth)$|(?:do|give me|make it|run) (?:a |an )?(?:thorough|exhaustive|deep|in-depth) (?:job|pass|dive|review|audit|analysis|investigation|look)|(?:an? )?(?:thorough|exhaustive|in-depth) (?:job|pass|review|audit|analysis|investigation|look|check)|(?:do a )?deep[- ]dive|(?:go deep|dig deep|take your time)(?=$|\s+(?:on|into|with|here|for|and|to)\b))\b/,
    /\b(?:thoroughly|exhaustively)\b/,
  ],
  ["explicit:think", /^(?:ultrathink|think (?:hard|harder|deeply|very carefully|really hard))\b/],
  [
    "explicit:subagents",
    new RegExp(
      `^(?:use|using|launch|spin up|spawn|start|bring in|run|delegate to) ${SUBAGENTS}${FOR_THIS}|^split (?:it|this|the work) (?:across|between|among) ${SUBAGENTS}${FOR_THIS}`,
    ),
    new RegExp(`\\b(?:with|using|via|across) ${SUBAGENTS}$`),
  ],
  [
    "explicit:judge",
    new RegExp(
      `^(?:use|run|launch|bring in|have|get|call|start|ask|invoke|enable) ${JUDGE}(?:${FOR_THIS}|${CHECK})|^judge (?:it|this|that|the (?:work|result|results|change|changes|diff))$`,
    ),
    new RegExp(`\\b(?:with|using|via) ${JUDGE}$`),
  ],
]
// The words around an ask that are not the ask: "please", "can you", "just", "go ahead and".
const POLITE_START =
  /^(?:(?:please|pls|plz|kindly|now|then|also|just|ok|okay|so|alright|actually|quickly|go ahead and|can you|could you|would you|will you|can u|could u|i want you to|i'd like you to|id like you to|i need you to|make sure (?:to|you))\s+)+/
// Subjects that make a clause starting with "do" a question: "do you", "do we".
const SUBJECTS = new Set(["i", "you", "u", "we", "they", "he", "she"])
// Words a statement or a question starts with; an imperative clause starts with its verb instead.
const NOT_IMPERATIVE = new Set([
  "i",
  "i'm",
  "im",
  "i've",
  "i'd",
  "we",
  "we're",
  "you",
  "you're",
  "it",
  "it's",
  "its",
  "they",
  "they're",
  "he",
  "she",
  "this",
  "that",
  "these",
  "those",
  "the",
  "a",
  "an",
  "my",
  "our",
  "your",
  "their",
  "there",
  "here",
  "what",
  "why",
  "how",
  "when",
  "where",
  "which",
  "who",
  "whose",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "should",
  "would",
  "could",
  "can",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "if",
  "because",
  "since",
  "although",
  "though",
  "as",
  "not",
  "no",
  "every",
  "all",
  "some",
  "any",
  "each",
])
// Closing courtesies that offer no particular work, a greeting reply's "How can I help?" included. Each is a whole
// sentence: one that names work ("What would you like me to do first?") asks something.
const PLEASANTRY =
  /^(?:(?:is there )?(?:anything|something) else(?: (?:i can (?:help(?: you)? with|do(?: for you)?)|you(?:'d| would)? like(?: me to (?:do|help with|look at))?|you need(?: help with)?|on your mind))?|(?:do you have )?any (?:other |more |further )?questions|(?:let me know|feel free to (?:ask|reach out|let me know)|just let me know) if (?:you(?:'d| would)? (?:need|have|want|like) )?(?:anything else|any (?:other |more |further )?(?:questions|changes|tweaks|adjustments|help))(?: (?:i can help with|you need))?|(?:let me know|feel free to reach out|just let me know) if (?:anything (?:else )?comes up|something (?:else )?comes up|you run into (?:any )?(?:issues|problems|trouble))|if you need anything else(?:, (?:just )?let me know)?|(?:how can i|how may i) help(?: you)?(?: today| further)?|what can i (?:help(?: you)? with|do for you)(?: today)?|what (?:would you like|do you want)(?: me)? to (?:work on|do)(?: today)?|what are we working on(?: today)?|happy to help(?: further| with anything else)?|hope (?:this|that) helps)$/
// A closing line that asks nothing on its own: "Let me know!", "Let me know if this works for you.", "Just say the word.",
// "Either way works.", "Happy to adjust if needed.", "Hope this helps!". With a question mark it still asks.
const COURTESY =
  /^(?:(?:just |please )?(?:let me know|say the word|tell me)\b.*|feel free\b.*|happy to\b.*|hope (?:this|that|it)\b.*|either way(?: works| is fine)?|whatever you prefer|(?:it's |its )?(?:your call|up to you)|no rush|no pressure|thanks|thank you|cheers)$/
// A line of a list, a heading or a table: the shape of a summary after the reply's prose.
const STRUCTURE = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\||>|\*\*[^*]+\*\*:?\s*$|__[^_]+__:?\s*$)/
// Markdown, emoji and smileys around a sentence, which say nothing about whether it asks.
const EDGES_START = /^[\s*_`>#-]+/
const EDGES_END = /(?:[\s*_`)\]:;]|\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|\u200d|\ufe0f)+$/u
