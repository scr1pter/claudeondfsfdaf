import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@/session/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"

export class ReviewApiError extends Schema.ErrorClass<ReviewApiError>("ReviewApiError")(
  {
    code: Schema.Literals([
      "disabled",
      "placement",
      "invalid",
      "not_found",
      "conflict",
      "unavailable",
      "corrupt",
      "permissions",
      "stale",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

const query = Schema.Struct(WorkspaceRoutingQueryFields).annotate({ parseOptions: { onExcessProperty: "error" } })
const listQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  cursor: Schema.optional(SessionID),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 }))),
}).annotate({ parseOptions: { onExcessProperty: "error" } })
const root = "/experimental/session/:sessionID/review"

export const ReviewApi = HttpApi.make("vectorscope-review").add(
  HttpApiGroup.make("review")
    .add(
      HttpApiEndpoint.get("target", `${root}/target`, {
        params: { sessionID: SessionID },
        query,
        success: ReviewRun.Target,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.target",
          summary: "Read the local review target",
          description: "Read the existing conversation's exact Git head without starting model work. Owner only.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("start", root, {
        params: { sessionID: SessionID },
        query,
        payload: ReviewRun.Start,
        success: ReviewRun.Info,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.start",
          summary: "Start an owner local review",
          description:
            "Opt-in owner-only review of local changes. Placement and read authority come from the existing conversation. No GitHub connection is required; no checks, posting or automatic restart occur.",
        }),
      ),
      HttpApiEndpoint.get("list", root, {
        params: { sessionID: SessionID },
        query: listQuery,
        success: ReviewRun.List,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.list",
          summary: "Find local review runs",
          description: "Owner-only bounded status summaries for reconnection. No result JSON or code is included.",
        }),
      ),
      HttpApiEndpoint.get("get", `${root}/:runID`, {
        params: { sessionID: SessionID, runID: SessionID },
        query,
        success: ReviewRun.Info,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.get",
          summary: "Read an owned local review",
          description: "Read the exact retained result without starting or retrying model work.",
        }),
      ),
      HttpApiEndpoint.post("stop", `${root}/:runID/stop`, {
        params: { sessionID: SessionID, runID: SessionID },
        query,
        success: ReviewRun.Info,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.stop",
          summary: "Stop an owned local review",
          description: "Signal and join this engine's exact owned run, retaining completed partial output.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
