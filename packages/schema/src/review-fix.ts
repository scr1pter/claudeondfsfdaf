export * as ReviewFixControl from "./review-fix"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

// VS-12d (SF-10a): the owner-only local fix API's wire shapes. No field here is consent or authority. The engine sets
// the fix's repository, checkout, branches, actor, commit identity and check bounds from the owner's conversation, and
// binds each approval to the authenticated owner, the reviewed head, the patch digest, the exact operation and an
// expiry. A request can only select an offered step and echo what it was shown.

// HTTP decode bounds only. The engine's core contract (review/fix-proposal.ts FIX_LIMITS) stays the authority and
// re-checks every value in bytes.
export const LIMIT = Object.freeze({
  patchBytes: 256 * 1024,
  files: 64,
  findings: 128,
  pathBytes: 1_024,
  commands: 16,
  arguments: 64,
  messageBytes: 8_192,
  outputBytes: 80 * 1024,
  notes: 8,
  fixes: 8,
})
const strict = { onExcessProperty: "error" } as const
const text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))
const Commit = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const Note = text(512)
const Notes = Schema.Array(Note).check(Schema.isMaxLength(LIMIT.notes))

export const FixID = Schema.String.check(Schema.isPattern(/^fix_[A-Za-z0-9-]{1,64}$/)).annotate({
  identifier: "ReviewFixControl.FixID",
})
export type FixID = typeof FixID.Type

export const OfferID = Schema.String.check(Schema.isUUID()).annotate({ identifier: "ReviewFixControl.OfferID" })
export type OfferID = typeof OfferID.Type

/**
 * Where a proposal comes from. Today only the owner's client: the engine did not make or verify the patch or its
 * finding references, and says so in the preview. A later source bound to a review the engine holds is a new kind.
 */
export const Source = Schema.Struct({ kind: Schema.Literal("client") }).annotate({
  identifier: "ReviewFixControl.Source",
  parseOptions: strict,
})
export interface Source extends Schema.Schema.Type<typeof Source> {}

export const File = Schema.Struct({
  path: text(LIMIT.pathBytes),
  preimage: Schema.NullOr(Digest),
  postimage: Schema.NullOr(Digest),
}).annotate({ identifier: "ReviewFixControl.File", parseOptions: strict })
export interface File extends Schema.Schema.Type<typeof File> {}

/** A fix for the conversation's checked-out branch at `head`. Nothing in it chooses where the fix is placed. */
export const Prepare = Schema.Struct({
  source: Source,
  head: Commit,
  base: Commit,
  baseBranch: text(256),
  findings: Schema.Array(text(256)).check(Schema.isMinLength(1), Schema.isMaxLength(LIMIT.findings)),
  files: Schema.Array(File).check(Schema.isMinLength(1), Schema.isMaxLength(LIMIT.files)),
  patch: text(LIMIT.patchBytes),
}).annotate({ identifier: "ReviewFixControl.Prepare", parseOptions: strict })
export interface Prepare extends Schema.Schema.Type<typeof Prepare> {}

export const Change = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["added", "modified", "deleted"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
}).annotate({ identifier: "ReviewFixControl.Change" })
export interface Change extends Schema.Schema.Type<typeof Change> {}

/** What the owner sees before any step: the placement, the branches, the digests, the exact patch and its files. */
export const Preview = Schema.Struct({
  fixID: FixID,
  repository: Schema.String,
  worktree: Schema.String,
  head: Commit,
  base: Commit,
  sourceBranch: Schema.String,
  baseBranch: Schema.String,
  destinationBranch: Schema.String,
  source: Source,
  // Always false today: see Source.
  findingsVerified: Schema.Literal(false),
  findings: Schema.Array(Schema.String).check(Schema.isMaxLength(LIMIT.findings)),
  digest: Digest,
  patchDigest: Digest,
  patch: Schema.String,
  files: Schema.Array(Change).check(Schema.isMaxLength(LIMIT.files)),
  notes: Notes,
}).annotate({ identifier: "ReviewFixControl.Preview" })
export interface Preview extends Schema.Schema.Type<typeof Preview> {}

export const Command = Schema.Struct({
  argv: Schema.Array(text(1_024)).check(Schema.isMinLength(1), Schema.isMaxLength(LIMIT.arguments)),
  cwd: text(LIMIT.pathBytes),
}).annotate({ identifier: "ReviewFixControl.Command", parseOptions: strict })
export interface Command extends Schema.Schema.Type<typeof Command> {}

const Mode = Schema.Literals(["branch", "draft-pr"])

export const ApplyRequest = Schema.Struct({ kind: Schema.Literal("apply") }).annotate({
  identifier: "ReviewFixControl.ApplyRequest",
  parseOptions: strict,
})
export const ChecksRequest = Schema.Struct({
  kind: Schema.Literal("checks"),
  commands: Schema.Array(Command).check(Schema.isMinLength(1), Schema.isMaxLength(LIMIT.commands)),
}).annotate({ identifier: "ReviewFixControl.ChecksRequest", parseOptions: strict })
export const CommitRequest = Schema.Struct({ kind: Schema.Literal("commit") }).annotate({
  identifier: "ReviewFixControl.CommitRequest",
  parseOptions: strict,
})
export const PushRequest = Schema.Struct({
  kind: Schema.Literal("push"),
  remote: text(2_048),
  mode: Mode,
}).annotate({ identifier: "ReviewFixControl.PushRequest", parseOptions: strict })
/** The step to offer. The engine builds its exact operation (check bounds, commit message, commit to push). */
export const Request = Schema.Union([ApplyRequest, ChecksRequest, CommitRequest, PushRequest]).annotate({
  identifier: "ReviewFixControl.Request",
})
export type Request = typeof Request.Type

export const ApplyOperation = Schema.Struct({ kind: Schema.Literal("apply") }).annotate({
  identifier: "ReviewFixControl.ApplyOperation",
})
export const ChecksOperation = Schema.Struct({
  kind: Schema.Literal("checks"),
  commands: Schema.Array(Command).check(Schema.isMaxLength(LIMIT.commands)),
  network: Schema.Literal("off"),
  timeoutMs: NonNegativeInt,
  outputBytes: NonNegativeInt,
}).annotate({ identifier: "ReviewFixControl.ChecksOperation" })
export const CommitOperation = Schema.Struct({
  kind: Schema.Literal("commit"),
  message: text(LIMIT.messageBytes),
}).annotate({ identifier: "ReviewFixControl.CommitOperation" })
export const PushOperation = Schema.Struct({
  kind: Schema.Literal("push"),
  remote: Schema.String,
  commit: Commit,
  mode: Mode,
}).annotate({ identifier: "ReviewFixControl.PushOperation" })
export const Operation = Schema.Union([ApplyOperation, ChecksOperation, CommitOperation, PushOperation]).annotate({
  identifier: "ReviewFixControl.Operation",
})
export type Operation = typeof Operation.Type

export const Identity = Schema.Struct({ name: Schema.String, email: Schema.String }).annotate({
  identifier: "ReviewFixControl.Identity",
})
export interface Identity extends Schema.Schema.Type<typeof Identity> {}

/**
 * One step's approval offer: the exact operation the owner approves, and for a commit the identity it is made with.
 * Executing it echoes `head`, `patchDigest` and `operationDigest`; it is single-use and expires at `expiresAt`.
 */
export const Offer = Schema.Struct({
  offerID: OfferID,
  fixID: FixID,
  operation: Operation,
  operationDigest: Digest,
  head: Commit,
  digest: Digest,
  patchDigest: Digest,
  expiresAt: NonNegativeInt,
  identity: optional(Identity),
  notes: Notes,
}).annotate({ identifier: "ReviewFixControl.Offer" })
export interface Offer extends Schema.Schema.Type<typeof Offer> {}

export const Execute = Schema.Struct({
  offerID: OfferID,
  head: Commit,
  patchDigest: Digest,
  operationDigest: Digest,
}).annotate({ identifier: "ReviewFixControl.Execute", parseOptions: strict })
export interface Execute extends Schema.Schema.Type<typeof Execute> {}

/** One check command's run. `output` is untrusted data from the project's own code, shown and never kept. */
export const CheckResult = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  output: Schema.String.check(Schema.isMaxLength(LIMIT.outputBytes)),
  truncated: Schema.Boolean,
  durationMs: Schema.Int,
}).annotate({ identifier: "ReviewFixControl.CheckResult" })
export interface CheckResult extends Schema.Schema.Type<typeof CheckResult> {}

export const Applied = Schema.Struct({
  kind: Schema.Literal("apply"),
  fixID: FixID,
  worktree: Schema.String,
  head: Commit,
  digest: Digest,
  patchDigest: Digest,
  consumedAt: NonNegativeInt,
  files: Schema.Array(Change),
}).annotate({ identifier: "ReviewFixControl.Applied" })
export const Checked = Schema.Struct({
  kind: Schema.Literal("checks"),
  fixID: FixID,
  head: Commit,
  digest: Digest,
  // sha256 of the checks operation as the consent bound it.
  operation: Digest,
  consumedAt: NonNegativeInt,
  results: Schema.Array(CheckResult).check(Schema.isMaxLength(LIMIT.commands)),
  aborted: optional(Schema.Literals(["head", "worktree"])),
  // Files a check left in the fix checkout; every later step refuses while one is there.
  leftovers: optional(Schema.Array(Schema.String).check(Schema.isMaxLength(32))),
  // Informational only: a result authorizes no change, commit or push.
  passed: Schema.Boolean,
}).annotate({ identifier: "ReviewFixControl.Checked" })
export const Committed = Schema.Struct({
  kind: Schema.Literal("commit"),
  fixID: FixID,
  head: Commit,
  digest: Digest,
  commit: Commit,
  tree: Commit,
  branch: Schema.String,
  author: Identity,
  consumedAt: NonNegativeInt,
}).annotate({ identifier: "ReviewFixControl.Committed" })
export const Pushed = Schema.Struct({
  kind: Schema.Literal("push"),
  fixID: FixID,
  commit: Commit,
  remote: Schema.String,
  ref: Schema.String,
  mode: Mode,
  consumedAt: NonNegativeInt,
}).annotate({ identifier: "ReviewFixControl.Pushed" })
export const Result = Schema.Union([Applied, Checked, Committed, Pushed]).annotate({
  identifier: "ReviewFixControl.Result",
})
export type Result = typeof Result.Type

export const Cleanup = Schema.Union([
  Schema.Struct({ fixID: FixID, removed: Schema.Literal(true) }),
  Schema.Struct({ fixID: FixID, removed: Schema.Literal(false), reason: Schema.String }),
]).annotate({ identifier: "ReviewFixControl.Cleanup" })
export type Cleanup = typeof Cleanup.Type

export const State = Schema.Literals([
  "proposal",
  "preview",
  "applied",
  "committed",
  "pushed",
  "cancelled",
  "failed",
]).annotate({ identifier: "ReviewFixControl.State" })
export type State = typeof State.Type

export const Summary = Schema.Struct({
  fixID: FixID,
  state: State,
  head: Commit,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  digest: Digest,
  patchDigest: Digest,
  commit: optional(Commit),
}).annotate({ identifier: "ReviewFixControl.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

export const List = Schema.Struct({
  fixes: Schema.Array(Summary).check(Schema.isMaxLength(LIMIT.fixes)),
}).annotate({ identifier: "ReviewFixControl.List" })
export interface List extends Schema.Schema.Type<typeof List> {}
