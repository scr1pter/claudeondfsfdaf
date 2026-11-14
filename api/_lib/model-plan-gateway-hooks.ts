import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { ApiError } from "./http.js"
import type { ModelPlanCaller } from "./model-plan-caller.js"
import type { ModelPlanModel } from "./model-plan-config.js"

export type BeforeAdmitContext = { snapshot: EntitlementSnapshot; model: ModelPlanModel; toolNames: readonly string[] }
export type AfterSettleContext = {
  snapshot: EntitlementSnapshot
  model: ModelPlanModel
  charge?: number
  startedAt: number
  endedAt: number
  streamed: boolean
}
export type GatewayHook = {
  id: string
  beforeAdmit?(caller: ModelPlanCaller, context: BeforeAdmitContext): Promise<void>
  afterSettle?(caller: ModelPlanCaller, context: AfterSettleContext): Promise<void>
}
export type GatewayHookOptions = {
  hooks?: readonly GatewayHook[]
  assertHostedSessionLive?: (sessionId: string) => Promise<boolean>
}
const hooks = new Map<string, GatewayHook>()
export function createHostedSessionVerifierRegistry() {
  const verifiers = new Map<"live", (sessionId: string) => Promise<boolean>>()
  return {
    register(verify: (sessionId: string) => Promise<boolean>) {
      if (typeof verify !== "function" || verifiers.has("live"))
        throw new Error("The Codium hosted session has exactly one verifier.")
      verifiers.set("live", verify)
    },
    get: () => verifiers.get("live"),
  }
}
const hosted = createHostedSessionVerifierRegistry()

/** Static service imports register once. Tests inject scoped hooks rather than replacing production handlers. */
export function registerGatewayHook(hook: GatewayHook) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(hook.id) || hooks.has(hook.id))
    throw new Error("A Codium gateway hook must have one unique id.")
  hooks.set(hook.id, hook)
}
export function registerHostedSessionVerifier(verify: (sessionId: string) => Promise<boolean>) {
  hosted.register(verify)
}

export async function beforeAdmit(
  caller: ModelPlanCaller,
  context: BeforeAdmitContext,
  options: GatewayHookOptions = {},
) {
  if (caller.kind === "run") {
    // Purpose comes from the signed verifier and may be review, so the signed run service (bound to the token prefix,
    // A16) owns these restrictions. The contract's purpose reading (§4.8) applies as well: either one triggers each.
    if (
      (caller.run?.service === "cloud-agents" || caller.purpose === "cloud-agents") &&
      context.toolNames.some((name) => /^computer(?:$|[_-])/i.test(name))
    )
      throw new ApiError(403, "MODEL_PLAN_BLOCKED", "Computer-use tools are not available to this run.")
    if (caller.run?.service === "hosted" || caller.purpose === "hosted") {
      const verify = options.assertHostedSessionLive ?? hosted.get()
      if (!verify || !caller.run?.sessionId)
        throw new ApiError(503, "HOSTED_UNAVAILABLE", "The hosted session could not be verified.")
      if (!(await verify(caller.run.sessionId)))
        throw new ApiError(409, "HOSTED_SESSION_PAUSED", "The hosted session is paused while you have control.")
    }
  }
  for (const hook of options.hooks ?? hooks.values()) await hook.beforeAdmit?.(caller, context)
}

export async function afterSettle(
  caller: ModelPlanCaller,
  context: AfterSettleContext,
  options: GatewayHookOptions = {},
) {
  for (const hook of options.hooks ?? hooks.values()) await hook.afterSettle?.(caller, context)
}
