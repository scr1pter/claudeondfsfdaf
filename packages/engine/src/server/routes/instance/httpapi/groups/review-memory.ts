import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { SchemaErrorMiddleware } from "../middleware/schema-error"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"

export class ReviewMemoryApiError extends Schema.ErrorClass<ReviewMemoryApiError>("ReviewMemoryApiError")(
  {
    code: Schema.Literals([
      "invalid",
      "denied",
      "unavailable",
      "limit",
      "stale",
      "used",
      "expired",
      "disabled",
      "not-found",
      "source-unavailable",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

const root = "/experimental/review-memory"
const query = Schema.Struct(WorkspaceRoutingQueryFields).annotate({ parseOptions: { onExcessProperty: "error" } })
const page = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  offset: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: ReviewMemoryControl.LIMIT.records }),
    ),
  ),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: ReviewMemoryControl.LIMIT.page }),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

// This unregistered fragment shares the eventual instance API's identity. It
// can be exercised independently without registering routes or owner services.
export const ReviewMemoryControlApi = HttpApi.make("vector-instance")
  .add(
    HttpApiGroup.make("review-memory")
      .add(
        HttpApiEndpoint.get("inspect", root, {
          query: page,
          success: ReviewMemoryControl.Inspect,
          error: ReviewMemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "reviewMemory.inspect",
            summary: "Read this repository's review memory",
            description:
              "Owner-only bounded read in the engine's verified physical repository. Does not start a review.",
          }),
        ),
        HttpApiEndpoint.post("prepare", `${root}/prepare`, {
          query,
          payload: ReviewMemoryControl.Prepare,
          success: ReviewMemoryControl.Preview,
          error: ReviewMemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "reviewMemory.prepare",
            summary: "Preview an owner review-memory change",
            description: "Prepare one exact, short-lived approval. Preparing does not apply the change.",
          }),
        ),
        HttpApiEndpoint.post("confirm", `${root}/confirm`, {
          query,
          payload: ReviewMemoryControl.Confirmation,
          success: ReviewMemoryControl.ConfirmationResult,
          error: ReviewMemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "reviewMemory.confirm",
            summary: "Confirm one exact review-memory preview",
            description:
              "Single-use confirmation, bound to fresh owner and repository authority. Read back after a lost response.",
          }),
        ),
        HttpApiEndpoint.delete("discard", `${root}/previews/:previewId`, {
          params: { previewId: ReviewMemoryControl.PreviewID },
          query,
          success: Schema.Boolean,
          error: ReviewMemoryApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "reviewMemory.discard",
            summary: "Discard an owned review-memory preview",
            description: "Retire this owner's exact preview without applying a change or altering stored memory.",
          }),
        ),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .middleware(SchemaErrorMiddleware)
