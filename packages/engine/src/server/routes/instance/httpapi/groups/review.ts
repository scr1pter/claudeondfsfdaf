import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ReviewFixControl } from "@vectordevai/schema/review-fix"
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
const fixRoot = `${root}/fix`

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
    .add(
      HttpApiEndpoint.get("fixList", fixRoot, {
        params: { sessionID: SessionID },
        query,
        success: ReviewFixControl.List,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.fix.list",
          summary: "List the conversation's open fixes",
          description:
            "Owner-only and experimental. The fixes this engine holds for the conversation, for reconnection.",
        }),
      ),
      HttpApiEndpoint.post("fixPrepare", fixRoot, {
        params: { sessionID: SessionID },
        query,
        payload: ReviewFixControl.Prepare,
        success: ReviewFixControl.Preview,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.fix.prepare",
          summary: "Prepare a local fix",
          description:
            "Owner-only and experimental. Places a fix checkout detached at the conversation branch's exact head and re-verifies every file of the client's patch. The engine does not verify the findings the fix names. Nothing is applied, committed or pushed and no command runs.",
        }),
      ),
      HttpApiEndpoint.post("fixPreview", `${fixRoot}/:fixID/preview`, {
        params: { sessionID: SessionID, fixID: ReviewFixControl.FixID },
        query,
        payload: ReviewFixControl.Request,
        success: ReviewFixControl.Offer,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.fix.preview",
          summary: "Offer one fix step",
          description:
            "Owner-only and experimental. Builds the exact apply, checks, commit or push operation and a single-use approval offer bound to the owner, the head, the patch digest and the operation, expiring after five minutes. Nothing runs.",
        }),
      ),
      HttpApiEndpoint.post("fixExecute", `${fixRoot}/:fixID/execute`, {
        params: { sessionID: SessionID, fixID: ReviewFixControl.FixID },
        query,
        payload: ReviewFixControl.Execute,
        success: ReviewFixControl.Result,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.fix.execute",
          summary: "Approve and run one offered fix step",
          description:
            "Owner-only and experimental. Approves exactly the offered step, spending its offer, and runs it once after the executor re-verifies the head and files.",
        }),
      ),
      HttpApiEndpoint.post("fixCancel", `${fixRoot}/:fixID/cancel`, {
        params: { sessionID: SessionID, fixID: ReviewFixControl.FixID },
        query,
        success: ReviewFixControl.Cleanup,
        error: ReviewApiError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "review.fix.cancel",
          summary: "Cancel a local fix",
          description:
            "Owner-only. Stops a running check or push and removes the fix checkout; a commit on its new branch is kept.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
