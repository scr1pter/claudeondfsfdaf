import { array, check, object } from "./assertions"
import { http, route } from "./dsl"
import type { Scenario } from "./types"

const root = "/experimental/session/{sessionID}/review"
const fixRoot = `${root}/fix`
const head = "a".repeat(40)
const digest = `sha256:${"b".repeat(64)}`
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
  http.protected
    .get(fixRoot, "vectorscope.review.fix.list")
    .seeded((ctx) => ctx.session({ title: "Local fix discovery owner" }))
    .at((ctx) => ({ path: route(fixRoot, { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.fixes)
      check(body.fixes.length === 0, "a fresh conversation has no open fixes")
    }),
  http.protected
    .post(fixRoot, "vectorscope.review.fix.prepare.defaultOff")
    .seeded((ctx) => ctx.session({ title: "Disabled local fix owner" }))
    .at((ctx) => ({
      path: route(fixRoot, { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        source: { kind: "client" },
        head,
        base: "c".repeat(40),
        baseBranch: "main",
        findings: ["finding-1"],
        files: [{ path: "a.ts", preimage: digest, postimage: `sha256:${"d".repeat(64)}` }],
        patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      },
    }))
    .json(400, (body) => {
      object(body)
      check(body.code === "disabled", "a default-off fix must place nothing")
    }),
  http.protected
    .post(`${fixRoot}/{fixID}/preview`, "vectorscope.review.fix.preview.defaultOff")
    .seeded((ctx) => ctx.session({ title: "Disabled local fix offer owner" }))
    .at((ctx) => ({
      path: route(`${fixRoot}/{fixID}/preview`, { sessionID: ctx.state.id, fixID: "fix_exerciser" }),
      headers: ctx.headers(),
      body: { kind: "apply" },
    }))
    .json(400, (body) => {
      object(body)
      check(body.code === "disabled", "a default-off fix must offer no step")
    }),
  http.protected
    .post(`${fixRoot}/{fixID}/execute`, "vectorscope.review.fix.execute.defaultOff")
    .seeded((ctx) => ctx.session({ title: "Disabled local fix execute owner" }))
    .at((ctx) => ({
      path: route(`${fixRoot}/{fixID}/execute`, { sessionID: ctx.state.id, fixID: "fix_exerciser" }),
      headers: ctx.headers(),
      body: { offerID: "01234567-89ab-4cde-8fab-0123456789ab", head, patchDigest: digest, operationDigest: digest },
    }))
    .json(400, (body) => {
      object(body)
      check(body.code === "disabled", "a default-off fix must run no step")
    }),
  http.protected
    .post(`${fixRoot}/{fixID}/cancel`, "vectorscope.review.fix.cancel.missing")
    .seeded((ctx) => ctx.session({ title: "Local fix cancel owner" }))
    .at((ctx) => ({
      path: route(`${fixRoot}/{fixID}/cancel`, { sessionID: ctx.state.id, fixID: "fix_exerciser" }),
      headers: ctx.headers(),
    }))
    .json(400, (body) => {
      object(body)
      check(body.code === "not_found", "cancel must refuse an unknown fix")
    }),
]
