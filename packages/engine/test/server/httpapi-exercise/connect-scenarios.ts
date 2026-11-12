import { Effect } from "effect"
import { check, object } from "./assertions"
import { http, route } from "./dsl"
import type { Scenario, SeededContext, SessionInfo } from "./types"

const root = "/experimental/connect"
const runID = "cr_connect_fixture"
const probeSession = "ses_connect_auth_probe"

// Activation is deliberately off in this exerciser. Reach each real typed handler with valid inputs and prove
// that its preview boundary refuses before recording history or asking a model; enabled behavior has dedicated
// owner HttpApi and actual native Node acceptance tests.
const disabled = (body: unknown, ctx: SeededContext<SessionInfo>) =>
  Effect.gen(function* () {
    object(body)
    check(body.code === "disabled", "the inactive connected preview must refuse before work")
    check((yield* ctx.messages(ctx.state.id)).length === 0, "a refused connected route must not write a transcript")
  })

export const connectScenarios: Scenario[] = [
  http.protected
    .get(root, "experimental.connect.list.disabled")
    .seeded((ctx) => ctx.session({ title: "Connected inventory owner" }))
    .at((ctx) => ({ path: `${root}?sessionID=${ctx.state.id}`, headers: ctx.headers() }))
    .jsonEffect(400, disabled),
  http.protected
    .get(`${root}/runs`, "experimental.connect.runs.disabled")
    .seeded((ctx) => ctx.session({ title: "Connected runs owner" }))
    .at((ctx) => ({ path: `${root}/runs?sessionID=${ctx.state.id}`, headers: ctx.headers() }))
    .jsonEffect(400, disabled),
  http.protected
    .get(`${root}/runs/{runID}`, "experimental.connect.get.disabled")
    .probe({ path: `${root}/runs/${runID}` })
    .seeded((ctx) => ctx.session({ title: "Connected result owner" }))
    .at((ctx) => ({
      path: `${route(`${root}/runs/{runID}`, { runID })}?sessionID=${ctx.state.id}`,
      headers: ctx.headers(),
    }))
    .jsonEffect(400, disabled),
  http.protected
    .post("/experimental/session/{sessionID}/connect", "experimental.connect.review.disabled")
    .probe({ path: `/experimental/session/${probeSession}/connect`, body: { background: false } })
    .seeded((ctx) => ctx.session({ title: "Connected review owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/connect", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { target: { kind: "uncommitted" }, background: false },
    }))
    .jsonEffect(400, disabled),
  http.protected
    .post(`${root}/review`, "experimental.connect.directory.disabled")
    .probe({ path: `${root}/review`, body: { background: false } })
    .seeded((ctx) => ctx.session({ title: "Connected directory owner" }))
    .at((ctx) => ({
      path: `${root}/review`,
      headers: ctx.headers(),
      body: { target: { kind: "uncommitted" }, background: false },
    }))
    .jsonEffect(400, disabled),
  http.protected
    .post(`${root}/runs/{runID}/cancel`, "experimental.connect.cancel.disabled")
    .probe({ path: `${root}/runs/${runID}/cancel?sessionID=${probeSession}`, body: {} })
    .seeded((ctx) => ctx.session({ title: "Connected cancellation owner" }))
    .at((ctx) => ({
      path: `${route(`${root}/runs/{runID}/cancel`, { runID })}?sessionID=${ctx.state.id}`,
      headers: ctx.headers(),
      body: {},
    }))
    .jsonEffect(400, disabled),
  http.protected
    .post(`${root}/findings`, "experimental.connect.register.disabled")
    .probe({
      path: `${root}/findings`,
      body: { sessionID: probeSession, target: { kind: "uncommitted" }, findings: [] },
    })
    .seeded((ctx) => ctx.session({ title: "Connected findings owner" }))
    .at((ctx) => ({
      path: `${root}/findings`,
      headers: ctx.headers(),
      body: { sessionID: ctx.state.id, target: { kind: "uncommitted" }, findings: [] },
    }))
    .jsonEffect(400, disabled),
  http.protected
    .post(`${root}/runs/{runID}/dismiss`, "experimental.connect.dismiss.disabled")
    .probe({ path: `${root}/runs/${runID}/dismiss`, body: { sessionID: probeSession, findings: ["f_fixture"] } })
    .seeded((ctx) => ctx.session({ title: "Connected dismissal owner" }))
    .at((ctx) => ({
      path: route(`${root}/runs/{runID}/dismiss`, { runID }),
      headers: ctx.headers(),
      body: { sessionID: ctx.state.id, findings: ["f_fixture"] },
    }))
    .jsonEffect(400, disabled),
]
