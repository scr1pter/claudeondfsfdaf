import { registerGatewayHook, registerHostedSessionVerifier } from "./model-plan-gateway-hooks.js"
import { registerRunVerifier } from "./model-plan-caller.js"
import { assertHostedSessionLive, recordHostedModelRequest, verifyHostedRunToken } from "./hosted-sessions.js"

/*
 * The cloud computer's hooks into the Codium gateway (contract §4.8, WP A53), registered by static import from the
 * routes that accept a run token (chat, `/models`, estimate), as the status route imports its meters:
 * - the `vht_` run verifier: a valid token for a session of the same account that is not stopping or ended;
 * - the hosted session check: the gateway refuses a session's model requests while the person has control or its block
 *   of time is not held (409 HOSTED_SESSION_PAUSED);
 * - a hook that notes each settled model request's time for the session, which the reaper's idle and fair-use checks
 *   read.
 */

registerRunVerifier("vht_", (token) => verifyHostedRunToken(token))
registerHostedSessionVerifier((sessionId) => assertHostedSessionLive(sessionId))
registerGatewayHook({
  id: "hosted-activity",
  async afterSettle(caller, context) {
    if (caller.run?.service !== "hosted" || !caller.run.sessionId) return
    await recordHostedModelRequest(caller.run.sessionId, context.endedAt).catch(() => undefined)
  },
})
