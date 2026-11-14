import { randomUUID } from "node:crypto"
import { Effect, Option } from "effect"
import { array, check, object } from "./assertions"
import { http, route } from "./dsl"
import type { Scenario, ScenarioContext } from "./types"

const root = "/experimental/review-memory"
// A well-formed scope that no exerciser repository derives: preparing against it must refuse before any Core work.
const otherScope = `vrs1_${"0".repeat(64)}`

export const reviewMemoryScenarios: Scenario[] = [
  http.protected
    .get(root, "reviewMemory.inspect.defaultOff")
    .seeded(physicalScope)
    .json(verified(200), (body, ctx) => {
      if (Option.isNone(ctx.state)) return unverified(body)
      object(body)
      check(typeof body.repository === "string", "inspect must name the verified repository")
      check(body.scope === ctx.state.value, "inspect must answer for this repository's physical scope")
      object(body.state)
      check(body.state.enabled === false, "review memory must stay off by default")
      array(body.state.entries)
      check(body.state.entries.length === 0, "a fresh repository must hold no review memory")
    }),
  http.protected
    .post(`${root}/prepare`, "reviewMemory.prepare.otherScope")
    .seeded(physicalScope)
    .at((ctx) => ({
      path: `${root}/prepare`,
      headers: ctx.headers(),
      body: { expectedScope: otherScope, command: { action: "configure", expected: 0, enabled: true } },
    }))
    .json(400, (body, ctx) => {
      if (Option.isNone(ctx.state)) return unverified(body)
      object(body)
      check(body.code === "stale", "a preview for another displayed scope must be refused without preparing it")
    }),
  http.protected
    .post(`${root}/confirm`, "reviewMemory.confirm.unknown")
    .at((ctx) => ({
      path: `${root}/confirm`,
      headers: ctx.headers(),
      body: { previewId: randomUUID(), approvedSha256: "a".repeat(64) },
    }))
    .json(400, (body) => {
      object(body)
      check(body.code === "unavailable", "an unknown preview must not apply any review-memory change")
    }),
  http.protected
    .delete(`${root}/previews/{previewId}`, "reviewMemory.discard.unknown")
    .seeded(physicalScope)
    .at((ctx) => ({ path: route(`${root}/previews/{previewId}`, { previewId: randomUUID() }), headers: ctx.headers() }))
    .json(verified(200), (body, ctx) => {
      if (Option.isNone(ctx.state)) return unverified(body)
      check(body === true, "discarding an unknown preview is an idempotent no-op")
    }),
]

// The owner authority derives the scope from a pinned Git common-directory identity that needs a supported host
// statx reader (DirectoryIdentityReader). Read the same proof first, so a host without one expects the refusal.
function physicalScope(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    const { ReviewMemoryScope } = yield* Effect.promise(() => import("../../../src/review/memory-scope"))
    if (!ctx.directory) throw new Error("review memory scenarios need a project directory")
    return yield* ReviewMemoryScope.git(ctx.directory).pipe(
      Effect.map((proof) => proof.binding.scope),
      Effect.option,
    )
  })
}

// An unverifiable repository is refused with the route's 400 error before any memory is read or prepared.
function verified(status: number) {
  return (ctx: { state: Option.Option<string> }) => (Option.isSome(ctx.state) ? status : 400)
}

function unverified(body: unknown) {
  object(body)
  check(body.code === "unavailable", "an unverifiable repository must refuse review memory")
}
