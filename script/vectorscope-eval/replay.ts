#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { VARIANT_NAME } from "../../packages/core/src/review/eval"
import type { ProjectedRun } from "../../packages/core/src/review/eval-report"
import type { ReviewConfig } from "../../packages/core/src/review/types"
import type {
  AttemptRecord,
  ModelRecord,
  ProjectedPass,
  ProjectedRequest,
  ProjectionRecord,
  ReplayCase,
  ReplayVariant,
  VariantRecord,
} from "../../packages/engine/src/review/eval"
import {
  defaultLimits,
  limitProblems,
  money,
  type Ledger,
  type Limits,
  type Refusal,
  type Settlement,
  type Ticket,
  type Usage,
} from "./budget"
import {
  caseView,
  gitEnv,
  manifestProblems,
  mirrorLocator,
  SEED_MANIFEST,
  SPLITS,
  type Case,
  type CaseView,
  type Manifest,
  type Split,
  untrustedGitEnv,
  UNTRUSTED_GIT,
} from "./dataset"

// The production replay's driver (VectorScope plan, VS-02). It turns dataset cases into the input of the engine's
// replay, ReviewEval.replay in packages/engine/src/review/eval.ts, from the label-free case view alone, and prepares
// each case's checkout from a local mirror: the candidate head and its history only, so neither the fix nor anything
// after the candidate is in the repository the reviewer reads, with the base checked out, as CI leaves an untrusted
// change. It sends no model request: a replay that spends money is admitted by the eval budget ledger (admitReplay
// below, VS-03) and runs only in the protected vectorscope-eval environment (D5, D7), within the D5 pilot's limits
// (pilotProblems). The engine entry point that runs replays and dry projections in-process is
// packages/engine/script/vectorscope-replay.ts (VS-21c), started by ci.ts; it is dry unless every send rule holds.

const REPO_ROOT = join(import.meta.dir, "..", "..")
const FULL_SHA = /^[0-9a-f]{40}$/

export const ADAPTERS = {
  engine: {
    ready: true,
    detail: "ReviewEval.replay: the engine review pipeline, with GitHub's writes recorded instead of sent.",
  },
  desktop: {
    ready: true,
    detail:
      "desktopReplay (desktop.ts): the desktop runner, runReview in packages/app/src/features/pull-requests/ai-review.ts, through a recording client, with what its Post button would send recorded instead of sent. A paid desktop replay needs an engine server and the eval ledger and is not wired.",
  },
} as const
export type Adapter = keyof typeof ADAPTERS

export interface PlannedReplay {
  id: string // kept by the driver to join results with labels; the engine uses it only to name the artifact
  split: Split
  mirror?: string
  case: Omit<ReplayCase, "directory">
}

// Each case of one split as the engine's replay input. Only the case view goes in: the repository and the candidate's
// two commits, reviewed untrusted on a writer's request, as a public change from outside would be. It fails closed on a
// split with a case the replay cannot feed yet (unreplayableCases): such a case is never replayed as a plain base..head
// review and scored as one, so until the engine half lands it blocks its split.
export function replayPlan(
  manifest: Manifest,
  options: { split: Split; locate?: (url: string) => string | undefined },
) {
  const refused = unreplayableCases(manifest, options.split)
  if (refused.length)
    throw new Error(
      `The ${options.split} split has cases the replay cannot run yet:\n${refused.map((line) => `  ${line}`).join("\n")}`,
    )
  return manifest.cases
    .filter((item) => item.split === options.split)
    .map((item) => planned(item, options.locate?.(item.repository.url)))
}

// Why the engine's replay cannot run a case yet, or undefined when it can (VS-22c). A multi-commit sequence needs
// ReviewEval.replay's sequence mode, and review feedback needs ReplayCase comments and threads; both are the deferred
// engine half of the VS-22a follow-up.
export function unreplayable(item: Pick<Case, "candidate" | "feedback">) {
  const reasons = [
    ...(item.candidate.commits
      ? ["it is a multi-commit sequence, and ReviewEval.replay has no sequence mode yet"]
      : []),
    ...(item.feedback ? ["it carries review feedback, which ReviewEval.replay does not feed in yet"] : []),
  ]
  return reasons.length ? reasons.join("; ") : undefined
}

// Every case of one split the replay cannot run yet, as "<id>: <reason>".
export function unreplayableCases(manifest: Pick<Manifest, "cases">, split: Split) {
  return manifest.cases.flatMap((item) => {
    const reason = item.split === split ? unreplayable(item) : undefined
    return reason ? [`${item.id}: ${reason}`] : []
  })
}

function planned(item: Case, mirror: string | undefined): PlannedReplay {
  const view = caseView(item)
  const [owner = "", repo = ""] = new URL(view.repository).pathname.split("/").filter(Boolean)
  return {
    id: item.id,
    split: item.split,
    ...(mirror ? { mirror } : {}),
    case: {
      label: item.id,
      base: view.base,
      head: view.head,
      trust: "untrusted",
      trigger: "command",
      repository: { owner, repo, url: view.repository },
    },
  }
}

// The pipeline variants a replay can be asked for (VS-21a), by suffix: "engine:shared-verify" is the "shared-verify"
// entry on the engine runner, and the runner's name alone ("engine", "desktop") is the frozen pipeline. Each entry says
// what it sets and, per runner, whether its half is built: `from` names the package whose keys made it change what that
// runner does, `pending` the package that will. A pending half is refused (resolveVariant), because a replay under its
// name would run the frozen pipeline. A half flips to built only in the package that makes its keys change what the
// runner does, with that package's D3 parity test: a ReviewConfig key or a core module landing alone never flips it.
// A half made by its models rather than a key (`models`) flips in the package that supplies them to its replays: the
// runner already runs the pair, and nothing about it changes, so there is no key and no parity test to carry.
// Names never hold a model id or "=" (VARIANT_NAME in core review/eval.ts). Every older name is one of these:
// "engine", "engine:shared-verify", "desktop", "desktop:shared-verify", and VS-06's { verifyPolicy } records, which
// replayVariant reads; so there are no aliases.
export type VariantHalf = { from: string } | { pending: string }
export interface VariantEntry {
  planned: string // what the variant sets, in words, so a pending name says what it will be
  keys?: Partial<ReviewConfig> // what it sets over the base's review.json, once a half is built
  models?: VariantRecord["models"] // what it needs of the replay's models instead of, or with, keys
  engine: VariantHalf
  desktop: VariantHalf
}

export const VARIANTS = {
  "shared-verify": {
    planned: 'verifyPolicy: "shared"',
    keys: { verifyPolicy: "shared" },
    engine: { from: "VS-06" },
    desktop: { from: "VS-06" },
  },
  "privacy-zdr": {
    planned: 'privacy: "zdr", enforced inside Review.run (VS-23b) and at the transport (VS-23c)',
    engine: { pending: "VS-23c" },
    desktop: { pending: "VS-23d" },
  },
  "trivial-skip": {
    planned: 'trivial: "skip"',
    engine: { pending: "VS-24 wiring" },
    desktop: { pending: "VS-24 wiring" },
  },
  "impact-graph": {
    planned: 'impact: "graph"',
    engine: { pending: "VS-25b wiring" },
    desktop: { pending: "VS-25's desktop half, after VS-10" },
  },
  "cards-brain": {
    planned: 'cards: "brain", in a local-only eval with a Brain seeded from the base commit',
    engine: { pending: "VS-26" },
    desktop: { pending: "VS-26's desktop half, after VS-10" },
  },
  "guardrail-strict": {
    planned: 'guardrail: "strict"',
    engine: { pending: "VS-27c" },
    desktop: { pending: "VS-27c" },
  },
  "depth-auto": {
    planned: 'depth: "auto"',
    engine: { pending: "VS-28 wiring" },
    desktop: { pending: "VS-28's desktop half, after VS-10" },
  },
  // Lenses run only on the high band under depth "auto", so this variant sets both, and its ablation baseline is
  // engine:depth-auto. VS-28 may revise it before it flips.
  "lenses-high": {
    planned: 'depth: "auto" and lenses: "high"',
    engine: { pending: "VS-28 wiring" },
    desktop: { pending: "VS-28's desktop half, after VS-10" },
  },
  // No key: the existing triageModel/model pair, which the eval config supplies (VS-29a: the entry point's
  // --triage-model, ci.ts's triage_model), never the name. Nothing here checks that the two models are from different
  // labs or of equal tier: the lab check is codium's (labOf, checkedLabs), never built here (contract §0.5, I-10), and
  // no stopgap was built until it merges; the tier is the owner's choice of pair (Q5). So the name does not prove the
  // labs differ: the artifact records both models, so a later lab check can re-check it offline. The desktop half waits
  // for VS-10: desktop.ts takes one model, records no triage model in `models`, and refuses a keyless variant.
  "cross-family": {
    planned: "a triage model other than the review model, at equal tier from another family; no new key",
    models: "triage-pair",
    engine: { from: "VS-29a" },
    desktop: { pending: "VS-29a's desktop half, after VS-10" },
  },
  precise: {
    planned: 'mode: "precise", which never sets privacy',
    engine: { pending: "VS-31" },
    desktop: { pending: "VS-31" },
  },
} as const satisfies Record<string, VariantEntry>

export type VariantResolution =
  | {
      ok: true
      name: string
      adapter: Adapter
      keys: Partial<ReviewConfig>
      models?: VariantRecord["models"]
      frozen: boolean // the runner's name alone: no variant
    }
  | { ok: false; reason: "malformed" | "unknown" | "pending"; detail: string; package?: string }

// A variant name as the eval takes it, in replay admission and report.ts --candidate and --baseline.
export function resolveVariant(name: string): VariantResolution {
  if (!VARIANT_NAME.test(name))
    return {
      ok: false,
      reason: "malformed",
      detail: `"${name}" is not a variant name: a runner, then optionally ":" and a registered suffix, such as engine:shared-verify.`,
    }
  const [adapter = "", suffix] = name.split(":")
  if (!Object.hasOwn(ADAPTERS, adapter))
    return { ok: false, reason: "unknown", detail: `${name} names no runner (${Object.keys(ADAPTERS).join(", ")}).` }
  const runner = adapter as Adapter
  if (suffix === undefined) return { ok: true, name, adapter: runner, keys: {}, frozen: true }
  if (!Object.hasOwn(VARIANTS, suffix))
    return {
      ok: false,
      reason: "unknown",
      detail: `${name} is not a registered variant (${variantNames(runner).join(", ")}).`,
    }
  const entry: VariantEntry = VARIANTS[suffix as keyof typeof VARIANTS]
  const half = entry[runner]
  if ("pending" in half)
    return {
      ok: false,
      reason: "pending",
      package: half.pending,
      detail: `${name} is registered for ${half.pending}, which has not landed (${entry.planned}); until it does, a replay under this name would run the frozen pipeline, so it is refused.`,
    }
  return {
    ok: true,
    name,
    adapter: runner,
    keys: { ...entry.keys },
    ...(entry.models ? { models: entry.models } : {}),
    frozen: false,
  }
}

// Every name the registry gives a runner, the frozen pipeline first, built or pending.
export function variantNames(adapter: Adapter) {
  return [adapter, ...Object.keys(VARIANTS).map((suffix) => `${adapter}:${suffix}`)]
}

// The name the report gives a replay's pipeline: its runner alone for the frozen pipeline, or the variant's registry
// name. A record written before VS-21a holds VS-06's verify policy, which names "engine:shared-verify" (for "shared")
// or the frozen pipeline (for "legacy"). An artifact is untrusted JSON: a record that is not an object, or a name that
// is not a string, names the frozen pipeline, as VS-06's reader took it, and variantProblems lists it.
export function replayVariant(adapter: string, record?: ReplayVariant) {
  if (typeof record !== "object" || record === null) return adapter
  if ("name" in record) return typeof record.name === "string" ? record.name : adapter
  return record.verifyPolicy && record.verifyPolicy !== "legacy" ? `${adapter}:${record.verifyPolicy}-verify` : adapter
}

// Why an artifact's variant record does not match the registry, if it does not: a record that is not an object, a name
// that is not a built variant of its own runner, or keys or models other than the registry's. A record written before
// VS-21a has none.
export function variantProblems(adapter: string, record?: ReplayVariant): string[] {
  if (record === undefined) return []
  if (typeof record !== "object" || record === null) return ["its variant record is not an object"]
  if (!("name" in record)) return []
  if (typeof record.name !== "string") return ["its variant record's name is not a string"]
  const resolved = resolveVariant(record.name)
  if (!resolved.ok) return [resolved.detail]
  if (resolved.adapter !== adapter) return [`its variant ${record.name} is another runner's, not ${adapter}'s`]
  if (resolved.frozen) return [`its variant record names the frozen pipeline, ${record.name}, which has none`]
  if (sortedJson(record.keys) !== sortedJson(resolved.keys) || record.models !== resolved.models)
    return [
      `its variant ${record.name} set ${sortedJson({ keys: record.keys, models: record.models })}, not the registry's ${sortedJson({ keys: resolved.keys, models: resolved.models })}`,
    ]
  return []
}

// Why a record read back whose variant is made by its models (`models: "triage-pair"`, VS-29a) does not show the pair,
// if it does not: a triage model other than its review model, which its evidence scope names too. A replay or
// projection is checked twice before it runs (triagePairProblem, then ReviewEval's own refusal); this is for the
// artifact or projection record report.ts and certify.ts read, which is untrusted JSON. It compares ids only, as
// triagePairProblem does, and so checks no lab. A record of any other variant has none.
export function pairProblems(record: unknown): string[] {
  if (field<VariantRecord>(field<ProjectionRecord>(record, "variant"), "models") !== "triage-pair") return []
  const models = field<ProjectionRecord>(record, "models")
  const review = field<ModelRecord>(field<ProjectionRecord["models"]>(models, "review"), "id")
  const triage = field<ModelRecord>(field<ProjectionRecord["models"]>(models, "triage"), "id")
  const scoped = field<ProjectionRecord["scope"]>(field<ProjectionRecord>(record, "scope"), "triage")
  if (typeof triage !== "string") return ["its variant is made by its models, but it records no triage model"]
  return [
    ...(triage === review
      ? [`its variant is made by its models, but its triage model is its review model, ${JSON.stringify(triage)}`]
      : []),
    ...(scoped !== triage
      ? [
          `its variant is made by its models, but its evidence scope names ${scoped === undefined ? "no triage model" : JSON.stringify(scoped)}, not its triage model ${JSON.stringify(triage)}`,
        ]
      : []),
  ]
}

// The runner a replayVariant name runs on.
export function variantAdapter(name: string) {
  return name.split(":")[0] ?? name
}

// A variant name as the engine entry point (VS-21c) takes it: a registry name built for the engine, with the record
// ReviewEval.replay and ReviewEval.project take as `variant`, which the frozen pipeline has none of. A malformed,
// unknown or pending name is refused with resolveVariant's detail, and a desktop one because only the engine runs here.
export function variantRecord(
  name: string,
): { ok: true; name: string; record?: Omit<VariantRecord, "applied"> } | { ok: false; detail: string } {
  const resolved = resolveVariant(name)
  if (!resolved.ok) return { ok: false, detail: resolved.detail }
  if (resolved.adapter !== "engine")
    return {
      ok: false,
      detail: `${resolved.name} runs on the desktop runner; replays and projections here run the engine.`,
    }
  const record = recordOf(resolved)
  return { ok: true, name: resolved.name, ...(record ? { record } : {}) }
}

function recordOf(resolved: Extract<VariantResolution, { ok: true }>): Omit<VariantRecord, "applied"> | undefined {
  if (resolved.frozen) return undefined
  return { name: resolved.name, keys: resolved.keys, ...(resolved.models ? { models: resolved.models } : {}) }
}

// Why a variant made by its models (`models: "triage-pair"`, VS-29a's engine:cross-family) cannot run on these models,
// the review model first: it needs exactly two, the second a triage model other than the first. The one rule for
// admitReplay, ci.ts and the entry point. It compares ids only: it does not check that the two are from different labs,
// which waits for codium's labOf (contract §0.5, I-10, and no stopgap is built here), nor that they are of equal tier,
// which is the owner's choice of pair (Q5). The lab check slots in here once labOf merges.
export function triagePairProblem(variant: string, models: readonly string[]): string | undefined {
  if (models.length === 2 && models[0] !== models[1]) return undefined
  return `${variant} is made by its models: it needs the review model, then a triage model other than it, not ${models.length ? models.join(" + ") : "no model"}.`
}

// The D5 pilot (vectorscope-plan.md D5): one pilot, capped at $50 in total and $0.75 a case, one repetition, on the
// development split only. A paid replay is refused outside these limits, each with its reason; a held-out or larger run
// waits for a budget the owner sets after reading the pilot report, and a code change that names it. How many cases
// and variants the pilot runs (Q9) is the owner's: these limits bound it, they do not choose it.
//
// A pilot that needs more than one dispatch shares the $50 across them: `spentUsd` is what its earlier dispatches
// settled, read by the owner from their sealed ledgers, since nothing carries spend from one dispatch to the next. A
// dispatch's budget is then at most what is left. Without it each dispatch is held to the whole $50.
export const PILOT = { totalUsd: 50, caseUsd: 0.75, repeat: 1, split: "development" } as const

// What is left of the pilot's $50 after its earlier dispatches settled `spentUsd`, never below $0.
export function pilotRemaining(spentUsd: number) {
  return Math.max(0, Math.round((PILOT.totalUsd - spentUsd) * 1e4) / 1e4)
}

export function pilotProblems(input: { limits: Limits; repeat: number; split: string; spentUsd?: number }): string[] {
  const spent = input.spentUsd ?? 0
  const remaining = pilotRemaining(spent)
  return [
    ...(input.limits.totalUsd > remaining
      ? [
          spent > 0
            ? `a paid replay's budget is at most what is left of the D5 pilot's $${PILOT.totalUsd} after the $${spent} its earlier dispatches settled, $${remaining}, not $${input.limits.totalUsd}`
            : `a paid replay's budget is at most the D5 pilot's $${PILOT.totalUsd}, not $${input.limits.totalUsd}`,
        ]
      : []),
    ...(input.limits.caseUsd > PILOT.caseUsd
      ? [`a paid replay's case bound is at most the D5 pilot's $${PILOT.caseUsd}, not $${input.limits.caseUsd}`]
      : []),
    ...(input.repeat !== PILOT.repeat
      ? [`a paid replay runs each case once, as the D5 pilot does, not ${input.repeat} times`]
      : []),
    ...(input.split !== PILOT.split
      ? [`a paid replay runs the ${PILOT.split} split only, as the D5 pilot does, not ${input.split}`]
      : []),
  ]
}

// A projection record (VS-21b) as the report reads it: what it would send and its estimated dollars, summed over its
// passes, joined with paid runs by variant, case and model. Read only a record projectionProblems passes.
export function projectedRun(record: ProjectionRecord): ProjectedRun {
  const requests = record.passes.flatMap((pass) => pass.requests)
  return {
    variant: replayVariant("engine", record.variant),
    model: record.models.review.id,
    models: [record.models.review.id, ...(record.models.triage ? [record.models.triage.id] : [])],
    case: record.label,
    repetition: record.repetition,
    usd: {
      low: record.passes.reduce((total, pass) => total + (pass.usd?.low ?? 0), 0),
      high: record.passes.reduce((total, pass) => total + (pass.usd?.high ?? 0), 0),
    },
    tokens: {
      first: record.passes.reduce((total, pass) => total + (pass.promptTokens ?? 0), 0),
      sent: requests.reduce((total, request) => total + request.tokens, 0),
    },
    passes: record.passes.length,
    requests: requests.length,
    over: record.cap.over.length,
    outside: record.egress.outside,
  }
}

// Why a projection record (VS-21b, ReviewEval.project) does not show what every pass of its case would send, if it
// does not. A record is untrusted JSON, read field by field under the record's own type names. It needs a body for
// every planned pass, each pass finished, every request paired with an admitted attempt and every attempt with a
// request, a price snapshot for every pass, an egress log that saw the run and no connection off this computer, and
// its variant record as the registry has it, with the pair a variant made by its models names (pairProblems). The
// decisions the dollar cap refused (`cap.over`) are reported, never a problem: from the first one on the record
// describes an uncapped run, the upper side of the cost estimate.
export function projectionProblems(record: unknown): string[] {
  if (typeof record !== "object" || record === null) return ["the projection is not an object"]
  if (field<ProjectionRecord>(record, "version") !== 1 || field<ProjectionRecord>(record, "kind") !== "projection")
    return ["it is not a version 1 projection record"]
  const passes = field<ProjectionRecord>(record, "passes")
  if (!Array.isArray(passes)) return ["its passes are not a list"]
  const reviewed = field<ProjectionRecord["files"]>(field<ProjectionRecord>(record, "files"), "reviewed")
  const egress = field<ProjectionRecord>(record, "egress")
  const attempts = field<ProjectionRecord["egress"]>(egress, "attempts")
  const outside = field<ProjectionRecord["egress"]>(egress, "outside")
  const unattributed = field<ProjectionRecord>(record, "unattributed")
  const sent = passes.flatMap((pass) => {
    const requests = field<ProjectedPass>(pass, "requests")
    return Array.isArray(requests) ? requests : []
  }).length
  return [
    ...(!Array.isArray(reviewed) ? ["its files are not a record"] : []),
    ...(passes.length === 0 && Array.isArray(reviewed) && reviewed.length > 0
      ? [`it planned no pass for ${reviewed.length} reviewed files`]
      : []),
    ...passes.flatMap(passProblems),
    ...(typeof unattributed !== "number" ? ["it has no unattributed count"] : []),
    ...(typeof unattributed === "number" && unattributed > 0
      ? [`${unattributed} requests name no session any attempt names`]
      : []),
    ...(typeof attempts !== "number" || typeof outside !== "number" ? ["it has no egress record"] : []),
    // The strict guard logs a connection for every request, so a log that saw none of the passes' requests is not its
    // log (Vector Local's guard logs nothing while it is off), and its zero outside measured nothing.
    ...(attempts === 0 && sent > 0
      ? [`its egress log saw none of its ${sent} requests, so no strict guard recorded the run`]
      : []),
    ...(typeof outside === "number" && outside > 0 ? [`${outside} connections went outside this computer`] : []),
    // variantProblems reads an untrusted record itself, one that is not an object included.
    ...variantProblems("engine", field<ProjectionRecord>(record, "variant") as ReplayVariant | undefined),
    ...pairProblems(record),
  ]
}

function passProblems(pass: unknown): string[] {
  const name = String(field<ProjectedPass>(pass, "pass"))
  const requests = field<ProjectedPass>(pass, "requests")
  if (!Array.isArray(requests) || requests.length === 0)
    return [`${name} sent no request, so its body was not projected`]
  const status = field<ProjectedPass>(pass, "status")
  const unsent = field<ProjectedPass>(pass, "unsent")
  const unadmitted = field<ProjectedPass>(pass, "unadmitted")
  return [
    ...(status !== "ok" ? [`${name} did not finish (${String(status)})`] : []),
    ...requests.flatMap((request, index) => {
      const body = field<ProjectedRequest>(request, "body")
      if (typeof body !== "string" || body === "") return [`${name}'s request ${index + 1} has no body`]
      return field<ProjectedRequest>(request, "chars") === body.length
        ? []
        : [`${name}'s request ${index + 1} does not count its body's characters`]
    }),
    ...(field<ProjectedPass>(pass, "usd") === undefined ? [`${name} has no dollar estimate (no price snapshot)`] : []),
    ...(typeof unsent !== "number" || unsent > 0
      ? [`${name} has ${String(unsent)} admitted attempts no request carried`]
      : []),
    ...(typeof unadmitted !== "number" || unadmitted > 0
      ? [`${name} sent ${String(unadmitted)} requests no admitted attempt accounts for`]
      : []),
  ]
}

// One field of an untrusted value, named as the type `T` names it, so a renamed field fails the typecheck here.
function field<T>(value: unknown, key: keyof T & string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return Object.entries(value).find(([name]) => name === key)?.[1]
}

function sortedJson(value: object) {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  )
}

// A replay's case in the eval ledger: its pipeline variant, its models, the case and the repetition. admitReplay admits
// under it, the report looks a replay's admission up by it, and judge calls on the replay are charged to it, so each
// variant of a case has its own admission and its own per-case bound.
export function replayCaseKey(input: { variant: string; models: readonly string[]; id: string; repetition?: number }) {
  return `${input.variant} ${input.models.join(" + ")} ${input.id}#${input.repetition ?? 1}`
}

// A replay's admission. Review.run admits each of its provider attempts itself, retries and the finalizer included,
// against the review's maxCostUsd, as long as its models are priced. So the eval ledger reserves the case's whole bound
// before a replay starts and hands Review.run that bound as its cap: every attempt is admitted against money the
// ledger has set aside. A model without a price cannot be bounded, so it is refused and the ledger stops admitting.
// The variant is a registry name (resolveVariant): one that is not built for the engine is refused before the ledger
// sees it, so it writes no entry. So is a variant made by its models (engine:cross-family, VS-29a) whose models are not
// the review model then a distinct triage model (triagePairProblem), with ReviewEval.replay's own refusal behind it as
// a backstop; every other variant takes the models as before. The admission hands ReviewEval.replay the variant's
// record, so the artifact names the variant the replay was admitted for.
export function admitReplay(
  ledger: Ledger,
  input: {
    id: string
    repetition?: number
    // The review model first, then the triage model when there is one.
    models: readonly Pick<ModelRecord, "id" | "costKind" | "price">[]
    variant?: string // a registry name, such as "engine:shared-verify"; absent or "engine" for the frozen pipeline
  },
):
  | {
      admitted: true
      // The case's cap: ReviewEval.replay's config.
      config: { maxCostUsd: number }
      // The variant's record: ReviewEval.replay's variant. Absent for the frozen pipeline.
      variant?: Omit<VariantRecord, "applied">
      ticket: Ticket
      // Settles the case from its artifact's attempts; with no artifact (the replay failed), the whole bound is kept.
      settle(artifact?: { attempts: readonly ReplayAttempt[] }): Settlement
    }
  | { admitted: false; reason: Refusal | "variant"; detail: string } {
  const resolved = resolveVariant(input.variant ?? "engine")
  if (!resolved.ok) return { admitted: false, reason: "variant", detail: resolved.detail }
  if (resolved.adapter !== "engine")
    return { admitted: false, reason: "variant", detail: `admitReplay admits engine replays, not ${resolved.name}.` }
  const models = input.models.map((item) => item.id)
  const unpaired = resolved.models === "triage-pair" ? triagePairProblem(resolved.name, models) : undefined
  if (unpaired) return { admitted: false, reason: "variant", detail: unpaired }
  const priced =
    input.models.length > 0 && input.models.every((model) => model.costKind === "priced" && model.price !== undefined)
  const admission = ledger.admit({
    case: replayCaseKey({
      variant: resolved.name,
      models,
      id: input.id,
      ...(input.repetition !== undefined ? { repetition: input.repetition } : {}),
    }),
    kind: "provider",
    model: models.join(" + "),
    note: "replay",
    estimateUsd: priced ? ledger.limits.caseUsd : Number.NaN,
  })
  if (!admission.admitted) return admission
  const ticket = admission.ticket
  const record = recordOf(resolved)
  return {
    admitted: true,
    config: { maxCostUsd: ledger.limits.caseUsd },
    ...(record ? { variant: record } : {}),
    ticket,
    settle: (artifact) => (artifact ? ticket.settle(replayCharge(artifact.attempts)) : ticket.settle()),
  }
}

type ReplayAttempt = Pick<AttemptRecord, "admitted" | "estimateUsd" | "settled">

// What a replay cost, from the attempts its artifact lists: each settled attempt at its reported cost, and the estimate
// of an admitted attempt that never settled, or settled without complete usage, as uncertain spend. A refused attempt
// was never sent.
export function replayCharge(attempts: readonly ReplayAttempt[]): Usage {
  let costUsd = 0
  let uncertainUsd = 0
  for (const attempt of attempts) {
    if (!attempt.admitted) continue
    if (!attempt.settled) {
      uncertainUsd += attempt.estimateUsd
      continue
    }
    costUsd += attempt.settled.costUsd
    if (!attempt.settled.complete) uncertainUsd += Math.max(0, attempt.estimateUsd - attempt.settled.costUsd)
  }
  return { costUsd, uncertainUsd, basis: "replay" }
}

// The most a split's replays could reserve: each case reserves its whole bound before it starts.
export function replayBudget(cases: number, limits: Limits) {
  const admissible = limits.totalUsd - limits.reserveUsd
  const fit = Math.min(cases, Math.floor((admissible + 1e-9) / limits.caseUsd))
  return {
    worstUsd: cases * limits.caseUsd,
    admissibleUsd: admissible,
    fit,
    text: `Budget $${money(limits.totalUsd, 2)} admits $${money(admissible)} after its $${money(limits.reserveUsd)} reserve. Each case reserves its $${money(limits.caseUsd)} bound before it starts, so ${fit} of ${cases} case(s) fit (at most $${money(cases * limits.caseUsd)} for all).`,
  }
}

// Where a case's checkout is prepared: a directory named by a digest of the case id, since the reviewer sees its
// working directory in its tool paths and the id must never reach it.
export function checkoutDirectory(root: string, id: string) {
  return join(root, `case-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`)
}

// A new repository at `directory` holding the candidate head and its history, fetched from a local mirror with git
// alone, and the base checked out. Nothing after the head is fetched, so the fix stays out. Git runs without the user's
// or the system's config, hooks or smudge filters, and with only the local file transport, so the dataset's content
// cannot run git-lfs or reach the network. Returns what went wrong; empty when the checkout is ready.
export function prepareCheckout(input: { mirror: string; view: CaseView; directory: string }): string[] {
  const shas = [input.view.base, input.view.head].filter((sha) => !FULL_SHA.test(sha))
  if (shas.length) return [`not full commit SHAs: ${shas.join(", ")}`]
  if (input.mirror.startsWith("-") || input.mirror.includes("://") || !isDirectory(input.mirror))
    return [`${input.mirror} is not a local mirror directory`]
  if (existsSync(input.directory)) return [`${input.directory} already exists`]
  const steps = [
    ["init", "--quiet", input.directory],
    ["-C", input.directory, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", input.mirror, input.view.head],
    ["-C", input.directory, "checkout", "--quiet", "--detach", input.view.base],
  ]
  for (const step of steps) {
    const result = Bun.spawnSync(["git", ...UNTRUSTED_GIT, ...step], {
      env: untrustedGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) return [`git ${step.join(" ")} failed: ${result.stderr.toString().trim()}`]
  }
  return []
}

const USAGE = `Usage: bun script/vectorscope-eval/replay.ts [options]

Plans a replay of dataset cases through the production review pipeline. Sends no model request.

  --manifest <path>   Dataset manifest (default: the seed manifest)
  --split <name>      ${SPLITS.join(", ")} (default: development)
  --mirrors <dir>     Local clones at <dir>/<owner>/<name>[.git]
  --adapter <name>    engine (default) or desktop
  --prepare <dir>     Also prepare each mirrored case's checkout under <dir>, with local git only
  --budget-usd <usd>  With --case-budget-usd, show how many cases the budget could admit
  --case-budget-usd <usd>
  --help              Print this message
`

const OPTIONS = {
  manifest: { type: "string" },
  split: { type: "string" },
  mirrors: { type: "string" },
  adapter: { type: "string" },
  prepare: { type: "string" },
  "budget-usd": { type: "string" },
  "case-budget-usd": { type: "string" },
  help: { type: "boolean" },
} as const

export async function main(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const parsed = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true })
  const values = parsed.values
  const text = (name: keyof typeof OPTIONS) => (typeof values[name] === "string" ? values[name] : undefined)
  const unknown = Object.keys(values).filter((name) => !Object.hasOwn(OPTIONS, name))
  const valueless = Object.entries(OPTIONS)
    .filter(
      ([name, option]) =>
        option.type === "string" && values[name] !== undefined && text(name as keyof typeof OPTIONS) === undefined,
    )
    .map(([name]) => name)
  if (unknown.length || valueless.length || parsed.positionals.length) return { code: 2, stdout: "", stderr: USAGE }
  if (values.help) return { code: 0, stdout: USAGE, stderr: "" }
  const split = text("split") ?? "development"
  const adapter = text("adapter") ?? "engine"
  if (!SPLITS.includes(split as Split)) return { code: 2, stdout: "", stderr: `Unknown split ${split}.\n\n${USAGE}` }
  if (!Object.hasOwn(ADAPTERS, adapter))
    return { code: 2, stdout: "", stderr: `Unknown adapter ${adapter}.\n\n${USAGE}` }
  const budgetText = text("budget-usd")
  const caseText = text("case-budget-usd")
  if ((budgetText === undefined) !== (caseText === undefined))
    return { code: 2, stdout: "", stderr: `--budget-usd and --case-budget-usd go together.\n\n${USAGE}` }
  const limits = budgetText && caseText ? defaultLimits(Number(budgetText), Number(caseText)) : undefined
  const limitIssues = limits ? limitProblems(limits) : []
  if (limitIssues.length) return { code: 2, stdout: "", stderr: `Budget: ${limitIssues.join("; ")}.\n` }
  if (!ADAPTERS[adapter as Adapter].ready)
    return {
      code: 2,
      stdout: "",
      stderr: `The ${adapter} adapter is not available: ${ADAPTERS[adapter as Adapter].detail}\n`,
    }

  const path = text("manifest") ? resolve(text("manifest")!) : SEED_MANIFEST
  const raw = await Bun.file(path).text()
  const value: unknown = JSON.parse(raw)
  const problems = manifestProblems(value)
  if (problems.length)
    return {
      code: 1,
      stdout: "",
      stderr: `Invalid manifest ${path}:\n${problems.map((line) => `  ${line}`).join("\n")}\n`,
    }
  const manifest = value as Manifest
  // Held-out labels are frozen before any prompt tuning, so held-out cases are replayed only from a frozen manifest.
  if (split === "held-out" && !manifest.freeze)
    return {
      code: 1,
      stdout: "",
      stderr: "Held-out cases replay only from a frozen manifest, and this one is not frozen.\n",
    }
  const refused = unreplayableCases(manifest, split as Split)
  if (refused.length)
    return {
      code: 1,
      stdout: "",
      stderr: `The ${split} split has cases the replay cannot run yet:\n${refused.map((line) => `  ${line}`).join("\n")}\n`,
    }
  const mirrors = text("mirrors")
  const plan = replayPlan(manifest, {
    split: split as Split,
    ...(mirrors ? { locate: mirrorLocator(resolve(mirrors)) } : {}),
  })
  const prepare = text("prepare")
  const prepared = plan.map((entry) =>
    prepare && entry.mirror
      ? {
          entry,
          problems: prepareCheckout({
            mirror: entry.mirror,
            view: { repository: entry.case.repository?.url ?? "", base: entry.case.base, head: entry.case.head },
            directory: checkoutDirectory(resolve(prepare), entry.id),
          }),
        }
      : { entry, problems: [] },
  )
  const failures = prepared.flatMap((item) => item.problems.map((problem) => `${item.entry.id}: ${problem}`))
  const vector = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { env: gitEnv(), stdout: "pipe" })
  const rows = prepared.map((item) => [
    item.entry.id,
    item.entry.case.repository?.url?.replace("https://github.com/", "") ?? "",
    item.entry.case.base.slice(0, 12),
    item.entry.case.head.slice(0, 12),
    !item.entry.mirror ? "no mirror" : !prepare ? "mirror" : item.problems.length ? "failed" : "prepared",
  ])
  const stdout = [
    `${plan.length} ${split} case(s) from ${path}`,
    formatTable([["CASE", "REPOSITORY", "BASE", "HEAD", "CHECKOUT"], ...rows]),
    "",
    `Manifest sha256 ${createHash("sha256").update(raw).digest("hex")}`,
    `Vector ${vector.exitCode === 0 ? vector.stdout.toString().trim() : "unknown"}`,
    `Adapter ${adapter}: ${ADAPTERS[adapter as Adapter].detail}`,
    "Each case replays untrusted on a writer's request, with its base checked out and its change in the prompt.",
    ...(limits ? [replayBudget(plan.length, limits).text] : []),
    "",
    "Dry run: no model request was sent. A replay that spends money is admitted by the eval budget ledger and runs only in the protected vectorscope-eval environment (D5, D7).",
  ].join("\n")
  if (failures.length)
    return {
      code: 1,
      stdout: stdout + "\n",
      stderr: `Checkout problems:\n${failures.map((line) => `  ${line}`).join("\n")}\n`,
    }
  return { code: 0, stdout: stdout + "\n", stderr: "" }
}

function isDirectory(path: string) {
  return existsSync(path) && statSync(path).isDirectory()
}

function formatTable(rows: string[][]) {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)))
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

if (import.meta.main) {
  const result = await main(process.argv.slice(2))
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code)
}
