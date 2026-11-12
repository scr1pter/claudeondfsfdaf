import { createJobId } from "../../../../packages/schema/src/everywhere.js"
import { ApiError, json, readRawBody, requireMethod, type ApiRequest, type ApiResponse } from "../../http.js"
import { after } from "../after.js"
import { platformOn } from "../config.js"
import { eraseInstallation } from "../erase.js"
import { readInstall } from "../identity.js"
import { createIntake } from "../intake.js"
import { jobEraser } from "../jobs.js"
import { createSlackAdapter, type SlackDeps } from "./adapter.js"
import { parseSlack, slackAuthorized, slackInstallations } from "./parse.js"
import { slackObject, verifySlack } from "./verify.js"

export function createSlackRoutes(deps: SlackDeps) {
  const adapter = createSlackAdapter(deps)
  const intake = () => createIntake(adapter, { config: deps.config(), store: deps.context().store, ports: deps.ports, now: () => deps.context().now })
  const route = (interactivity: boolean) => async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "POST")
      if (!platformOn(deps.config(), "slack")) return json(response, 404, { error: { code: "EVERYWHERE_OFF" } })
      const raw = await readRawBody(request, 262_144)
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value)
      if (!verifySlack(raw, headers, deps.config().slack?.signingSecret, deps.context().now)) return json(response, 401, { error: { code: "SIGNATURE_INVALID" } })
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
      const body = slackObject(JSON.parse(interactivity ? new URLSearchParams(text).get("payload") ?? "null" : text))
      if (!interactivity && body.type === "url_verification" && typeof body.challenge === "string" && body.challenge.length <= 4096)
        return json(response, 200, { challenge: body.challenge })
      if (body.api_app_id !== deps.config().slack?.appId) return json(response, 400, { error: { code: "SLACK_APP_INVALID" } })
      if (interactivity) {
        // Feedback cannot approve tools, alter a job, or spend. Never follow payload response_url or action URLs.
        return json(response, 200, { received: true })
      }
      if (body.type !== "event_callback") return json(response, 200, { received: true })
      after("slack-event", async () => {
        for (const installation of slackInstallations(body)) {
          const record = await readInstall(deps.context().store, installation)
          if (!record) continue
          const event = slackObject(body.event)
          if (event.type === "app_uninstalled" || event.type === "tokens_revoked") {
            const tokens = slackObject(event.tokens)
            if (event.type === "tokens_revoked" && (!Array.isArray(tokens.bot) || !tokens.bot.includes(record.botUserId))) continue
            await eraseInstallation({ ...deps.context(), jobs: jobEraser(deps.context().store) }, installation,
              event.type === "app_uninstalled" ? "uninstalled" : "tokens-revoked")
            continue
          }
          if (!slackAuthorized(body, installation, record)) continue
          const parsed = parseSlack(body, installation, record)
          if ("ignore" in parsed) return
          await intake().process(parsed, { jid: createJobId(deps.context().now), platform: "slack", installation, shared: parsed.trigger.shared, reply: parsed.reply })
          return
        }
      })
      return json(response, 200, { received: true })
    } catch (error) {
      return json(response, error instanceof ApiError ? error.statusCode : 400, { error: { code: "SLACK_REQUEST_INVALID" } })
    }
  }
  return { events: route(false), interactivity: route(true) }
}
