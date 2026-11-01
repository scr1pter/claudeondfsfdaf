export * as Session from "./session"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Location } from "./location"
import { Model } from "./model"
import { Project } from "./project"
import { DateTimeUtcFromMillis, optional, RelativePath } from "./schema"
import { SessionEvent } from "./session-event"
import { SessionID } from "./session-id"
import { Revert } from "./revert"
import { PublicSession } from "./public-session"

export const ID = SessionID
export type ID = SessionID

export const Event = SessionEvent

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parentID: ID.pipe(optional),
  // Names the Vector helper that ran this session, such as a Vectorscope review or autocomplete. Helper sessions stay
  // out of session lists; their spend counts towards parentID, the session that launched them, when there is one.
  internal: Schema.String.pipe(optional),
  projectID: Project.ID,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  cost: Schema.Finite,
  // Requests with unknown pricing or incomplete usage; their cost is not a complete measure of session spend.
  unpricedSteps: Schema.Finite.pipe(optional),
  // How many of those unpriced steps ran on Vector Codium; own unpriced steps are unpricedSteps − codiumSteps.
  codiumSteps: Schema.Finite.pipe(optional),
  // What the subagent sessions below this one spent, which cost leaves out, and how many of their steps were unpriced.
  subagentCost: Schema.Finite.pipe(optional),
  subagentUnpricedSteps: Schema.Finite.pipe(optional),
  // How many of the subagent unpriced steps ran on Vector Codium.
  subagentCodiumSteps: Schema.Finite.pipe(optional),
  // The tokens those sessions used, which tokens leaves out.
  subagentTokens: Tokens.pipe(optional),
  tokens: Tokens,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    archived: DateTimeUtcFromMillis.pipe(optional),
  }),
  title: Schema.String,
  share: PublicSession.Info.pipe(optional),
  location: Location.Ref,
  subpath: RelativePath.pipe(optional),
  revert: Revert.State.pipe(optional),
}).annotate({ identifier: "SessionV2.Info" })

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}
