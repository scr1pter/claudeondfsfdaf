import { afterAll, expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { FSUtil } from "@vectordevai/core/fs-util"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { Review } from "../../src/review/run"
import { SessionRetry } from "../../src/session/retry"
import { stoppedLine } from "../../src/cli/cmd/github.agent"
import { GithubBundle } from "../../src/cli/cmd/github.bundle"
import { withCodiumReview } from "../../src/cli/cmd/github.review-codium"
import { runtime, setup } from "../lib/research"
import { CODIUM_MODEL, cleanup, cloudRecorder, codiumFakes, holder } from "./github.agent-fixture"

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: {} })
const codium = codiumFakes()
const it = runtime(web, { replacements: codium.replacements })
afterAll(async () => {
  SessionRetry.pinGateway(undefined)
  await web.close()
  await cleanup()
})

const files = parseUnifiedDiff(
  [
    "diff --git a/src/value.ts b/src/value.ts",
    "--- a/src/value.ts",
    "+++ b/src/value.ts",
    "@@ -1 +1 @@",
    "-export const value = 1",
    "+export const value = 2",
  ].join("\n"),
)

for (const mode of ["exhausted", "recovered-invalid", "recovered"] as const) {
  it.instance(
    `Codium review gateway ${mode} associates only an unrecovered final refusal with its public stop`,
    () =>
      Effect.gen(function* () {
        const test = yield* setup()
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(path.join(test.dir, "src/value.ts"), "export const value = 2\n")
        const time = { now: Date.now(), refusals: 0 }
        codium.reset({
          codium: true,
          target: test.llm.url,
          ...(mode === "exhausted"
            ? {
                sticky: { kind: "refuse" as const, status: 429, code: "MODEL_PLAN_CONCURRENCY" },
                onRefusal: () => {
                  if (++time.refusals > 1) time.now += GithubAgents.CONCURRENCY_RETRY_MS
                },
              }
            : { queue: [{ kind: "refuse" as const, status: 429, code: "MODEL_PLAN_BUSY" }] }),
        })
        if (mode === "recovered")
          yield* test.llm.tool("StructuredOutput", {
            summary: "Updates the constant.",
            risk: "low",
            files: [{ path: "src/value.ts", note: "Updates the value" }],
            findings: [],
          })
        if (mode === "recovered-invalid") {
          yield* test.llm.text("This answer is missing the required report.")
          yield* test.llm.text("The finalizer also has no structured report.")
        }
        const cloud = cloudRecorder()
        const credentials = yield* Effect.promise(() => holder("codium"))
        const outcome = yield* withCodiumReview(
          (control) =>
            Effect.gen(function* () {
              const result = yield* Review.run({
                directory: test.dir,
                trigger: "local",
                trust: "trusted",
                base: "1".repeat(40),
                head: "2".repeat(40),
                mode: "full",
                files,
                anchors: files,
                skipped: [],
                context: {},
                prior: [],
                rules: "",
                config: {
                  ...DEFAULT_REVIEW_CONFIG,
                  security: "off",
                  verify: "off",
                  maxCostUsd: 0,
                  maxCostUsdPerPr: 0,
                  maxCostUsdPerMonth: 0,
                },
                model: {
                  providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID),
                  modelID: ModelV2.ID.make(CODIUM_MODEL.id),
                  context: CODIUM_MODEL.contextLength,
                  costKind: "codium",
                },
                checks: false,
                stopSignal: control.signal,
                knownPath: async () => true,
                onProgress: (event) => {
                  if (event.type === "cost") control.stepFinished()
                },
              })
              control.reviewFinished(result)
              if (mode === "exhausted") {
                expect(control.stopped()).toMatchObject({
                  stop: "MODEL_PLAN_CONCURRENCY",
                  reason: GithubBundle.STOP_REASON.busy,
                })
                expect(stoppedLine(control.stopped()!)).toBe("Vector stopped early: Codium was busy.")
              }
              if (mode === "recovered-invalid") {
                expect(result.partial).toBe("model-error")
                expect(control.stopped()).toEqual({ behaviour: "draft", reason: GithubBundle.STOP_REASON.early })
                expect(stoppedLine(control.stopped()!)).not.toContain("busy")
              }
              if (mode === "recovered") {
                expect(result.partial).toBeUndefined()
                expect(result.specialists[0]?.status).toBe("ok")
                expect(control.stopped()).toBeUndefined()
              }
              control.outcome(control.stopped() ? "draft" : "no-changes")
              return result
            }),
          {
            env: { VECTOR_RUN_DEADLINE: String(time.now + 3_600_000) },
            credentials,
            services: cloud.services,
            now: () => time.now,
          },
        )
        if (!outcome) return yield* Effect.die("Missing review result")
        expect(outcome.partial).toBe(mode === "recovered" ? undefined : "model-error")
        expect(cloud.requests.at(-1)?.body).toEqual({ outcome: mode === "recovered" ? "no-changes" : "draft" })
        const requests = codium.state.requests.filter((request) => !request.title)
        expect(requests.filter((request) => request.action === "refuse").length).toBeGreaterThan(0)
        expect(requests.filter((request) => request.action === "forward").length).toBe(
          mode === "exhausted" ? 0 : mode === "recovered" ? 1 : 2,
        )
        expect(guard.outside()).toEqual([])
      }),
    { git: true },
    30_000,
  )
}
