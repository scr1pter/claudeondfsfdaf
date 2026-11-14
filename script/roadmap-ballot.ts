// The owner's tool for the roadmap vote (WP A34): publishes each quarter's ballot, closes it, reads the count and the
// nominations, and records which candidate goes first when the top ones tie.
//
//   bun script/roadmap-ballot.ts open <quarter> --candidates <file.json> --closes <date> [--opens <date>] [--replace] --mode live|test
//   bun script/roadmap-ballot.ts close <quarter> [--at <date>] --mode live|test
//   bun script/roadmap-ballot.ts results <quarter> --mode live|test
//   bun script/roadmap-ballot.ts decide <quarter> <candidate-id> --mode live|test
//   bun script/roadmap-ballot.ts nominations <quarter> --mode live|test
//
// A quarter is written like 2026-q4 (UTC calendar quarters). The candidates file is a JSON list of 2 to 10
// {id, title, detail?}; their copy may not name a date, month, quarter or "soon", because the vote never says when:
// the winner is "planned for the next release cycle". A date is ISO 8601 (2026-12-15 means midnight UTC); the ballot
// opens now unless --opens says otherwise and closes inside its quarter. Ballots belong to the Codium store of one
// Stripe mode, so --mode is required: live once vectordev.ai takes live payments, test on a preview store. The store
// comes from KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*), as on vectordev.ai; they are never
// printed, and nothing here prints who voted or nominated.
import { readFile } from "node:fs/promises"
import type { StripeMode } from "../api/_lib/model-plan-stripe"
import {
  closeBallot,
  decideBallot,
  openBallot,
  ownerNominations,
  ownerTally,
  ROADMAP_MINIMUM,
  ROADMAP_PLANNED,
  validQuarter,
} from "../api/_lib/roadmap"

export type RoadmapBallotArguments =
  | {
      command: "open"
      quarter: string
      candidates: string
      closesAt: number
      opensAt?: number
      replace: boolean
      mode: StripeMode
    }
  | { command: "close"; quarter: string; at?: number; mode: StripeMode }
  | { command: "results" | "nominations"; quarter: string; mode: StripeMode }
  | { command: "decide"; quarter: string; winner: string; mode: StripeMode }

const USAGE =
  "Usage: bun script/roadmap-ballot.ts <open|close|results|decide|nominations> <quarter> [options] --mode live|test"
const VALUED = new Set(["candidates", "closes", "opens", "at", "mode"])
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/

/** An ISO 8601 date or time; a bare date is midnight UTC. */
export function parseRoadmapDate(value: string, flag: string) {
  const time = DATE.test(value) ? Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value) : NaN
  if (!Number.isSafeInteger(time)) throw new Error(`--${flag} takes an ISO date like 2026-12-15 or 2026-12-15T17:00Z.`)
  return time
}

/** Reads the command line, or throws with what is wrong. */
export function parseRoadmapArguments(argv: readonly string[]): RoadmapBallotArguments {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  let replace = false
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (!value.startsWith("--")) {
      positional.push(value)
      continue
    }
    const name = value.slice(2)
    if (name === "replace") {
      replace = true
      continue
    }
    const next = argv[index + 1]
    if (!VALUED.has(name) || next === undefined || next.startsWith("--") || name in flags)
      throw new Error(`Unknown, repeated or empty option ${value}.`)
    flags[name] = next
    index++
  }
  const [command, quarter, ...rest] = positional
  if (!command || !quarter) throw new Error(USAGE)
  if (!validQuarter(quarter)) throw new Error("A quarter is written like 2026-q4.")
  const mode = flags.mode
  if (mode !== "live" && mode !== "test") throw new Error("--mode is live or test.")
  const allowed: Record<string, string[]> = {
    open: ["candidates", "closes", "opens", "mode"],
    close: ["at", "mode"],
    results: ["mode"],
    decide: ["mode"],
    nominations: ["mode"],
  }
  const permitted = allowed[command]
  if (!permitted) throw new Error(USAGE)
  const extra = Object.keys(flags).find((name) => !permitted.includes(name))
  if (extra || (replace && command !== "open")) throw new Error(`--${extra ?? "replace"} does not go with ${command}.`)
  if (command === "decide") {
    if (rest.length !== 1) throw new Error("Usage: bun script/roadmap-ballot.ts decide <quarter> <candidate-id> --mode")
    return { command, quarter, winner: rest[0]!, mode }
  }
  if (rest.length) throw new Error(USAGE)
  if (command === "open") {
    if (!flags.candidates || !flags.closes) throw new Error("open needs --candidates <file.json> and --closes <date>.")
    return {
      command,
      quarter,
      candidates: flags.candidates,
      closesAt: parseRoadmapDate(flags.closes, "closes"),
      ...(flags.opens ? { opensAt: parseRoadmapDate(flags.opens, "opens") } : {}),
      replace,
      mode,
    }
  }
  if (command === "close")
    return { command, quarter, ...(flags.at ? { at: parseRoadmapDate(flags.at, "at") } : {}), mode }
  return { command: command as "results" | "nominations", quarter, mode }
}

const day = (time: number) => new Date(time).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z")

/** What the command prints, as lines. */
export async function runRoadmapBallot(
  input: RoadmapBallotArguments,
  options: { fetcher?: typeof fetch; now?: number; read?: (file: string) => Promise<string> } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now()
  const store = { mode: input.mode, ...(options.fetcher ? { fetcher: options.fetcher } : {}), now }
  switch (input.command) {
    case "open": {
      const text = await (options.read ?? ((file) => readFile(file, "utf8")))(input.candidates)
      let candidates: unknown
      try {
        candidates = JSON.parse(text)
      } catch {
        throw new Error(`${input.candidates} is not JSON.`)
      }
      const ballot = await openBallot(
        { quarter: input.quarter, opensAt: input.opensAt ?? now, closesAt: input.closesAt, candidates },
        { ...store, replace: input.replace },
      )
      return [
        `${ballot.quarter}: ballot published (${input.mode} store) with ${ballot.candidates.length} candidates.`,
        `Opens ${day(ballot.opensAt)}, closes ${day(ballot.closesAt)}.`,
      ]
    }
    case "close": {
      const ballot = await closeBallot(input.quarter, { ...store, ...(input.at ? { at: input.at } : {}) })
      return [`${ballot.quarter}: the vote now closes ${day(ballot.closesAt)} (${input.mode} store).`]
    }
    case "results": {
      const { ballot, counted, totals, leaders } = await ownerTally(input.quarter, store)
      const open = now < ballot.closesAt
      const lines = [
        `${ballot.quarter}: ${counted} ballot${counted === 1 ? "" : "s"} counted, ${open ? `still open until ${day(ballot.closesAt)}` : `closed ${day(ballot.closesAt)}`} (${input.mode} store).`,
        ...totals.map((item) => `  ${String(item.votes).padStart(5)}  ${item.id}  ${item.title}`),
      ]
      if (counted < ROADMAP_MINIMUM)
        lines.push(`Fewer than ${ROADMAP_MINIMUM} ballots: no results are published${open ? " yet" : ""}.`)
      else if (leaders.length > 1)
        lines.push(
          ballot.winner
            ? `Tied; you recorded ${ballot.winner} to go first.`
            : `Tied: ${leaders.map((item) => item.id).join(", ")}.${open ? "" : ` Run decide ${ballot.quarter} <id> to record which goes first.`}`,
        )
      else lines.push(`${open ? "Leading" : "Winner"}: ${leaders[0]!.id}. ${open ? "" : ROADMAP_PLANNED}`.trimEnd())
      return lines
    }
    case "decide": {
      const ballot = await decideBallot(input.quarter, input.winner, store)
      return [`${ballot.quarter}: ${ballot.winner} goes first. Settings shows "${ROADMAP_PLANNED}"`]
    }
    case "nominations": {
      const nominations = await ownerNominations(input.quarter, store)
      if (!nominations.length) return [`${input.quarter}: no nominations (${input.mode} store).`]
      return [
        `${input.quarter}: ${nominations.length} nomination${nominations.length === 1 ? "" : "s"} (${input.mode} store), for the next ballot:`,
        ...nominations.flatMap((item) => [
          `- ${item.title} (${item.plan}, ${day(item.at)})`,
          ...(item.detail ? [`  ${item.detail}`] : []),
        ]),
      ]
    }
  }
}

if (import.meta.main) {
  try {
    for (const line of await runRoadmapBallot(parseRoadmapArguments(process.argv.slice(2)))) console.log(line)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
