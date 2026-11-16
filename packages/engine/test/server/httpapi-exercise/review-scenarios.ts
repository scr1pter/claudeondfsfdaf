import { array, check, object } from "./assertions"
import { http, route } from "./dsl"
import type { Scenario } from "./types"

const root = "/experimental/session/{sessionID}/review"
export const reviewScenarios: Scenario[] = [
  http.protected
    .get(`${root}/target`, "vectorscope.review.target")
    .seeded((ctx) => ctx.session({ title: "Local review target owner" }))
    .at((ctx) => ({ path: route(`${root}/target`, { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.kind === "working-tree", "target discovery must select the owner's local checkout")
      check(
        typeof body.head === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(body.head),
        "target discovery must return an exact head",
      )
    }),
  http.protected
    .post(root, "vectorscope.review.start.defaultOff")
    .seeded((ctx) => ctx.session({ title: "Disabled local review owner" }))
    .at((ctx) => ({
      path: route(root, { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { requestID: "request_exerciser_defaultoff", target: { kind: "working-tree", head: "a".repeat(40) } },
    }))
    .json(400, (body) => {
      object(body)
      check(body.code === "disabled", "a default-off review must not admit model work")
    }),
  http.protected
    .get(root, "vectorscope.review.list")
    .seeded((ctx) => ctx.session({ title: "Local review discovery owner" }))
    .at((ctx) => ({ path: route(root, { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.runs)
      check(body.runs.length === 0, "fresh local review discovery must be empty")
    }),
  http.protected
    .get(`${root}/{runID}`, "vectorscope.review.get.missing")
    .seeded((ctx) => ctx.session({ title: "Local review detail owner" }))
    .at((ctx) => ({
      path: route(`${root}/{runID}`, { sessionID: ctx.state.id, runID: "ses_review_missing" }),
      headers: ctx.headers(),
    }))
    .json(400, (body) => {
      object(body)
      check(body.code === "not_found", "unknown reviews cannot manufacture retained results")
    }),
  http.protected
    .post(`${root}/{runID}/stop`, "vectorscope.review.stop.missing")
    .seeded((ctx) => ctx.session({ title: "Local review stop owner" }))
    .at((ctx) => ({
      path: route(`${root}/{runID}/stop`, { sessionID: ctx.state.id, runID: "ses_review_missing" }),
      headers: ctx.headers(),
    }))
    .json(400, (body) => {
      object(body)
      check(body.code === "not_found", "stop must refuse an unknown owned run")
    }),
]
