import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"

// The eval's budget ledger (VectorScope plan, VS-03; Phase 0 "Budget, privacy and release gate"). One coordinator
// admits every paid provider or judge attempt, retries included, against an owner-set total budget and a per-case
// bound, before the attempt is sent. Admission is synchronous, so attempts running in parallel can never each claim
// the same remainder. A reservation is a conservative estimate. Settlement replaces it with the cost the provider
// reported; an attempt with no usable usage keeps its whole reservation as uncertain spend, never zero. New work stops
// when a price cannot bound an estimate, when reported usage cannot be read, when a settled cost overshoots its
// reservation, or when the run is cancelled. A share of the budget is held back as a reserve for that overshoot.
//
// None of this is a billing cap. Reported usage can exceed an estimate, so the provider-side spend limit on the eval's
// own key (D7) is the stronger boundary, and the ledger reports any overshoot rather than hiding it.
//
// The ledger can keep an append-only journal, so successive processes (one per model in CI) share one budget, and an
// attempt admitted by a process that was killed is still counted. Every admission is written before its request is
// sent, and every change to the ledger is an entry, so reading a journal back rebuilds exactly what was decided.

// Held back from admission to absorb reported usage above the estimates.
export const RESERVE_SHARE = 0.1
// Input tokens are estimated from characters at this rate. Code and English usually run at three to four characters
// per token; two keeps an estimate above what a tokenizer is likely to count.
export const CHARS_PER_TOKEN = 2
export const KINDS = ["provider", "judge"] as const
export const REFUSALS = ["cancelled", "halted", "unpriced", "case", "budget"] as const

// Float sums of dollar amounts drift by far less than this.
const EPSILON = 1e-9

export type Kind = (typeof KINDS)[number]
export type Refusal = (typeof REFUSALS)[number]

// USD per million tokens.
export interface Price {
  input: number
  output: number
}

export interface Limits {
  totalUsd: number // the whole run: every model, case, retry and judge call
  caseUsd: number // one case: one fixture or dataset case reviewed once by one model, with its retries and judge calls
  reserveUsd: number // never admitted; it absorbs overshoot
}

// One attempt to admit: a provider request or a judge call, charged to a case.
export interface Request {
  case: string
  kind: Kind
  model: string
  estimateUsd: number // the most this attempt is expected to cost; not finite means its price cannot bound it
  note?: string // what the attempt is, such as "json_schema" or "text retry"
}

// How an attempt settled:
//   reported   the provider reported the cost
//   tokens     the provider reported tokens, priced at the run's pricing snapshot
//   replay     a replay's attempts, each settled by the engine's own admission
//   none       no usable usage came back, so the whole reservation is kept as uncertain spend
//   unsettled  never settled (cancelled in flight, or its process stopped), so the whole reservation is kept
//   invalid    the reported usage could not be read, so the whole reservation is kept and new work stops
export type Basis = "reported" | "tokens" | "replay" | "none" | "unsettled" | "invalid"

export interface Usage {
  costUsd?: number // known spend
  uncertainUsd?: number // further exposure the caller could not settle, such as a replay's incomplete attempts
  basis?: Extract<Basis, "reported" | "tokens" | "replay">
}

export type Entry =
  | { type: "open"; at: string; limits: Limits }
  | {
      type: "admit"
      at: string
      seq: number
      case: string
      kind: Kind
      model: string
      note?: string
      reservedUsd: number
    }
  | {
      type: "refuse"
      at: string
      case: string
      kind: Kind
      model: string
      note?: string
      estimateUsd?: number // absent when the estimate was not a finite amount
      reason: Refusal
      detail: string
    }
  | { type: "sent"; at: string; seq: number }
  | {
      type: "settle"
      at: string
      seq: number
      costUsd?: number
      uncertainUsd: number
      overshootUsd: number
      basis: Basis
    }
  | { type: "release"; at: string; seq: number }
  | { type: "halt"; at: string; reason: string }
  | { type: "cancel"; at: string; reason: string }

export interface Settlement {
  costUsd?: number
  uncertainUsd: number
  overshootUsd: number
  basis: Basis
}

export interface Ticket {
  readonly seq: number
  readonly case: string
  readonly reservedUsd: number
  // The request has left. From here, a release keeps the reservation as uncertain spend.
  sent(): void
  // What the attempt cost. With no usage at all, the whole reservation is kept as uncertain spend.
  settle(usage?: Usage): Settlement
  // The attempt is over without a settlement. Never sent: the reservation is returned. Sent: it is kept as uncertain.
  release(): Settlement | undefined
}

export type Admission = { admitted: true; ticket: Ticket } | { admitted: false; reason: Refusal; detail: string }

export interface CaseSummary {
  case: string
  spentUsd: number
  uncertainUsd: number
  outstandingUsd: number
  admitted: number
  refused: number
}

export interface Summary {
  limits: Limits
  admissibleUsd: number // the total less the reserve
  spentUsd: number // settled at a reported or token-priced cost
  uncertainUsd: number // kept for attempts whose cost is not known
  outstandingUsd: number // admitted and not yet settled
  committedUsd: number // spent, uncertain and outstanding together
  remainingUsd: number // what admission can still grant
  overshootUsd: number // settled beyond the attempts' reservations
  overBudgetUsd: number // spent and uncertain beyond the total budget
  attempts: {
    admitted: number
    settled: number // with a known cost, whether or not part of it is uncertain
    uncertain: number // whose whole reservation is kept because their cost is not known
    released: number // never sent
    open: number
    refused: Record<Refusal, number>
  }
  halted?: string
  cancelled?: string
  cases: CaseSummary[]
}

export class LedgerError extends Error {}

interface Open {
  case: string
  reservedUsd: number
  sent: boolean
}

interface CaseState {
  spentUsd: number
  uncertainUsd: number
  admitted: number
  refused: number
}

export function defaultLimits(totalUsd: number, caseUsd: number): Limits {
  return { totalUsd, caseUsd, reserveUsd: totalUsd * RESERVE_SHARE }
}

export function limitProblems(limits: Limits): string[] {
  const amount = (value: number) => typeof value === "number" && Number.isFinite(value)
  const problems = [
    ...(amount(limits.totalUsd) && limits.totalUsd > 0
      ? []
      : ["the total budget must be a finite positive USD amount"]),
    ...(amount(limits.caseUsd) && limits.caseUsd > 0
      ? []
      : ["the per-case bound must be a finite positive USD amount"]),
    ...(amount(limits.reserveUsd) && limits.reserveUsd >= 0 ? [] : ["the reserve must be a finite USD amount"]),
  ]
  if (problems.length) return problems
  if (limits.reserveUsd >= limits.totalUsd) return ["the reserve must leave part of the total budget to spend"]
  if (limits.caseUsd > limits.totalUsd - limits.reserveUsd + EPSILON)
    return [
      `the per-case bound ($${limits.caseUsd}) is more than the $${round(limits.totalUsd - limits.reserveUsd)} the budget admits after its reserve`,
    ]
  return []
}

export function priceProblems(price: Price): string[] {
  const valid = (value: number) => typeof value === "number" && Number.isFinite(value) && value >= 0
  return valid(price.input) && valid(price.output)
    ? []
    : ["a price is USD per million input and output tokens, two finite amounts of at least 0"]
}

// "3:15" is $3 per million input tokens and $15 per million output tokens.
export function parsePrice(text: string): Price | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!match) return undefined
  const price = { input: Number(match[1]), output: Number(match[2]) }
  return priceProblems(price).length ? undefined : price
}

// The most one request is expected to cost: its whole body counted as input at CHARS_PER_TOKEN, and every output
// token the request allows. NaN when the price or limits are not usable, which admission refuses.
export function estimateUsd(input: { chars: number; maxTokens: number; price: Price }): number {
  if (priceProblems(input.price).length) return Number.NaN
  if (!Number.isInteger(input.chars) || input.chars < 0) return Number.NaN
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1) return Number.NaN
  return (
    (Math.ceil(input.chars / CHARS_PER_TOKEN) * input.price.input + input.maxTokens * input.price.output) / 1_000_000
  )
}

export class Ledger {
  readonly limits: Limits
  readonly #controller = new AbortController()
  readonly #entries: Entry[] = []
  readonly #open = new Map<number, Open>()
  readonly #cases = new Map<string, CaseState>()
  readonly #refused = Object.fromEntries(REFUSALS.map((reason) => [reason, 0])) as Record<Refusal, number>
  readonly #journal?: string
  readonly #lock?: string
  readonly #now: () => Date
  #seq = 0
  #spent = 0
  #uncertain = 0
  #overshoot = 0
  #admitted = 0
  #settled = 0
  #uncertainCount = 0
  #released = 0
  #halted?: string
  #cancelled?: string
  #closed = false

  private constructor(input: { limits: Limits; journal?: string; lock?: string; now?: () => Date }) {
    this.limits = { ...input.limits }
    this.#journal = input.journal
    this.#lock = input.lock
    this.#now = input.now ?? (() => new Date())
  }

  // A ledger for one run. With a journal, an existing one is read back first (its limits must match) and every later
  // entry is appended to it; an attempt a stopped process admitted and never settled is settled as uncertain. The
  // journal is locked while the ledger is open, so two processes never admit against the same budget at once.
  static open(input: { limits: Limits; journal?: string; now?: () => Date }): Ledger {
    const problems = limitProblems(input.limits)
    if (problems.length) throw new LedgerError(problems.join("; "))
    if (!input.journal) {
      const ledger = new Ledger(input)
      ledger.#record({ type: "open", at: ledger.#at(), limits: ledger.limits })
      return ledger
    }
    const lock = `${input.journal}.lock`
    try {
      const fd = openSync(lock, "wx")
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new LedgerError(
          `${input.journal} is in use by another run, or by one that stopped without closing it. Check that no eval is running, then remove ${lock}.`,
        )
      throw error
    }
    try {
      const prior = existsSync(input.journal) ? readJournal(input.journal) : []
      const ledger = new Ledger({ ...input, lock })
      if (prior.length) {
        const header = prior[0]
        if (header?.type !== "open") throw new LedgerError(`${input.journal} does not start with its limits`)
        if (!sameLimits(header.limits, input.limits))
          throw new LedgerError(
            `${input.journal} was opened with different limits (${describeLimits(header.limits)}), not ${describeLimits(input.limits)}`,
          )
        for (const entry of prior) ledger.#apply(entry)
        // Whatever a stopped process admitted and never settled may have been sent and billed.
        for (const seq of [...ledger.#open.keys()]) ledger.#settleOpen(seq, "unsettled")
      } else ledger.#record({ type: "open", at: ledger.#at(), limits: ledger.limits })
      return ledger
    } catch (error) {
      rmSync(lock, { force: true })
      throw error
    }
  }

  // A journal's summary without opening it for writing: an attempt still open counts as uncertain at its reservation.
  static inspect(journal: string): Summary {
    const entries = readJournal(journal)
    const header = entries[0]
    if (header?.type !== "open") throw new LedgerError(`${journal} does not start with its limits`)
    const ledger = new Ledger({ limits: header.limits })
    for (const entry of entries) ledger.#apply(entry)
    return ledger.#summary(true)
  }

  // Aborted when the run is cancelled; attempts in flight should pass it to their requests.
  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get entries(): readonly Entry[] {
    return this.#entries
  }

  admit(request: Request): Admission {
    if (this.#closed) throw new LedgerError("the ledger is closed")
    const base = {
      case: request.case,
      kind: request.kind,
      model: request.model,
      ...(request.note ? { note: request.note } : {}),
    }
    const estimate = request.estimateUsd
    const refuse = (reason: Refusal, detail: string): Admission => {
      this.#record({
        type: "refuse",
        at: this.#at(),
        ...base,
        ...(Number.isFinite(estimate) ? { estimateUsd: estimate } : {}),
        reason,
        detail,
      })
      return { admitted: false, reason, detail }
    }
    if (this.#cancelled) return refuse("cancelled", `the run was cancelled (${this.#cancelled})`)
    if (this.#halted) return refuse("halted", this.#halted)
    if (!KINDS.includes(request.kind)) throw new LedgerError(`unknown attempt kind ${String(request.kind)}`)
    if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0) {
      const refused = refuse("unpriced", `no price bounds what ${request.model} could cost`)
      this.#halt(`pricing for ${request.model} cannot bound its cost, so no new work is admitted`)
      return refused
    }
    const ofCase = this.#caseCommitted(request.case)
    if (ofCase + estimate > this.limits.caseUsd + EPSILON)
      return refuse(
        "case",
        `this attempt's estimate of $${money(estimate)} would take the case to $${money(ofCase + estimate)}, over its $${money(this.limits.caseUsd)} bound`,
      )
    const committed = this.#committed()
    const admissible = this.limits.totalUsd - this.limits.reserveUsd
    if (committed + estimate > admissible + EPSILON)
      return refuse(
        "budget",
        `this attempt's estimate of $${money(estimate)} does not fit in the $${money(Math.max(0, admissible - committed))} left of the budget`,
      )
    const seq = this.#seq + 1
    this.#record({ type: "admit", at: this.#at(), seq, ...base, reservedUsd: estimate })
    return { admitted: true, ticket: this.#ticket(seq, request.case, estimate) }
  }

  // Stops new admissions and aborts the signal. Attempts in flight still settle, and as uncertain when they cannot.
  cancel(reason: string) {
    if (this.#closed || this.#cancelled) return
    this.#record({ type: "cancel", at: this.#at(), reason })
  }

  summary(): Summary {
    return this.#summary(false)
  }

  // Ends the ledger: an attempt still open is settled as uncertain at its reservation, and the journal is unlocked.
  close(): Summary {
    if (!this.#closed) {
      for (const seq of [...this.#open.keys()]) this.#settleOpen(seq, "unsettled")
      this.#closed = true
      if (this.#lock) rmSync(this.#lock, { force: true })
    }
    return this.#summary(false)
  }

  #ticket(seq: number, name: string, reservedUsd: number): Ticket {
    return {
      seq,
      case: name,
      reservedUsd,
      sent: () => {
        const open = this.#open.get(seq)
        if (open && !open.sent) this.#record({ type: "sent", at: this.#at(), seq })
      },
      settle: (usage = {}) => this.#settle(seq, usage),
      release: () => {
        const open = this.#open.get(seq)
        if (!open) return undefined
        if (open.sent) return this.#settleOpen(seq, "unsettled")
        this.#record({ type: "release", at: this.#at(), seq })
        return undefined
      },
    }
  }

  #settle(seq: number, usage: Usage): Settlement {
    const open = this.#open.get(seq)
    if (!open) throw new LedgerError(`attempt ${seq} was already settled or released`)
    const amount = (value: number | undefined) =>
      value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0)
    if (!amount(usage.costUsd) || !amount(usage.uncertainUsd)) {
      const settlement = this.#settleOpen(seq, "invalid")
      this.#halt(`the usage reported for attempt ${seq} could not be read, so spend can no longer be bounded`)
      return settlement
    }
    if (usage.costUsd === undefined && usage.uncertainUsd === undefined) return this.#settleOpen(seq, "none")
    const cost = usage.costUsd ?? 0
    const uncertain = usage.uncertainUsd ?? 0
    const over = cost + uncertain - open.reservedUsd
    const overshoot = over > EPSILON ? over : 0
    const settlement: Settlement = {
      ...(usage.costUsd !== undefined ? { costUsd: cost } : {}),
      uncertainUsd: uncertain,
      overshootUsd: overshoot,
      basis: usage.basis ?? "reported",
    }
    this.#record({ type: "settle", at: this.#at(), seq, ...settlement })
    if (overshoot > 0)
      this.#halt(
        `attempt ${seq} settled at $${money(cost + uncertain)}, over its $${money(open.reservedUsd)} reservation, so the estimates no longer bound spend`,
      )
    return settlement
  }

  // The whole reservation kept as uncertain spend.
  #settleOpen(seq: number, basis: Extract<Basis, "none" | "unsettled" | "invalid">): Settlement {
    const open = this.#open.get(seq)!
    const settlement: Settlement = { uncertainUsd: open.reservedUsd, overshootUsd: 0, basis }
    this.#record({ type: "settle", at: this.#at(), seq, ...settlement })
    return settlement
  }

  #halt(reason: string) {
    if (!this.#halted) this.#record({ type: "halt", at: this.#at(), reason })
  }

  // Written to the journal first, then applied: a failed write admits nothing.
  #record(entry: Entry) {
    if (this.#journal) appendFileSync(this.#journal, JSON.stringify(entry) + "\n")
    this.#apply(entry)
  }

  #apply(entry: Entry) {
    this.#entries.push(entry)
    switch (entry.type) {
      case "open":
        return
      case "admit":
        this.#seq = Math.max(this.#seq, entry.seq)
        this.#open.set(entry.seq, { case: entry.case, reservedUsd: entry.reservedUsd, sent: false })
        this.#admitted++
        this.#caseState(entry.case).admitted++
        return
      case "refuse":
        this.#refused[entry.reason]++
        this.#caseState(entry.case).refused++
        return
      case "sent": {
        const open = this.#open.get(entry.seq)
        if (open) open.sent = true
        return
      }
      case "settle": {
        const open = this.#open.get(entry.seq)
        if (!open) return
        this.#open.delete(entry.seq)
        const state = this.#caseState(open.case)
        this.#spent += entry.costUsd ?? 0
        this.#uncertain += entry.uncertainUsd
        this.#overshoot += entry.overshootUsd
        state.spentUsd += entry.costUsd ?? 0
        state.uncertainUsd += entry.uncertainUsd
        if (entry.costUsd === undefined) this.#uncertainCount++
        else this.#settled++
        return
      }
      case "release":
        if (this.#open.delete(entry.seq)) this.#released++
        return
      case "halt":
        this.#halted ??= entry.reason
        return
      case "cancel":
        this.#cancelled ??= entry.reason
        this.#controller.abort(new Error(`the eval was cancelled: ${entry.reason}`))
        return
    }
  }

  #caseState(name: string) {
    const existing = this.#cases.get(name)
    if (existing) return existing
    const state = { spentUsd: 0, uncertainUsd: 0, admitted: 0, refused: 0 }
    this.#cases.set(name, state)
    return state
  }

  #outstanding(name?: string) {
    let total = 0
    for (const open of this.#open.values()) if (name === undefined || open.case === name) total += open.reservedUsd
    return total
  }

  #caseCommitted(name: string) {
    const state = this.#cases.get(name)
    return (state ? state.spentUsd + state.uncertainUsd : 0) + this.#outstanding(name)
  }

  #committed() {
    return this.#spent + this.#uncertain + this.#outstanding()
  }

  #summary(openAsUncertain: boolean): Summary {
    const outstanding = this.#outstanding()
    // Read back from a journal, an attempt still open may belong to a process that stopped: it may have been billed.
    const uncertain = this.#uncertain + (openAsUncertain ? outstanding : 0)
    const inFlight = openAsUncertain ? 0 : outstanding
    const admissible = this.limits.totalUsd - this.limits.reserveUsd
    const committed = this.#spent + uncertain + inFlight
    return {
      limits: { ...this.limits },
      admissibleUsd: admissible,
      spentUsd: this.#spent,
      uncertainUsd: uncertain,
      outstandingUsd: inFlight,
      committedUsd: committed,
      remainingUsd: Math.max(0, admissible - committed),
      overshootUsd: this.#overshoot,
      overBudgetUsd: Math.max(0, this.#spent + uncertain - this.limits.totalUsd),
      attempts: {
        admitted: this.#admitted,
        settled: this.#settled,
        uncertain: this.#uncertainCount + (openAsUncertain ? this.#open.size : 0),
        released: this.#released,
        open: openAsUncertain ? 0 : this.#open.size,
        refused: { ...this.#refused },
      },
      ...(this.#halted ? { halted: this.#halted } : {}),
      ...(this.#cancelled ? { cancelled: this.#cancelled } : {}),
      cases: [...this.#cases].map(([name, state]) => {
        const open = this.#outstanding(name)
        return {
          case: name,
          spentUsd: state.spentUsd,
          uncertainUsd: state.uncertainUsd + (openAsUncertain ? open : 0),
          outstandingUsd: openAsUncertain ? 0 : open,
          admitted: state.admitted,
          refused: state.refused,
        }
      }),
    }
  }

  #at() {
    return this.#now().toISOString()
  }
}

// A few lines for a terminal or a run summary. The numbers are estimates and reported usage, not a bill.
export function formatSummary(summary: Summary): string {
  const { limits, attempts } = summary
  const refused = REFUSALS.filter((reason) => attempts.refused[reason] > 0)
  const refusedCount = refused.reduce((total, reason) => total + attempts.refused[reason], 0)
  return [
    `Budget $${money(limits.totalUsd, 2)} ($${money(limits.reserveUsd, 2)} held in reserve), at most $${money(limits.caseUsd, 2)} per case.`,
    `Spent $${money(summary.spentUsd)} as reported, $${money(summary.uncertainUsd)} uncertain (kept in full because the cost is not known)` +
      (summary.outstandingUsd > 0 ? `, $${money(summary.outstandingUsd)} still in flight` : "") +
      `; $${money(summary.remainingUsd)} left to admit.`,
    `${attempts.admitted} attempt(s) admitted: ${attempts.settled} settled, ${attempts.uncertain} uncertain, ${attempts.released} released unsent` +
      (attempts.open ? `, ${attempts.open} open` : "") +
      `. ${refusedCount} refused${refused.length ? ` (${refused.map((reason) => `${reason} ${attempts.refused[reason]}`).join(", ")})` : ""}.`,
    summary.overshootUsd > 0
      ? `Overshoot: $${money(summary.overshootUsd)} reported above the reservations.`
      : "Overshoot: none reported above the reservations.",
    ...(summary.overBudgetUsd > 0 ? [`Over budget: $${money(summary.overBudgetUsd)} above the total.`] : []),
    ...(summary.halted ? [`Stopped admitting: ${summary.halted}.`] : []),
    ...(summary.cancelled ? [`Cancelled: ${summary.cancelled}.`] : []),
    "Reservations are estimates and costs are as reported. The provider-side limit on the key is the hard boundary.",
  ].join("\n")
}

export function money(value: number, digits = 4) {
  return value.toFixed(digits)
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function sameLimits(a: Limits, b: Limits) {
  return (
    Math.abs(a.totalUsd - b.totalUsd) < EPSILON &&
    Math.abs(a.caseUsd - b.caseUsd) < EPSILON &&
    Math.abs(a.reserveUsd - b.reserveUsd) < EPSILON
  )
}

function describeLimits(limits: Limits) {
  return `total $${limits.totalUsd}, case $${limits.caseUsd}, reserve $${limits.reserveUsd}`
}

// A journal line cut off by a killed process is the last one; anything else unreadable is an error.
function readJournal(path: string): Entry[] {
  const lines = readFileSync(path, "utf8").split("\n")
  const entries: Entry[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as Entry)
    } catch {
      if (lines.slice(index + 1).some((rest) => rest.trim()))
        throw new LedgerError(`${path} line ${index + 1} is not a ledger entry`)
    }
  }
  return entries
}
