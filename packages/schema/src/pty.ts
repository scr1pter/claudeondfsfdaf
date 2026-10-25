export * as Pty from "./pty"

import { Schema } from "effect"
import { optional } from "./schema"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { NonNegativeInt, PositiveInt, statics } from "./schema"

const IDSchema = Schema.String.check(Schema.isStartsWith("pty")).pipe(Schema.brand("PtyID"))

export const ID = IDSchema.pipe(
  statics((schema: typeof IDSchema) => {
    const create = () => schema.make("pty_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

/** Who opened a terminal, when it was not the user: an agent, in the session named here. */
export const Owner = Schema.Struct({
  kind: Schema.Literal("agent"),
  sessionID: Schema.String,
}).annotate({ identifier: "PtyOwner" })
export interface Owner extends Schema.Schema.Type<typeof Owner> {}

export const Info = Schema.Struct({
  id: ID,
  title: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  status: Schema.Literals(["running", "exited"]),
  pid: NonNegativeInt,
  exitCode: optional(NonNegativeInt),
  // Absent for the user's own terminals.
  owner: optional(Owner),
}).annotate({ identifier: "Pty" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Created = define({ type: "pty.created", schema: { info: Info } })
const Updated = define({ type: "pty.updated", schema: { info: Info } })
const Exited = define({ type: "pty.exited", schema: { id: ID, exitCode: NonNegativeInt } })
const Deleted = define({ type: "pty.deleted", schema: { id: ID } })
// Asks every client showing this location's terminals to bring one to the front; `focus` also moves keyboard focus.
const Revealed = define({ type: "pty.revealed", schema: { id: ID, focus: Schema.Boolean } })
export const Event = {
  Created,
  Updated,
  Exited,
  Deleted,
  Revealed,
  Definitions: inventory(Created, Updated, Exited, Deleted, Revealed),
}

export const CreateInput = Schema.Struct({
  command: optional(Schema.String),
  args: optional(Schema.Array(Schema.String)),
  cwd: optional(Schema.String),
  title: optional(Schema.String),
  env: optional(Schema.Record(Schema.String, Schema.String)),
})
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const UpdateInput = Schema.Struct({
  title: optional(Schema.String),
  size: optional(
    Schema.Struct({
      rows: PositiveInt,
      cols: PositiveInt,
    }),
  ),
})
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
