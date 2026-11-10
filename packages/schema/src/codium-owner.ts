export * as CodiumOwner from "./codium-owner.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

// Private owner wire contract. No object from Stripe or the account store is returned wholesale.
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Time = Count
const Amount = Schema.NullOr(Schema.Finite)
const Plan = Schema.Literals(["vector-10", "vector-50", "vector-100", "vector-200"])
const Status = Schema.Literals(["healthy", "warning", "unknown", "unconfigured"])
export const Health = Schema.Struct({ status: Status, detail: Schema.String, checkedAt: optional(Time) }).annotate({
  identifier: "CodiumOwner.Health",
})
export interface Health extends Schema.Schema.Type<typeof Health> {}
export const Funding = Schema.Struct({
  status: Schema.Literals(["open", "paused"]),
  reason: optional(Schema.String),
  checkedAt: Time,
  balance: Amount,
  owed: Amount,
  reserved: Amount,
  required: Amount,
  runwayDays: Amount,
  spendPerDay: Amount,
  spendPerHour: Amount,
  lowWater: Schema.Boolean,
  spike: Schema.Boolean,
  watchdog: Schema.NullOr(Schema.Struct({ threshold: Schema.Finite, since: optional(Time), overdue: Schema.Boolean })),
}).annotate({ identifier: "CodiumOwner.Funding" })
export interface Funding extends Schema.Schema.Type<typeof Funding> {}
export const HistoryPoint = Schema.Struct({
  checkedAt: Time,
  balance: Schema.Finite,
  owed: Schema.Finite,
  reserved: Schema.Finite,
  required: Schema.Finite,
}).annotate({ identifier: "CodiumOwner.HistoryPoint" })
export interface HistoryPoint extends Schema.Schema.Type<typeof HistoryPoint> {}
export const RuntimeSwitch = Schema.Struct({
  name: Schema.Literals(["sales", "codium", "cloudAgents", "hosted", "ops", "remote", "vault", "push"]),
  value: Schema.Literals(["on", "off", "no-new", "stop"]),
  changedAt: Time,
  offSince: optional(Time),
}).annotate({ identifier: "CodiumOwner.RuntimeSwitch" })
export interface RuntimeSwitch extends Schema.Schema.Type<typeof RuntimeSwitch> {}
export const Account = Schema.Struct({
  account: Schema.String,
  state: Schema.String,
  plan: optional(Plan),
  periodEnd: optional(Time),
  blocked: Schema.Boolean,
  openDisputes: Count,
  efw: Count,
  refundCents: optional(Count),
  refundCharge: optional(Schema.NullOr(Schema.String)),
  refundSubscription: optional(Schema.NullOr(Schema.String)),
  refundPeriodStart: optional(Schema.NullOr(Time)),
}).annotate({ identifier: "CodiumOwner.Account" })
export interface Account extends Schema.Schema.Type<typeof Account> {}
export const Audit = Schema.Struct({
  at: Time,
  actor: Schema.String,
  action: Schema.String,
  account: optional(Schema.String),
  outcome: Schema.String,
}).annotate({ identifier: "CodiumOwner.Audit" })
export interface Audit extends Schema.Schema.Type<typeof Audit> {}
export const Dashboard = Schema.Struct({
  generatedAt: Time,
  sales: Schema.Struct({ enabled: Schema.Boolean, reason: Schema.String }),
  funding: Schema.NullOr(Funding),
  history: Schema.Array(HistoryPoint),
  subscriptions: Schema.Array(Schema.Struct({ plan: Plan, count: Schema.NullOr(Count), mrrCents: Amount })),
  risk: Schema.Struct({
    disputes30d: Schema.NullOr(Count),
    efw30d: Schema.NullOr(Count),
    paidInvoices30d: Schema.NullOr(Count),
    ratio: Amount,
  }),
  health: Schema.Struct({
    webhooks: Health,
    outbox: Schema.Struct({ depth: Schema.NullOr(Count), deadLetters: Schema.NullOr(Count) }),
    sweep: Health,
    store: Health,
  }),
  budgets: Schema.Array(
    Schema.Struct({
      service: Schema.String,
      status: Status,
      spentCents: optional(Schema.Finite),
      limitCents: optional(Schema.Finite),
      detail: Schema.String,
    }),
  ),
  switches: Schema.Array(RuntimeSwitch),
  modelsOff: Schema.Array(Schema.String),
  perksOff: Schema.Array(Schema.String),
  accounts: Schema.Array(Account),
  accountsComplete: Schema.Boolean,
  stripeChecklist: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      status: Schema.Literals(["confirmed", "owner-check", "unconfigured"]),
      detail: Schema.String,
    }),
  ),
  audit: Schema.Array(Audit),
}).annotate({ identifier: "CodiumOwner.Dashboard" })
export interface Dashboard extends Schema.Schema.Type<typeof Dashboard> {}
