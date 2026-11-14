// VS-47 pure contract. These are supplied observer facts, never evidence that an observer actually ran.
// A checksum is an edit detector against an independently retained digest, not a signature or quality certificate.
import { Option, Schema } from "effect"
import { REVIEW_LENSES, type ReviewOutcome, type ReviewReceipt } from "./types"
import { REVIEW_VERDICTS, reviewVerdict } from "./verdict"
import { instructionInventoryPath } from "./instruction-path"
import type { RouteRefusal } from "./privacy"

export const MAX_RECEIPT_BYTES = 256 * 1024
export const RECEIPT_LIMITS = Object.freeze({ routes: 128, context: 32, checked: 128, files: 256, redactions: 1024 })
const REFERENCES = Object.freeze(["skipped", "unreviewed", "specialists", "passes"] as const)
const ID = Schema.String.check(Schema.isLengthBetween(1, 160), Schema.isPattern(/^[A-Za-z0-9_.:-]+$/))
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const Path = Schema.String.check(Schema.makeFilter((value) => instructionInventoryPath(value) === value))
const Count = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }))
const Reasons = Schema.Literals([
  "not-recorded",
  "unsupported",
  "not-applicable",
  "observer-failed",
  "limit",
  "upstream-not-reported",
])
const Unavailable = Schema.Struct({ state: Schema.Literal("unavailable"), reason: Reasons })
const fact = <S extends Schema.Top>(value: S) =>
  Schema.Union([Schema.Struct({ state: Schema.Literal("observed"), value }), Unavailable])
const observation = <S extends Schema.Top, const Source extends string>(source: Source, value: S) =>
  Schema.Union([
    Schema.Struct({
      state: Schema.Literal("observed"),
      runID: ID,
      head: Commit,
      source: Schema.Literal(source),
      value,
    }),
    Unavailable,
  ])
const many = <S extends Schema.Top>(value: S, maximum: number) => Schema.Array(value).check(Schema.isMaxLength(maximum))
const Files = many(Path, RECEIPT_LIMITS.files)
const Refusals = [
  "free-model",
  "router-or-preset",
  "fallback-models",
  "plugins",
  "unattested-provider",
  "unattested-openrouter",
  "unattested-network-server",
  "retention-required-model",
  "codium-unaccepted",
  "batch",
  "unreadable-body",
  "unattributed-request",
  "unknown-destination",
  "server-tool",
  "provider-options",
  "extended-cache-unattested",
  "grounding-tool",
  "durable-cache",
  "anthropic-non-zdr-feature",
] as const satisfies readonly RouteRefusal[]
const Route = Schema.Struct({
  requestID: ID,
  requestKind: Schema.Literals(["openai-chat", "openai-responses", "anthropic-messages", "google-generate", "other"]),
  provider: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,100}$/)),
  operator: Schema.Literals([
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "loopback",
    "vector-codium",
    "vector-free",
    "upstream-not-reported",
  ]),
  decision: Schema.Union([
    Schema.Struct({
      allowed: Schema.Literal(true),
      kind: Schema.Literals(["standard", "loopback", "openrouter-attested", "attested-provider", "attested-host"]),
    }),
    Schema.Struct({ allowed: Schema.Literal(false), refusal: Schema.Literals(Refusals) }),
  ]),
  sent: Schema.Boolean,
  transport: Schema.Literals(["sync", "not-sent"]),
  cacheTtls: fact(many(Schema.Literals(["5m", "1h", "24h"]), 3)),
  store: fact(Schema.Boolean),
  zdr: fact(Schema.Boolean),
  account: Schema.Literals(["byok", "loopback", "vector-codium", "vector-free", "unreported"]),
  vendorStore: Schema.Literals(["none", "vector-codium", "vector-free", "upstream-not-reported"]),
  upstreamRetention: Schema.Literal("not-reported"),
})
const Context = Schema.Struct({
  source: Schema.Literals([
    "diff",
    "head",
    "base-instructions",
    "scoped-instructions",
    "impact",
    "history",
    "cards",
    "requirements",
  ]),
  state: Schema.Literals(["used", "fallback", "missing", "off", "incomplete"]),
  paths: Files,
})
const checkFields = { status: Schema.Literal("completed"), files: Files }
const Check = Schema.Union([
  Schema.Struct({
    ...checkFields,
    kind: Schema.Literal("pass"),
    name: Schema.Literals(["review", "security", "verify", "judge", "repro"]),
  }),
  Schema.Struct({ ...checkFields, kind: Schema.Literal("lens"), name: Schema.Literals(REVIEW_LENSES) }),
  Schema.Struct({
    ...checkFields,
    kind: Schema.Literal("strict-rule"),
    name: Schema.Literals(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]),
  }),
])
const Input = Schema.Struct({
  runID: ID,
  head: Commit,
  routes: observation("transport-observer", many(Route, RECEIPT_LIMITS.routes)),
  context: observation("context-collector", many(Context, RECEIPT_LIMITS.context)),
  checked: observation("run-observer", many(Check, RECEIPT_LIMITS.checked)),
  holdback: observation(
    "holdback-collector",
    Schema.Struct({
      redactions: many(Schema.Struct({ path: Path, diff: Count, head: Count }), RECEIPT_LIMITS.redactions),
      ignoredCommitted: Files,
    }),
  ),
  suppression: observation(
    "trusted-base-policy",
    Schema.Struct({
      baseProtection: Schema.Literals(["confirmed", "unavailable"]),
      root: Schema.Literals(["applied", "not-applied"]),
      nested: Schema.Literal("not-applied"),
    }),
  ),
})
const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  ...Input.fields,
  references: Schema.Tuple([
    Schema.Literal("skipped"),
    Schema.Literal("unreviewed"),
    Schema.Literal("specialists"),
    Schema.Literal("passes"),
  ]),
  verdict: Schema.Literals(REVIEW_VERDICTS),
})
const decodeInput = Schema.decodeUnknownOption(Input, { onExcessProperty: "error" })
const decodeReceipt = Schema.decodeUnknownOption(Receipt, { onExcessProperty: "error" })
const invalid = () => new Error("The supplied review receipt evidence is invalid or unavailable for this run.")
const unique = (values: readonly string[]) => new Set(values).size === values.length
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw invalid()
    return encoded
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
    .join(",")}}`
}
const bounded = (value: unknown) => {
  const result = canonical(value)
  if (new TextEncoder().encode(result).length > MAX_RECEIPT_BYTES) throw invalid()
  return result
}

function normalized(input: typeof Input.Type) {
  for (const evidence of [input.routes, input.context, input.checked, input.holdback, input.suppression])
    if (evidence.state === "observed" && (evidence.runID !== input.runID || evidence.head !== input.head))
      throw invalid()
  if (input.routes.state === "observed") {
    if (!unique(input.routes.value.map((route) => route.requestID))) throw invalid()
    for (const route of input.routes.value) {
      if (route.sent !== route.decision.allowed || route.transport !== (route.sent ? "sync" : "not-sent"))
        throw invalid()
      if (route.cacheTtls.state === "observed" && !unique(route.cacheTtls.value)) throw invalid()
      if (
        (route.vendorStore === "none" && route.account !== "byok" && route.account !== "loopback") ||
        (route.vendorStore === "vector-codium" && route.account !== "vector-codium") ||
        (route.vendorStore === "vector-free" && route.account !== "vector-free")
      )
        throw invalid()
    }
  }
  if (input.context.state === "observed") {
    if (!unique(input.context.value.map((item) => canonical({ ...item, paths: [...item.paths].sort() }))))
      throw invalid()
    for (const item of input.context.value) if (!unique(item.paths)) throw invalid()
  }
  if (input.checked.state === "observed") {
    if (!unique(input.checked.value.map((item) => `${item.kind}:${item.name}`))) throw invalid()
    for (const item of input.checked.value) if (!unique(item.files) || !item.files.length) throw invalid()
  }
  if (
    input.holdback.state === "observed" &&
    (!unique(input.holdback.value.redactions.map((item) => item.path)) ||
      !unique(input.holdback.value.ignoredCommitted))
  )
    throw invalid()
  if (
    input.suppression.state === "observed" &&
    input.suppression.value.root === "applied" &&
    input.suppression.value.baseProtection !== "confirmed"
  )
    throw invalid()
  return {
    ...input,
    routes:
      input.routes.state === "observed"
        ? {
            ...input.routes,
            value: input.routes.value
              .map((route) => ({
                ...route,
                cacheTtls:
                  route.cacheTtls.state === "observed"
                    ? { ...route.cacheTtls, value: [...route.cacheTtls.value].sort() }
                    : route.cacheTtls,
              }))
              .sort((a, b) => compare(a.requestID, b.requestID)),
          }
        : input.routes,
    context:
      input.context.state === "observed"
        ? {
            ...input.context,
            value: input.context.value
              .map((item) => ({ ...item, paths: [...item.paths].sort() }))
              .sort((a, b) => compare(canonical(a), canonical(b))),
          }
        : input.context,
    checked:
      input.checked.state === "observed"
        ? {
            ...input.checked,
            value: input.checked.value
              .map((item) => ({ ...item, files: [...item.files].sort() }))
              .sort((a, b) => compare(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`)),
          }
        : input.checked,
    holdback:
      input.holdback.state === "observed"
        ? {
            ...input.holdback,
            value: {
              redactions: [...input.holdback.value.redactions].sort((a, b) => compare(a.path, b.path)),
              ignoredCommitted: [...input.holdback.value.ignoredCommitted].sort(),
            },
          }
        : input.holdback,
  }
}

function matchesOutcome(receipt: ReviewReceipt, outcome: ReviewOutcome) {
  if (receipt.head !== outcome.head || receipt.verdict !== reviewVerdict({ kind: "outcome", outcome }).verdict)
    throw invalid()
  if (receipt.checked.state !== "observed") return
  for (const check of receipt.checked.value) {
    if (check.kind === "pass" && !outcome.specialists.some((pass) => pass.name === check.name && pass.status === "ok"))
      throw invalid()
    if (
      check.kind === "lens" &&
      !outcome.specialists.some((pass) => pass.name === "lens" && pass.lens === check.name && pass.status === "ok")
    )
      throw invalid()
    if (check.kind === "strict-rule" && (!outcome.strict || outcome.strict.head !== receipt.head)) throw invalid()
  }
}

/** Builds observations only; unavailable facts stay unavailable, including when the supplied outcome is clean. */
export function buildReviewReceipt(input: unknown, outcome: ReviewOutcome): ReviewReceipt {
  const decoded = decodeInput(input)
  if (Option.isNone(decoded)) throw invalid()
  const receipt = {
    version: 1 as const,
    ...normalized(decoded.value),
    references: Object.freeze([...REFERENCES] as const),
    verdict: reviewVerdict({ kind: "outcome", outcome }).verdict,
  }
  matchesOutcome(receipt, outcome)
  bounded(receipt)
  return receipt
}

/** Unset/off returns the same object and does not inspect evidence; no production caller is added here. */
export function withReviewReceipt<T extends ReviewOutcome>(
  outcome: T,
  mode?: "off" | "json",
  input?: unknown,
): T | (T & { receipt: ReviewReceipt }) {
  if (mode === undefined || mode === "off") return outcome
  if (mode !== "json") throw invalid()
  return { ...outcome, receipt: buildReviewReceipt(input, outcome) }
}

export function serializeReviewReceipt(input: unknown): string {
  const decoded = decodeReceipt(input)
  if (Option.isNone(decoded) || JSON.stringify(decoded.value.references) !== JSON.stringify(REFERENCES)) throw invalid()
  const { version, references, verdict, ...facts } = decoded.value
  return bounded({ version, ...normalized(facts), references, verdict })
}

async function digest(value: string) {
  const sum = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return `sha256:${Array.from(new Uint8Array(sum), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
export async function reviewReceiptEnvelope(receipt: ReviewReceipt) {
  const canonical = serializeReviewReceipt(receipt)
  return { version: 1 as const, canonical, sha256: await digest(canonical) }
}

/** Requires an independently retained checksum and actual expected outcome; even success grants no execution authority. */
export async function verifyReviewReceiptEnvelope(
  input: unknown,
  expected: { runID: string; head: string; sha256: string; outcome: ReviewOutcome },
): Promise<ReviewReceipt | undefined> {
  const runID = expected.runID
  const head = expected.head
  const sha256 = expected.sha256
  const Envelope = Schema.Struct({
    version: Schema.Literal(1),
    canonical: Schema.String.check(
      Schema.makeFilter((value) => value.isWellFormed() && new TextEncoder().encode(value).length <= MAX_RECEIPT_BYTES),
    ),
    sha256: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  })
  const envelope = Schema.decodeUnknownOption(Envelope, { onExcessProperty: "error" })(input)
  if (Option.isNone(envelope) || envelope.value.sha256 !== sha256) return
  const text = envelope.value.canonical
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (Option.isNone(json)) return
  const decoded = decodeReceipt(json.value)
  if (Option.isNone(decoded) || decoded.value.runID !== runID || decoded.value.head !== head) return
  // Validate caller-owned expectations before yielding; a later view/outcome mutation cannot retarget this check.
  const receipt = (() => {
    try {
      if (serializeReviewReceipt(decoded.value) !== text) return
      matchesOutcome(decoded.value, expected.outcome)
      return { ...decoded.value, references: Object.freeze([...REFERENCES] as const) }
    } catch {
      return
    }
  })()
  if (!receipt || (await digest(text)) !== sha256) return
  return receipt
}
