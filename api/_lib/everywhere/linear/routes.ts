import { createJobId } from "../../../../packages/schema/src/everywhere.js"
import { ApiError, json, readRawBody, requireMethod, type ApiRequest, type ApiResponse } from "../../http.js"
import { after } from "../after.js"
import { platformOn } from "../config.js"
import { eraseInstallation } from "../erase.js"
import { captureControl } from "../control.js"
import { sha256Hex } from "../signature.js"
import { installGuards, readInstall, readInstallSnapshot, readInstallState } from "../identity.js"
import { fencedStore } from "../authority.js"
import { createIntake } from "../intake.js"
import { jobEraser } from "../jobs.js"
import { everywhereKeys } from "../keys.js"
import { getValue, setValue } from "../store.js"
import { createLinearAdapter, type LinearDeps } from "./adapter.js"
import { parseLinear } from "./parse.js"
import { linearId, linearObject, verifyLinear } from "./verify.js"

export function createLinearWebhook(deps: LinearDeps) {
  const adapter = createLinearAdapter(deps)
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "POST")
      if (!platformOn(deps.config(), "linear")) return json(response, 404, { error: { code: "EVERYWHERE_OFF" } })
      const raw = await readRawBody(request, 1_048_576)
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value)
      const verified = verifyLinear(raw, headers, deps.config().linear?.webhookSecret, deps.context().now)
      if (!verified.ok) return json(response, verified.status, { error: { code: "SIGNATURE_INVALID" } })
      const body = verified.body
      const delivery = headers.get("linear-delivery")
      if (!linearId(delivery) || headers.get("linear-event") !== body.type || body.oauthClientId !== deps.config().linear?.clientId || !linearId(body.organizationId))
        return json(response, 400, { error: { code: "LINEAR_EVENT_INVALID" } })
      after("linear-event", async () => {
        const installation = `linear:${body.organizationId}`
        if (body.type === "OAuthApp" && body.action === "revoked" || body.type === "PermissionChange" && body.action === "teamAccessChanged") {
          // HMAC authenticates the semantic body, not Linear-Delivery or the send timestamp. No native grant id is
          // supplied, and a renewable access-token failure cannot prove terminal revocation of the current grant.
          if (typeof body.createdAt !== "string" || !Number.isFinite(Date.parse(body.createdAt))) return
          const permission = body.type === "PermissionChange"
          if (permission && (!linearId(body.appUserId) || !Array.isArray(body.addedTeamIds) || !body.addedTeamIds.every(linearId) ||
            !Array.isArray(body.removedTeamIds) || !body.removedTeamIds.every(linearId) || typeof body.canAccessAllPublicTeams !== "boolean")) return
          if (permission && (await readInstallState(deps.context().store, installation))?.record.botUserId !== body.appUserId) return
          const semantic = sha256Hex(JSON.stringify({ organization: body.organizationId, client: body.oauthClientId, type: body.type, action: body.action,
            createdAt: body.createdAt, ...(permission ? { appUserId: body.appUserId, canAccessAllPublicTeams: body.canAccessAllPublicTeams,
              added: [...body.addedTeamIds as string[]].sort(), removed: [...body.removedTeamIds as string[]].sort() } : {}) }))
          await captureControl(deps.context(), installation, semantic)
          // Retain a non-destructive generation hold until reconnect/native permission revalidation is qualified.
          return
        }
        const record = await readInstall(deps.context().store, installation)
        if (!record) return
        const session = linearObject(body.agentSession)
        const activity = linearObject(body.agentActivity)
        const eventId = body.action === "created" ? session.id : activity.id
        if (!linearId(eventId)) return
        // HMAC covers the body, not Linear-Delivery. Both the validated header and signed semantic event dedupe.
        const semantic = `${body.organizationId}:${body.action}:${eventId}`
        const parsed = parseLinear(body, semantic, record)
        if ("ignore" in parsed) return
        if (await getValue(deps.context().store, everywhereKeys.linearHeader(installation, delivery))) return
        await createIntake(adapter, { config: deps.config(), store: deps.context().store, ports: deps.ports,
          now: () => deps.context().now, sleep: deps.sleep }).process(parsed, {
          jid: createJobId(deps.context().now), platform: "linear", installation, shared: true, reply: parsed.reply,
        })
        const current = await readInstallSnapshot(deps.context().store, installation)
        if (!current || current.record.revision !== record.revision) return
        await setValue(fencedStore(deps.context().store, await installGuards(deps.context(), installation, current)), everywhereKeys.linearHeader(installation, delivery), semantic, { ttlMs: 7 * 86_400_000, onlyNew: true })
      })
      return json(response, 200, { received: true })
    } catch (error) {
      return json(response, error instanceof ApiError ? error.statusCode : 400, { error: { code: "LINEAR_REQUEST_INVALID" } })
    }
  }
}
