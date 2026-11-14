export * as PublicSession from "./public-session.js"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "./schema.js"

export const MAX_BYTES = 4_000_000
export const MAX_RESPONSE_BYTES = MAX_BYTES + 1_024
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
export const CONSENT_VERSION = 1

export const ID = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)).annotate({ identifier: "PublicSession.ID" })
export type ID = typeof ID.Type
export const Secret = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
  identifier: "PublicSession.Secret",
})
const Text = Schema.String.check(Schema.isMaxLength(2_000_000))
const Label = Schema.String.check(Schema.isMaxLength(512))

function screenshot<M extends "image/png" | "image/jpeg" | "image/webp">(mediaType: M) {
  return Schema.Struct({
    name: Label,
    mediaType: Schema.Literal(mediaType),
    url: Schema.String.check(
      Schema.isMaxLength(MAX_BYTES),
      Schema.isPattern(new RegExp(`^data:${mediaType};base64,[A-Za-z0-9+/]+={0,2}$`)),
    ),
  })
}

// Literal variants preserve MIME/URI agreement in generated clients as well as at the server boundary.
export const Screenshot = Schema.Union([
  screenshot("image/png"),
  screenshot("image/jpeg"),
  screenshot("image/webp"),
]).annotate({ identifier: "PublicSession.Screenshot" })
export type Screenshot = typeof Screenshot.Type

const ToolFields = {
  type: Schema.Literal("tool"),
  name: Label,
  callID: Label,
  status: Schema.Literals(["completed", "error", "interrupted"]),
  input: Text,
  output: Text,
}

export const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Text }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Text }),
  Schema.Struct({
    ...ToolFields,
    screenshots: Schema.Array(Screenshot).check(Schema.isMaxLength(0)).pipe(optional),
  }),
  Schema.Struct({
    ...ToolFields,
    name: Schema.Literal("computer"),
    status: Schema.Literal("completed"),
    screenshots: Schema.Array(Screenshot).check(Schema.isMaxLength(100)).pipe(optional),
  }),
  // Attachments describe visible content; public imports never fetch a file or URL.
  Schema.Struct({ type: Schema.Literal("attachment"), name: Label, mediaType: Label }),
]).annotate({ identifier: "PublicSession.Part" })
export type Part = typeof Part.Type

export interface Message extends Schema.Schema.Type<typeof Message> {}
export const Message = Schema.Struct({
  id: Label,
  role: Schema.Literals(["user", "assistant", "tool", "shell", "notice"]),
  createdAt: NonNegativeInt,
  parts: Schema.Array(Part).check(Schema.isMaxLength(10_000)),
}).annotate({ identifier: "PublicSession.Message" })

// A portable visible transcript, never executable engine state or raw event records.
export interface Archive extends Schema.Schema.Type<typeof Archive> {}
export const Archive = Schema.Struct({
  version: Schema.Literal(1),
  engine: Schema.Literals(["v1", "v2"]),
  title: Label,
  messages: Schema.Array(Message).check(Schema.isMaxLength(20_000)),
}).annotate({ identifier: "PublicSession.Archive" })

export interface Consent extends Schema.Schema.Type<typeof Consent> {}
export const Consent = Schema.Struct({
  version: Schema.Literal(CONSENT_VERSION),
  public: Schema.Literal(true),
  updates: Schema.Boolean,
}).annotate({ identifier: "PublicSession.Consent" })

export interface Publish extends Schema.Schema.Type<typeof Publish> {}
export const Publish = Schema.Struct({
  consent: Consent,
  expiresAt: PositiveInt,
  // A reviewed UI snapshot must still match when the user confirms publication.
  previewHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(optional),
  // Local, account-bound consent for future sessions; never supplied by project config.
  remember: Schema.Boolean.pipe(optional),
  // A per-publication choice; never remembered for automatic shares or live updates.
  includeScreenshots: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "PublicSession.Publish" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  url: Schema.String.check(Schema.isPattern(/^https:\/\/vectordev\.ai\/s\/[a-f0-9]{32}$/)),
  expiresAt: PositiveInt,
  updatedAt: NonNegativeInt,
  revision: NonNegativeInt,
  updates: Schema.Boolean,
}).annotate({ identifier: "PublicSession.Info" })

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({ ...Info.fields, archive: Archive }).annotate({
  identifier: "PublicSession.Snapshot",
})

export interface Create extends Schema.Schema.Type<typeof Create> {}
export const Create = Schema.Struct({
  id: ID,
  secret: Secret,
  consent: Consent,
  expiresAt: PositiveInt,
  archive: Archive,
  includeScreenshots: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "PublicSession.Create" })

export interface Update extends Schema.Schema.Type<typeof Update> {}
export const Update = Schema.Struct({ secret: Secret, revision: NonNegativeInt, archive: Archive }).annotate({
  identifier: "PublicSession.Update",
})

export class Error extends Schema.TaggedErrorClass<Error>()(
  "PublicSessionError",
  {
    code: Schema.Literals([
      "SIGN_IN_REQUIRED",
      "CONSENT_REQUIRED",
      "UNAVAILABLE",
      "CONFLICT",
      "NOT_FOUND",
      "INVALID",
      "TOO_LARGE",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}
