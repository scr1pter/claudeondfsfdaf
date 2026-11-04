import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ComputerPrune } from "@/computer/prune"
import { ComputerProtection } from "@/computer/protection"
import { InvalidRequestError, UnknownError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"

export const ComputerPaths = { prune: "/computer/screenshots/prune", protection: "/computer/protected-paths" } as const

export const ComputerApi = HttpApi.make("computer").add(
  HttpApiGroup.make("computer")
    .add(
      HttpApiEndpoint.get("protectedPaths", ComputerPaths.protection, {
        query: WorkspaceRoutingQuery,
        success: ComputerProtection.Result,
        error: [UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "computer.protectedPaths",
          summary: "Read paths protected from computer input",
          description:
            "Return trusted instruction, memory and configuration paths for the owner's desktop input gate. File contents are never returned.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("pruneScreenshots", ComputerPaths.prune, {
        query: WorkspaceRoutingQuery,
        payload: ComputerPrune.Input,
        success: ComputerPrune.Result,
        error: [InvalidRequestError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "computer.pruneScreenshots",
          summary: "Delete stored computer screenshots",
          description:
            "Delete computer screenshots before a time or in a session. Use all: true to delete every screenshot and reclaim database pages. Only the server owner can delete screenshots.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
