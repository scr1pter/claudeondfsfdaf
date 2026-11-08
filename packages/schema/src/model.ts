export * as Model from "./model"

import { Schema } from "effect"
import { optional } from "./schema"
import { Provider } from "./provider"
import { statics } from "./schema"
import { FreeDataPolicy } from "./free-model"

export const ID = Schema.String.pipe(Schema.brand("ModelV2.ID"))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand("VariantID"))
export type VariantID = typeof VariantID.Type

export const Ref = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  variant: VariantID.pipe(optional),
}).annotate({ identifier: "Model.Ref" })
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

export const Family = Schema.String.pipe(Schema.brand("Family"))
export type Family = typeof Family.Type

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  input: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
}).annotate({ identifier: "Model.Capabilities" })

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
}).annotate({ identifier: "Model.Cost" })

export const Api = Schema.Union([
  Schema.Struct({
    id: ID,
    ...Provider.AISDK.fields,
  }),
  Schema.Struct({
    id: ID,
    ...Provider.Native.fields,
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Model.Api" })
export type Api = typeof Api.Type

/**
 * What Vector Codium's model list says about one of its entries (§4.12): the lab, the Codium Auto role, and whether
 * the account's plan can use it. Codium Auto itself carries `auto`, the models it picks from. A `manualOnly` model is
 * chosen only by name, and a `locked` one needs the plan it names; neither is ever picked automatically.
 */
export interface Codium extends Schema.Schema.Type<typeof Codium> {}
export const Codium = Schema.Struct({
  lab: Schema.String.pipe(optional),
  role: Schema.Literals(["floor", "default", "ceiling"]).pipe(optional),
  manualOnly: Schema.Boolean.pipe(optional),
  locked: Schema.Struct({
    plan: Schema.String,
    name: Schema.String,
    previewUntil: Schema.Finite.pipe(optional),
  }).pipe(optional),
  preview: Schema.Struct({ until: Schema.Finite }).pipe(optional),
  auto: Schema.Struct({ floor: Schema.String, default: Schema.String, ceiling: Schema.String }).pipe(optional),
}).annotate({ identifier: "Model.Codium" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  family: Family.pipe(optional),
  name: Schema.String,
  freeModel: Schema.Struct({
    source: Schema.Literals(["shared", "openrouter"]),
    // A model that is not "no-training" carries the "May train on your prompts" label and needs one-time consent.
    dataPolicy: FreeDataPolicy.pipe(optional),
  }).pipe(optional),
  api: Api,
  capabilities: Capabilities,
  request: Schema.Struct({
    ...Provider.Request.fields,
    variant: Schema.String.pipe(optional),
  }),
  variants: Schema.Struct({
    id: VariantID,
    ...Provider.Request.fields,
  }).pipe(Schema.Array),
  time: Schema.Struct({
    released: Schema.Finite,
  }),
  cost: Schema.Array(Cost),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.Int.pipe(optional),
    output: Schema.Int,
  }),
  codium: Codium.pipe(optional),
})
  .annotate({ identifier: "ModelV2.Info" })
  .pipe(
    // Built as a plain value rather than through `make`: the catalog creates one for every model it lists, thousands
    // per reload, and validating these fixed fields cost several hundred milliseconds of startup. `make` returns this
    // same object.
    statics((schema) => ({
      empty: (providerID: Provider.ID, modelID: ID): typeof schema.Type => ({
        id: modelID,
        providerID,
        name: modelID,
        api: { id: modelID, type: "native", settings: {} },
        capabilities: { tools: false, input: [], output: [] },
        request: { headers: {}, body: {} },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 0, output: 0 },
      }),
    })),
  )
