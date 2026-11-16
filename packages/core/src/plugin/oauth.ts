import { Effect } from "effect"
import type { PluginContext } from "@vectordevai/plugin/v2/effect"
import { providerOAuthAllowed } from "../provider-policy"
import { ProcessIsolation } from "../process-isolation"
import {
  approvalValid,
  pluginCredentialMetadata,
  requirePluginAuthorization,
  requirePluginDestination,
  type OAuthApproval,
} from "./oauth-approval"

// Compiled consent adapters must not erase the actual external registration's restrictive origin.
function provenance<T>(source: unknown, value: T): T {
  return ProcessIsolation.isExternalCode(source) ? ProcessIsolation.markExternalCode(value) : value
}

/** Consent constrains the supported OAuth interface, not the plugin's arbitrary executable code. */
export function oauthPluginContext(host: PluginContext, approvals: OAuthApproval[]): PluginContext {
  return {
    ...host,
    plugin: {
      ...host.plugin,
      add: (child) =>
        host.plugin.add({
          ...child,
          effect: provenance(child.effect, (context) => child.effect(oauthPluginContext(context, approvals))),
        }),
    },
    integration: {
      ...host.integration,
      transform: (callback) =>
        host.integration.transform(
          provenance(callback, (draft) =>
            callback({
              ...draft,
              method: {
                ...draft.method,
                update(input) {
                  if (!("authorize" in input)) {
                    draft.method.update(input)
                    return
                  }
                  const approval = approvals.find(
                    (value) => value.declaration.provider === input.integrationID && approvalValid(value),
                  )
                  if (!approval && !providerOAuthAllowed(input.integrationID, true)) return
                  if (!approval) {
                    draft.method.update(input)
                    return
                  }
                  const stamp = (
                    value:
                      | { type: "key"; key: string; metadata?: Readonly<Record<string, unknown>> }
                      | {
                          type: "oauth"
                          access: string
                          refresh: string
                          expires: number
                          methodID: string
                          metadata?: Readonly<Record<string, unknown>>
                        },
                  ) => {
                    if (
                      value.metadata?.oauth_client_id !== undefined &&
                      value.metadata.oauth_client_id !== approval.declaration.clientId
                    )
                      throw new Error("Plugin OAuth returned another client's credential.")
                    if (
                      value.metadata?.oauth_instance_url !== undefined &&
                      value.metadata.oauth_instance_url !== approval.declaration.issuer
                    )
                      throw new Error("Plugin OAuth returned another issuer's credential.")
                    return { ...value, metadata: { ...value.metadata, ...pluginCredentialMetadata(approval) } }
                  }
                  draft.method.update({
                    ...input,
                    authorize: (values) =>
                      Effect.gen(function* () {
                        pluginCredentialMetadata(approval)
                        const result = yield* input.authorize(values)
                        requirePluginAuthorization(approval, result)
                        return result.mode === "auto"
                          ? { ...result, callback: result.callback.pipe(Effect.map(stamp)) }
                          : { ...result, callback: (code: string) => result.callback(code).pipe(Effect.map(stamp)) }
                      }),
                    ...(input.refresh
                      ? {
                          refresh: (value) =>
                            Effect.gen(function* () {
                              pluginCredentialMetadata(approval)
                              if (value.metadata?.vector_plugin_oauth !== approval.id)
                                throw new Error("Plugin OAuth cannot refresh another plugin's credential.")
                              return stamp(yield* input.refresh!(value)) as typeof value
                            }),
                        }
                      : {}),
                  })
                },
              },
            }),
          ),
        ),
    },
    aisdk: {
      ...host.aisdk,
      sdk: (callback) =>
        host.aisdk.sdk(
          provenance(
            callback,
            Effect.fn(function* (event) {
              const approval = approvals.find(
                (value) => value.declaration.provider === event.model.providerID && approvalValid(value),
              )
              if (approval) {
                requirePluginDestination(approval, event.options.baseURL)
                const guard = (send: unknown) => async (request: RequestInfo | URL, init?: RequestInit) => {
                  requirePluginDestination(approval, request instanceof Request ? request.url : String(request))
                  const connection = await Effect.runPromise(
                    host.integration.connection.active(approval.declaration.provider),
                  )
                  const credential = connection
                    ? await Effect.runPromise(host.integration.connection.resolve(connection))
                    : undefined
                  if (credential?.metadata?.vector_plugin_oauth !== approval.id)
                    throw new Error("Plugin OAuth credential changed. Reconnect to continue.")
                  // A cached call may have awaited connection gates since its outer model was admitted.
                  if (ProcessIsolation.isExternalCode(callback)) ProcessIsolation.assertExternalCodeAllowed()
                  ProcessIsolation.assertExternalValueAllowed(send)
                  const transport = typeof send === "function" ? send : fetch
                  return transport(request, { ...init, redirect: "error" })
                }
                let guarded = guard(event.options.fetch)
                // Each replacement closes over the previous transport, so wrapping an existing
                // options.fetch remains finite and preserves request-time revocation checks.
                Object.defineProperty(event.options, "fetch", {
                  configurable: true,
                  enumerable: true,
                  get: () => guarded,
                  set: (value: unknown) => {
                    if (value !== guarded) guarded = guard(value)
                  },
                })
              }
              const result = callback(event)
              if (result) yield* result
              if (approval) requirePluginDestination(approval, event.options.baseURL)
            }),
          ),
        ),
    },
  }
}
