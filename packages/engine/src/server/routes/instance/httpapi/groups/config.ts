import { Config } from "@/config/config"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/config"

export const TrustStatus = Schema.Struct({
  workspace: Schema.String,
  trusted: Schema.Boolean,
  ignored: Schema.Boolean,
  // Whether the project has settings of its own (config, .vector or skills content) that trust decides on. Without
  // them `ignored` means only the user's language servers, formatters and MCP servers are held back.
  settings: Schema.Boolean,
  // Whether the client asking may approve trust. Only the server's owner may; an invited guest reads the status, but
  // its approval is refused, so the app tells the guest that the host decides instead of asking.
  approvable: Schema.Boolean,
}).annotate({ identifier: "ProjectTrustStatus" })

/** A held prompt file and its fingerprint now, none for a file that is gone. An approval names these back. */
export const PromptTrustFile = Schema.Struct({
  path: Schema.String,
  fingerprint: Schema.optional(Schema.String),
}).annotate({ identifier: "PromptTrustFile" })

/** The prompt files outside the repository that changed since the owner last approved them, which Vector holds. */
export const PromptTrustStatus = Schema.Struct({
  held: Schema.Array(Schema.String),
  files: Schema.Array(PromptTrustFile),
}).annotate({ identifier: "PromptTrustStatus" })

/** The held files the owner was shown, as GET returned them: only these are approved, and only unchanged. */
export const PromptTrustApproval = Schema.Struct({
  files: Schema.Array(PromptTrustFile),
}).annotate({ identifier: "PromptTrustApproval" })

export const PromptTrustApproved = Schema.Struct({
  /** How many held files the approval let in. */
  approved: Schema.Finite,
}).annotate({ identifier: "PromptTrustApproved" })

/**
 * A change to a key a company lock keeps (Config.lockedIn): nothing was written. `keys` names each one, top-level or as
 * `local.<key>`.
 */
export class ConfigLockedError extends Schema.ErrorClass<ConfigLockedError>("ConfigLocked")(
  {
    name: Schema.Literal("ConfigLocked"),
    data: Schema.Struct({
      keys: Schema.Array(Schema.String),
      message: Schema.String,
    }),
  },
  { httpApiStatus: 403 },
) {}

/** Config as GET returns it, with the keys a company lock keeps, which a change cannot set. */
export const ConfigWithLocks = Schema.Struct({
  ...ConfigV1.Info.fields,
  locked: Schema.Array(Schema.String).annotate({
    description:
      "The config keys your company's policy sets and locks, such as local, share and autoupdate. A change to one fails with ConfigLocked. Empty without a company lock.",
  }),
}).annotate({ identifier: "ConfigWithLocks" })

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigWithLocks, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current Vector configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Successfully updated config"),
          error: [HttpApiError.BadRequest, ConfigLockedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description:
              "Update Vector configuration settings and preferences. Under a company lock, a change to a key the company keeps fails with ConfigLocked.",
          }),
        ),
        HttpApiEndpoint.get("trust", `${root}/trust`, {
          query: WorkspaceRoutingQuery,
          success: described(TrustStatus, "Project trust status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.trust.get",
            summary: "Get project trust",
            description:
              "Whether the project's own config and .vector content are trusted, and whether they are being ignored until they are.",
          }),
        ),
        HttpApiEndpoint.post("approveTrust", `${root}/trust`, {
          query: WorkspaceRoutingQuery,
          success: described(TrustStatus, "Project trust status after approval"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.trust.approve",
            summary: "Trust project",
            description:
              "Approve the project's config and .vector content as they are now, so Vector loads them. Any later change to anything that can run needs approval again.",
          }),
        ),
        HttpApiEndpoint.get("promptTrust", `${root}/prompt-trust`, {
          query: WorkspaceRoutingQuery,
          success: described(PromptTrustStatus, "Held prompt files"),
          error: HttpApiError.Forbidden,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.promptTrust.get",
            summary: "Get held prompt files",
            description:
              "The prompt files outside this repository (global agents, commands, skills and instruction files, and the prompt settings of global config) that changed since the owner last approved them. Vector does not load them until the owner approves. Owner only.",
          }),
        ),
        HttpApiEndpoint.post("approvePromptTrust", `${root}/prompt-trust/approve`, {
          query: WorkspaceRoutingQuery,
          payload: PromptTrustApproval,
          success: described(PromptTrustApproved, "Prompt files approved"),
          error: [HttpApiError.Forbidden, HttpApiError.Conflict],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.promptTrust.approve",
            summary: "Approve held prompt files",
            description:
              "Approve the held prompt files the owner was shown, as GET returned them, and reload the instance so Vector loads them. When the files held now are not exactly those, unchanged, nothing is approved and the request fails with 409: read the list again. Owner only.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "vector experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
