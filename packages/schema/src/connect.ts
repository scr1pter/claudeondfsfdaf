export * as Connect from "./connect"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { NonNegativeInt, optional, PositiveInt, statics } from "./schema"
import { SessionID } from "./session-id"

// Connected tools: the shapes the engine's hub, its adapters, the `connect` tool, the HTTP view and the surfaces share.
// A member is anything in the workspace that can be listed. A run is one hand-off from request to result. Every
// literal set here is closed: a value this file does not name is refused, so nothing a model or a newer client writes
// can widen an effect, a consent or a verdict. The rules live in core (`connect/*`) and the engine (`connect/*`).

/** The longest summary a result carries. Vector code writes it, never a model. */
export const MAX_SUMMARY = 2_000
/** The longest finding body. A model wrote it, so it is untrusted text. */
export const MAX_BODY = 4_000
/** The most findings one result carries. Connect cuts only here, and adds a note when it does. */
export const MAX_FINDINGS = 200
/** The most helper sessions one result names: the posting guard's bound on review lineage. */
export const MAX_SESSIONS = 200

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const Words = (max: number) => Schema.String.check(Schema.isLengthBetween(1, max))
const NoControl = /^[^\u0000-\u001f\u007f]+$/
const Epoch = NonNegativeInt

function distinct(values: ReadonlyArray<string>) {
  return new Set(values).size === values.length
}

// What an action may do. Through Phase C only `read` (maps to the requester's `read` rules) and `write` (maps to the
// requester's `edit`) exist. `run`, `network`, `post`, `screen` and `cloud` arrive with the work package that first
// needs one, and the hub refuses any effect it does not know.
export const Effect = Schema.Literals(["read", "write"]).annotate({ identifier: "Connect.Effect" })
export type Effect = typeof Effect.Type

// Where a member's code runs: this machine, the user's own accounts (their GitHub Actions, for example), or
// Vector's servers.
export const Place = Schema.Literals(["local", "your-cloud", "vector-cloud"]).annotate({ identifier: "Connect.Place" })
export type Place = typeof Place.Type

// Where a member sends your code: this computer, a model server on the user's list (`model-server:<host>`), a hosted
// provider the user configured (`provider:<id>`), or Vector Codium. For VectorScope it follows the review model, not
// the engine. Only the first two may be called "local".
export const SendsTo = Schema.Union([
  Schema.Literals(["this-computer", "vector-codium"]),
  Schema.TemplateLiteral(["model-server:", Schema.String]),
  Schema.TemplateLiteral(["provider:", Schema.String]),
])
  .annotate({ identifier: "Connect.SendsTo" })
  .check(Schema.isMaxLength(300), Schema.isPattern(/^(this-computer|vector-codium|(model-server|provider):\S+)$/))
export type SendsTo = typeof SendsTo.Type

/** True when code sent there stays on this computer or a model server the user listed. */
export function isLocal(sendsTo: SendsTo | undefined) {
  return sendsTo === "this-computer" || (sendsTo?.startsWith("model-server:") ?? false)
}

export const Kind = Schema.Literals([
  "agent",
  "helper",
  "tool",
  "runtime",
  "service",
  "mcp",
  "workflow",
  "skill",
]).annotate({ identifier: "Connect.Kind" })
export type Kind = typeof Kind.Type

// Whose code a member is. Owners other than `main` plug in through an adapter on their own branch.
export const Owner = Schema.Literals([
  "main",
  "vectorscope",
  "hands",
  "vector-at-mention",
  "codium",
  "cloud-workspaces",
  "plugin",
  "user",
]).annotate({ identifier: "Connect.Owner" })
export type Owner = typeof Owner.Type

// Whether a member can work right now. Every state but `ready` carries a reason in plain words (`off`: "Off in
// Vector Local", for example). A member that cannot prove it is ready shows as `unavailable`.
export const State = Schema.Literals(["ready", "busy", "unavailable", "off", "not-installed"]).annotate({
  identifier: "Connect.State",
})
export type State = typeof State.Type

// How to reach a member: through the hand-off protocol (`connect`), through the tool that already reaches it (its
// tool id: `research`, `browser`, `computer`, `vector_cloud`, `task`, `workflow`, or a listed tool's own id), by a
// person in the app (`ui`), or not at all (`none`). Tool ids are open, because MCP and plugin tools name themselves.
export const ToolReach = Schema.String.check(Schema.isLengthBetween(1, 128), Schema.isPattern(/^[A-Za-z0-9_.:-]+$/))
export const Reach = Schema.Union([Schema.Literals(["connect", "ui", "none"]), ToolReach]).annotate({
  identifier: "Connect.Reach",
})
export type Reach = typeof Reach.Type

// The hand-off actions a member can take. There are no generic actions yet: through Phase C only VectorScope takes
// hand-offs, and only these two.
export const ActionID = Schema.Literals(["review", "fix"]).annotate({ identifier: "Connect.ActionID" })
export type ActionID = typeof ActionID.Type

export const ResultKind = Schema.Literals(["review", "fix"]).annotate({ identifier: "Connect.ResultKind" })
export type ResultKind = typeof ResultKind.Type

// One action of a member reached through `connect`. The hub checks `effects` before anything starts, so an adapter
// cannot widen its own effects at run time.
export const Action = Schema.Struct({
  id: ActionID,
  title: Words(120),
  effects: Schema.Array(Effect).check(
    Schema.isMinLength(1),
    Schema.makeFilter((effects: ReadonlyArray<string>) => distinct(effects) || "Each effect is listed once."),
  ),
  background: Schema.Boolean,
  result: ResultKind,
}).annotate({ identifier: "Connect.Action" })
export interface Action extends Schema.Schema.Type<typeof Action> {}

export const Activity = Schema.Struct({
  running: NonNegativeInt,
  lastRunAt: optional(Epoch),
}).annotate({ identifier: "Connect.Activity" })
export interface Activity extends Schema.Schema.Type<typeof Activity> {}

// A stable member id: `vectorscope`, `research`, `browser`, `computer`, `tasks`, `workflow:<name>`, `mcp:<name>`,
// `github-agent`, `remote`, `cloud-workspace`, `external:<id>` and so on.
export const MemberID = Schema.String.check(Schema.isLengthBetween(1, 200), Schema.isPattern(NoControl))
export type MemberID = typeof MemberID.Type

// One workspace member: what it is, whether it can work right now, and how to reach it. The engine composes the list
// from its sources and never stores its own copy.
export const Member = Schema.Struct({
  id: MemberID,
  kind: Kind,
  title: Words(120),
  summary: Text(500),
  owner: Owner,
  place: Place,
  sendsTo: optional(SendsTo),
  state: State,
  reason: optional(Words(500)),
  reach: Reach,
  actions: optional(Schema.Array(Action).check(Schema.isMaxLength(20))),
  activity: optional(Activity),
})
  .annotate({ identifier: "Connect.Member" })
  .check(
    Schema.makeFilter((member: { state: State; reason?: string }) =>
      member.state === "ready" || member.reason !== undefined ? true : "A member that is not ready says why.",
    ),
    Schema.makeFilter((member: { reach: Reach; actions?: ReadonlyArray<Action> }) => {
      if (member.reach === "connect")
        return (member.actions?.length ?? 0) > 0 ? true : "A member reached through connect lists its actions."
      return member.actions === undefined ? true : "Only a member reached through connect lists actions."
    }),
    Schema.makeFilter(
      (member: { actions?: ReadonlyArray<Action> }) =>
        distinct((member.actions ?? []).map((action) => action.id)) || "Each action is listed once.",
    ),
  )
export interface Member extends Schema.Schema.Type<typeof Member> {}

// `cr_` plus a sortable id.
export const RunID = Schema.String.check(Schema.isStartsWith("cr_"), Schema.isLengthBetween(4, 64)).pipe(
  Schema.brand("Connect.RunID"),
  statics((schema) => ({ create: () => schema.make("cr_" + ascending()) })),
)
export type RunID = typeof RunID.Type

// Who asked. A member never appears here, so a member cannot start another member's hand-off. `sessionID` is absent
// only for a run a person starts on a directory with no session.
export const Requester = Schema.Struct({
  kind: Schema.Literals(["agent", "user", "workflow"]),
  sessionID: optional(SessionID),
  agent: optional(Words(100)),
})
  .annotate({ identifier: "Connect.Requester" })
  .check(
    Schema.makeFilter((requester: { kind: string; sessionID?: string }) =>
      requester.kind === "user" || requester.sessionID !== undefined
        ? true
        : "Only a person may ask without a session.",
    ),
  )
export interface Requester extends Schema.Schema.Type<typeof Requester> {}

// Limits a request may set. They can only lower the limits connect applies, never raise them; 0 is never "no cap".
export const Budget = Schema.Struct({
  maxCostUsd: optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  timeoutMinutes: optional(PositiveInt),
}).annotate({ identifier: "Connect.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

// A git ref or revision for a branch review's base. It can never start with "-", so it cannot read as an option.
export const Ref = Schema.String.check(
  Schema.isLengthBetween(1, 256),
  Schema.isPattern(/^(?!-)[^\s\u0000-\u001f\u007f]+$/),
)

// What a review covers: the working tree against HEAD (untracked files included), the index against HEAD, or the
// branch against its merge base. A task's isolated worktree joins in CW-14.
export const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("uncommitted") }),
  Schema.Struct({ kind: Schema.Literal("staged") }),
  Schema.Struct({ kind: Schema.Literal("branch"), base: optional(Ref) }),
])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "Connect.Target" })
export type Target = typeof Target.Type
export type TargetKind = Target["kind"]

export const FindingID = Schema.String.check(Schema.isLengthBetween(1, 200), Schema.isPattern(NoControl))
export type FindingID = typeof FindingID.Type

export const FixMode = Schema.Literals(["here", "worktree"]).annotate({ identifier: "Connect.FixMode" })
export type FixMode = typeof FixMode.Type

const RequestFields = {
  id: RunID,
  to: MemberID,
  requester: Requester,
  // The request this run belongs to: the id of the message the user wrote. Used for the per-request cap.
  requestID: Words(200),
  // The requester's instance directory, a task's isolated worktree, or a desktop workspace directory.
  directory: Words(4_096),
  background: Schema.Boolean,
  budget: optional(Budget),
}

export const ReviewRequest = Schema.Struct({
  ...RequestFields,
  action: Schema.Literal("review"),
  target: Target,
  // Always run (true) or never run (false) the security pass; absent leaves it to VectorScope.
  security: optional(Schema.Boolean),
  // An earlier run of the same target kind, to label findings fixed, still open or new.
  since: optional(RunID),
}).annotate({ identifier: "Connect.ReviewRequest" })
export interface ReviewRequest extends Schema.Schema.Type<typeof ReviewRequest> {}

/** Owner-facing review input. Identity, directory and request IDs come from the server boundary. */
export const ReviewInput = Schema.Struct({
  to: optional(MemberID),
  target: optional(Target),
  security: optional(Schema.Boolean),
  background: optional(Schema.Boolean),
  budget: optional(Budget),
  since: optional(RunID),
}).annotate({ identifier: "Connect.ReviewInput" })
export interface ReviewInput extends Schema.Schema.Type<typeof ReviewInput> {}

export const FixRequest = Schema.Struct({
  ...RequestFields,
  action: Schema.Literal("fix"),
  // The review run whose findings to fix, looked up in the requester's session.
  run: RunID,
  findings: Schema.Array(FindingID).check(
    Schema.isLengthBetween(1, MAX_FINDINGS),
    Schema.makeFilter((ids: ReadonlyArray<string>) => distinct(ids) || "Each finding is named once."),
  ),
  mode: FixMode,
}).annotate({ identifier: "Connect.FixRequest" })
export interface FixRequest extends Schema.Schema.Type<typeof FixRequest> {}

export const Request = Schema.Union([ReviewRequest, FixRequest])
  .pipe(Schema.toTaggedUnion("action"))
  .annotate({ identifier: "Connect.Request" })
export type Request = typeof Request.Type

export const Severity = Schema.Literals(["blocking", "concern", "nit"]).annotate({ identifier: "Connect.Severity" })
export type Severity = typeof Severity.Type

// VectorScope's categories, in its own order (core review/types.ts `CATEGORIES`).
export const Category = Schema.Literals([
  "bug",
  "security",
  "reliability",
  "performance",
  "tests",
  "maintainability",
  "style",
  "docs",
]).annotate({ identifier: "Connect.Category" })
export type Category = typeof Category.Type

export const Side = Schema.Literals(["RIGHT", "LEFT"]).annotate({ identifier: "Connect.Side" })
export type Side = typeof Side.Type

// The selection bucket a finding came from, in VectorScope's order: inline, overflow, outsideDiff, elsewhere, nits,
// stillOpen. Only `inline`, `overflow`, `elsewhere` and `nit` resolved in the reviewed diff.
export const Bucket = Schema.Literals([
  "inline",
  "overflow",
  "outside-diff",
  "elsewhere",
  "nit",
  "still-open",
]).annotate({ identifier: "Connect.Bucket" })
export type Bucket = typeof Bucket.Type

export const FindingStatus = Schema.Literals(["open", "fixing", "fixed", "still-open", "new", "dismissed"]).annotate({
  identifier: "Connect.FindingStatus",
})
export type FindingStatus = typeof FindingStatus.Type

// One VectorScope finding. A model that read code wrote its title, body and suggestion, so they are data, never an
// instruction. `body` is empty for a still-open finding from VectorScope's state, and `line` is absent when VectorScope
// no longer knows it. A suggestion longer than the body limit is left out, never cut.
export const Finding = Schema.Struct({
  id: FindingID,
  severity: Severity,
  category: Category,
  path: Words(4_096),
  line: optional(PositiveInt),
  side: Side,
  title: Words(300),
  body: Text(MAX_BODY),
  source: Schema.Literals(["review", "security"]),
  verified: optional(Schema.Boolean),
  suggestion: optional(Text(MAX_BODY)),
  bucket: Bucket,
  status: FindingStatus,
}).annotate({ identifier: "Connect.Finding" })
export interface Finding extends Schema.Schema.Type<typeof Finding> {}

/** A person registers desktop findings as data; no client-supplied clean verdict or helper lineage is trusted. */
export const RegisterInput = Schema.Struct({
  sessionID: SessionID,
  target: Target,
  findings: Schema.Array(Finding).check(Schema.isMaxLength(MAX_FINDINGS)),
}).annotate({ identifier: "Connect.RegisterInput" })
export interface RegisterInput extends Schema.Schema.Type<typeof RegisterInput> {}

export const DismissInput = Schema.Struct({
  sessionID: SessionID,
  findings: Schema.Array(FindingID).check(Schema.isLengthBetween(1, MAX_FINDINGS)),
  reason: optional(Text(400)),
}).annotate({ identifier: "Connect.DismissInput" })
export interface DismissInput extends Schema.Schema.Type<typeof DismissInput> {}
/** The contract calls it ConnectFinding. */
export const ConnectFinding = Finding
export type ConnectFinding = Finding

export const ResultState = Schema.Literals(["completed", "partial", "refused", "failed", "cancelled"]).annotate({
  identifier: "Connect.ResultState",
})
export type ResultState = typeof ResultState.Type

// For reviews. A review that is partial, skipped files for size, or whose settings the changes edit, is never
// `clean`.
export const Verdict = Schema.Literals(["clean", "findings", "blocking", "incomplete", "not-reviewed"]).annotate({
  identifier: "Connect.Verdict",
})
export type Verdict = typeof Verdict.Type

// How a run was billed. Vector Codium shows as `plan` with no dollars: plan usage, never tokens or prices.
export const CostKind = Schema.Literals(["free", "priced", "plan", "local", "unknown"]).annotate({
  identifier: "Connect.CostKind",
})
export type CostKind = typeof CostKind.Type

export const Cost = Schema.Struct({
  kind: CostKind,
  usd: optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "Connect.Cost" })
export interface Cost extends Schema.Schema.Type<typeof Cost> {}

// Why a run was refused before it did any work.
export const RefusalCode = Schema.Literals([
  "unknown", // no such member or action
  "effect", // an effect the hub does not accept
  "permission", // the requester's own rules deny the effect
  "denied", // the user answered no
  "read-rule", // a file in the directory matches a requester read deny or ask pattern
  "limit", // the per-request cap on review runs
  "budget", // the run stopped on its budget
  "unavailable", // the member is not ready, off in Vector Local, or cannot make tool calls
  "input", // the arguments are not valid (a max_cost of 0, for example)
  "not-allowed", // the caller may not hand off: a subagent, a guest, a member
  "escalate", // a Light request; call escalate first
]).annotate({ identifier: "Connect.RefusalCode" })
export type RefusalCode = typeof RefusalCode.Type

export class Refusal extends Schema.TaggedErrorClass<Refusal>()("Connect.Refusal", {
  code: RefusalCode,
  message: Words(MAX_SUMMARY),
}) {}

// What came back. `summary` and `notes` are written by Vector code. Each result also says where the code went and,
// with `target` and `head`, enough to compare a later review of the same target kind after a restart.
export const Result = Schema.Struct({
  state: ResultState,
  verdict: optional(Verdict),
  summary: Text(MAX_SUMMARY),
  findings: Schema.Array(Finding).check(Schema.isMaxLength(MAX_FINDINGS)),
  sendsTo: optional(SendsTo),
  cached: optional(Schema.Boolean),
  cost: optional(Cost),
  sessions: Schema.Array(SessionID).check(Schema.isMaxLength(MAX_SESSIONS)),
  notes: Schema.Array(Words(1_000)).check(Schema.isMaxLength(100)),
  refusal: optional(RefusalCode),
  target: optional(Target),
  head: optional(Words(200)),
  base: optional(Words(200)),
})
  .annotate({ identifier: "Connect.Result" })
  .check(
    Schema.makeFilter((result: { state: ResultState; verdict?: Verdict }) =>
      result.verdict !== "clean" || result.state === "completed" ? true : "Only a completed review can be clean.",
    ),
    Schema.makeFilter((result: { verdict?: Verdict; findings: ReadonlyArray<Finding> }) =>
      result.verdict !== "clean" ||
      result.findings.every(
        (finding) => finding.severity === "nit" || finding.status === "fixed" || finding.status === "dismissed",
      )
        ? true
        : "A clean review has no open blocking or concern finding.",
    ),
    Schema.makeFilter((result: { sendsTo?: SendsTo; cost?: Cost }) =>
      result.sendsTo !== "vector-codium" || result.cost?.usd === undefined
        ? true
        : "Vector Codium shows plan usage, never dollars.",
    ),
  )
export interface Result extends Schema.Schema.Type<typeof Result> {}

export const RunStatus = Schema.Literals(["queued", "running", "done"]).annotate({ identifier: "Connect.RunStatus" })
export type RunStatus = typeof RunStatus.Type

// Where a running hand-off is: the pass, a short message and when.
export const Progress = Schema.Struct({
  pass: optional(Words(64)),
  message: Words(500),
  at: Epoch,
}).annotate({ identifier: "Connect.Progress" })
export interface Progress extends Schema.Schema.Type<typeof Progress> {}

// A consent the hub asks in the requester's session. `connect` (pattern `vectorscope.review`) is allowed by default;
// `connect_model` (pattern `<provider>/<model>`) asks once per request and names the model, where the diff goes and
// the cap; `connect_write` asks every time, so it never offers "Always allow".
export const ConsentPermission = Schema.Literals(["connect", "connect_model", "connect_write"]).annotate({
  identifier: "Connect.ConsentPermission",
})
export type ConsentPermission = typeof ConsentPermission.Type

export const Consent = Schema.Struct({
  permission: ConsentPermission,
  patterns: Schema.Array(Words(500)).check(Schema.isLengthBetween(1, 50)),
  always: Schema.Array(Words(500)).check(Schema.isMaxLength(50)),
  message: Words(MAX_SUMMARY),
  model: optional(Words(300)),
  sendsTo: optional(SendsTo),
  maxCostUsd: optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  findings: optional(Schema.Array(FindingID).check(Schema.isMaxLength(MAX_FINDINGS))),
  diff: optional(Schema.String),
})
  .annotate({ identifier: "Connect.Consent" })
  .check(
    Schema.makeFilter((consent: { permission: ConsentPermission; always: ReadonlyArray<string> }) =>
      consent.permission !== "connect_write" || consent.always.length === 0
        ? true
        : "connect_write is asked every time and is never saved.",
    ),
    Schema.makeFilter((consent: { permission: ConsentPermission; model?: string; sendsTo?: SendsTo }) =>
      consent.permission !== "connect_model" || (consent.model !== undefined && consent.sendsTo !== undefined)
        ? true
        : "connect_model names the model and where the diff goes.",
    ),
  )
export interface Consent extends Schema.Schema.Type<typeof Consent> {}

// One hand-off from request to result: queued, then running (with progress), then done with its result.
export const Run = Schema.Struct({
  id: RunID,
  request: Request,
  status: RunStatus,
  progress: optional(Progress),
  result: optional(Result),
  time: Schema.Struct({
    created: Epoch,
    started: optional(Epoch),
    ended: optional(Epoch),
  }),
})
  .annotate({ identifier: "Connect.Run" })
  .check(
    Schema.makeFilter((run: { id: string; request: { id: string } }) =>
      run.id === run.request.id ? true : "A run carries its own request.",
    ),
    Schema.makeFilter((run: { status: RunStatus; result?: Result }) =>
      (run.status === "done") === (run.result !== undefined) ? true : "A run has a result exactly when it is done.",
    ),
  )
export interface Run extends Schema.Schema.Type<typeof Run> {}

// A run was queued, made progress or finished. Scoped to the requester's session; absent only for a directory run
// with no session. It joins the event manifest in CW-09.
export const RunUpdated = define({
  type: "connect.run.updated",
  schema: {
    sessionID: optional(SessionID),
    run: Run,
  },
})
export const Event = { RunUpdated, Definitions: inventory(RunUpdated) }
