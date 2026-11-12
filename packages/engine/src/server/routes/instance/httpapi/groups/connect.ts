import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Connect } from "@vectordevai/schema/connect"
import { SessionID } from "@/session/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"

export class ConnectApiError extends Schema.ErrorClass<ConnectApiError>("ConnectApiError")(
  {
    code: Schema.Literals(["disabled", "forbidden", "not_found", "invalid"]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export const ConnectQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: Schema.optional(SessionID) })
const root = "/experimental/connect"
const endpoint = (id: string, summary: string) => OpenApi.annotations({ identifier: `connect.${id}`, summary })

export const ConnectApi = HttpApi.make("connect").add(
  HttpApiGroup.make("connect")
    .add(
      HttpApiEndpoint.get("list", root, {
        query: ConnectQuery,
        success: Schema.Array(Connect.Member),
        error: ConnectApiError,
      }).annotateMerge(endpoint("list", "List connected tools")),
      HttpApiEndpoint.get("runs", `${root}/runs`, {
        query: ConnectQuery,
        success: Schema.Array(Connect.Run),
        error: ConnectApiError,
      }).annotateMerge(endpoint("runs", "List connected tool runs")),
      HttpApiEndpoint.get("get", `${root}/runs/:runID`, {
        params: { runID: Connect.RunID },
        query: ConnectQuery,
        success: Connect.Run,
        error: ConnectApiError,
      }).annotateMerge(endpoint("get", "Get a connected tool run")),
      HttpApiEndpoint.post("review", "/experimental/session/:sessionID/connect", {
        params: { sessionID: SessionID },
        query: WorkspaceRoutingQuery,
        payload: Connect.ReviewInput,
        success: Connect.Run,
        error: ConnectApiError,
      }).annotateMerge(endpoint("review", "Review changes in a conversation")),
      HttpApiEndpoint.post("directoryReview", `${root}/review`, {
        query: WorkspaceRoutingQuery,
        payload: Connect.ReviewInput,
        success: Connect.Run,
        error: ConnectApiError,
      }).annotateMerge(endpoint("directoryReview", "Review the selected directory")),
      HttpApiEndpoint.post("cancel", `${root}/runs/:runID/cancel`, {
        params: { runID: Connect.RunID },
        query: ConnectQuery,
        success: Schema.Boolean,
        error: ConnectApiError,
      }).annotateMerge(endpoint("cancel", "Cancel a connected tool run")),
      HttpApiEndpoint.post("register", `${root}/findings`, {
        query: WorkspaceRoutingQuery,
        payload: Connect.RegisterInput,
        success: Connect.Run,
        error: ConnectApiError,
      }).annotateMerge(endpoint("register", "Bring desktop findings into a conversation")),
      HttpApiEndpoint.post("dismiss", `${root}/runs/:runID/dismiss`, {
        params: { runID: Connect.RunID },
        query: WorkspaceRoutingQuery,
        payload: Connect.DismissInput,
        success: Connect.Run,
        error: ConnectApiError,
      }).annotateMerge(endpoint("dismiss", "Dismiss findings from an owner action")),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
