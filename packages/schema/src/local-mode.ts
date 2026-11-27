export * as LocalMode from "./local-mode"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

// Vector Local: one switch that keeps Vector's AI features on model servers the user or their company hosts. These are
// the shapes every layer shares: the engine's decision function, the desktop's Chromium filter, the network log and
// the HTTP API. The decision rules themselves live in core (`local-mode/policy.ts`) and are pure.

// What the agent's web tools may reach while Vector Local is on. Ask: sites the user approves. Network: the user's
// own network and sites a company lists. None: no internet requests from Vector's web tools.
export const Web = Schema.Literals(["ask", "network", "none"]).annotate({ identifier: "LocalWeb" })
export type Web = typeof Web.Type

// Why Vector is making a request. Every call site labels its requests with one of these; `unknown` is a request no
// call site labelled, which the backstop guard sees.
export const Purpose = Schema.Literals([
  "inference",
  "catalog",
  "policy",
  "account",
  "usage",
  "crash",
  "telemetry",
  "support",
  "release-notes",
  "asset",
  "updates",
  "help",
  "share",
  "model-download",
  "tool-download",
  "plugin",
  "git-remote",
  "lsp-install",
  "web-page",
  // No source makes these now; kept so the network log still reads lines an earlier version wrote.
  "web-search",
  "browser",
  "research-reader",
  "research-browser",
  "integration",
  "mcp",
  "config-remote",
  "unknown",
]).annotate({ identifier: "EgressPurpose" })
export type Purpose = typeof Purpose.Type

// Where a request goes. Classes label the log and drive the web rules; none of them allows a model call on its own.
// `listed` is an origin on the model server list, whatever its address.
export const DestinationClass = Schema.Literals(["this-computer", "your-network", "listed", "internet"]).annotate({
  identifier: "EgressClass",
})
export type DestinationClass = typeof DestinationClass.Type

export const Decision = Schema.Literals(["allow", "ask", "block"]).annotate({ identifier: "EgressDecision" })
export type Decision = typeof Decision.Type

// The rule that produced a decision, for the network log and the "Why" link.
export const Rule = Schema.Literals([
  "local-off",
  "pending",
  "listed",
  "not-listed",
  "not-allowable",
  "loopback",
  "web-none",
  "web-network",
  "web-ask",
  "web-deny",
  "web-allow",
  "vector-service",
  "allowed-source",
  "automatic-update",
  "manual-check",
  "mirror",
  "download-grant",
  "private-remote",
  "unlabelled",
  // A name that counts as this computer or the user's network by its name alone answered with an internet address.
  "resolved-outside",
  // A research browser asked for a private, loopback or cloud metadata address, which its proxy never reaches.
  "private-destination",
  // A research browser asked for a port that is not a web port.
  "web-port",
  // A request for this computer or the user's network that the proxy environment would still send through a proxy.
  "proxy-environment",
  // A desktop window's own rule stopped a request Vector Local let through, before it left: a research browser's
  // navigation rule, or the billing window handing its return to the app.
  "window-rule",
]).annotate({ identifier: "EgressRule" })
export type Rule = typeof Rule.Type

// How a source behaves with Vector Local on. `not-covered` names connections Vector does not make itself, such as the
// programs the agent runs, which the copy has to say plainly.
export const SourceLocal = Schema.Literals([
  "blocked",
  "ask-once",
  "allowed",
  "allow-with-reason",
  "not-allowable",
  "not-covered",
]).annotate({ identifier: "EgressSourceLocal" })
export type SourceLocal = typeof SourceLocal.Type

export const Where = Schema.Literals(["engine", "desktop", "renderer"]).annotate({ identifier: "EgressWhere" })
export type Where = typeof Where.Type

// Who added an allow entry or an endpoint. Environment entries come from VECTOR_LOCAL_POLICY and only add.
export const Origin = Schema.Literals(["managed", "user", "environment"]).annotate({ identifier: "LocalOrigin" })
export type Origin = typeof Origin.Type

// A source the user allowed under Vector Local, with the reason they gave. `hosts` limits it to those hosts and the
// names under them. Without hosts it covers every host the source's labelled requests go to: the registry's hosts are
// the ones it usually reaches, not a limit (LocalPolicy.allowEntry).
export const Allowed = Schema.Struct({
  source: Schema.String,
  hosts: optional(Schema.Array(Schema.String)),
  reason: Schema.String,
  added_at: NonNegativeInt,
  added_by: Schema.Literals(["app", "cli", "managed"]),
}).annotate({ identifier: "LocalAllowed" })
export type Allowed = typeof Allowed.Type

export const Endpoint = Schema.Struct({
  origin: Schema.String,
  from: Origin,
}).annotate({ identifier: "LocalEndpoint" })
export type Endpoint = typeof Endpoint.Type

// The identity a model server had when it was added: what kind of server answered, its version, a hash of its model
// list and, for https, its public key. A server that answers as another one is held until the user confirms it.
export const Pin = Schema.Struct({
  kind: Schema.String,
  version: optional(Schema.String),
  models: optional(Schema.String),
  spki: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "LocalPin" })
export type Pin = typeof Pin.Type

// The policy in effect for this process, resolved once at start from managed and global sources only. `pending` is
// the fail-closed policy used until it is resolved: only this computer is reachable.
export const Policy = Schema.Struct({
  enabled: Schema.Boolean,
  web: Web,
  lock: Schema.Boolean,
  pending: optional(Schema.Boolean),
  endpoints: Schema.Array(Endpoint),
  web_domains: Schema.Struct({ allow: Schema.Array(Schema.String), deny: Schema.Array(Schema.String) }),
  allow: Schema.Array(Allowed),
  updates: optional(Schema.Struct({ url: Schema.String })),
  user_may: Schema.Array(Schema.String),
  locked_keys: Schema.Array(Schema.String),
  endpoint_domains: Schema.Array(Schema.String),
  // Each listed server's identity pin, by origin: the company's pin for a server wins over the user's.
  pins: optional(Schema.Record(Schema.String, Pin)),
  // What the resolver ignored and why, for the Vector Local pane.
  warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "LocalPolicy" })
export type Policy = typeof Policy.Type

// What a request carried out of the brain: personal memory cards, private document passages and repository excerpts.
export const Carried = Schema.Struct({
  personal: NonNegativeInt,
  documents: NonNegativeInt,
  repository: NonNegativeInt,
}).annotate({ identifier: "EgressCarried" })
export type Carried = typeof Carried.Type

// One line of the network log. It records where a request went and why, never its body, path, query or headers.
export const Event = Schema.Struct({
  id: Schema.String,
  time: NonNegativeInt,
  source: Schema.String,
  purpose: Purpose,
  class: DestinationClass,
  origin: Schema.String,
  method: Schema.String,
  bytes_out: optional(NonNegativeInt),
  bytes_in: optional(NonNegativeInt),
  decision: Decision,
  rule: Rule,
  reason: Schema.String,
  session_id: optional(Schema.String),
  root_session_id: optional(Schema.String),
  tool: optional(Schema.String),
  carried: Carried,
  // For a request no call site labelled: the first stack frame outside the network guard, so the code can be found.
  frame: optional(Schema.String),
  // For a request a browser Vector drives made: the page it opened, or something a page loaded (an image, a script,
  // a frame). The counters count a page as a page read and what pages loaded only as other hosts they reached.
  resource: optional(Schema.Literals(["page", "subresource"])),
}).annotate({ identifier: "EgressEvent" })
export type Event = typeof Event.Type

// The network log's counters for one root session, or for the whole process. A helper session (a Vectorscope reviewer,
// `brain.learn`) rolls up into the session that launched it, and `helper_requests` says how many of these it made.
export const Summary = Schema.Struct({
  requests: NonNegativeInt,
  helper_requests: NonNegativeInt,
  // Model calls by origin.
  model_calls: Schema.Record(Schema.String, NonNegativeInt),
  // Web pages read (what a page loaded is not a page), and the other hosts reached for web purposes: the hosts what
  // the pages loaded came from, the pages' own hosts left out ("6 pages, 41 other hosts they loaded").
  pages: NonNegativeInt,
  hosts: NonNegativeInt,
  searches: NonNegativeInt,
  carried: Carried,
  // Blocked requests by source.
  blocked: Schema.Record(Schema.String, NonNegativeInt),
}).annotate({ identifier: "EgressSummary" })
export type Summary = typeof Summary.Type
