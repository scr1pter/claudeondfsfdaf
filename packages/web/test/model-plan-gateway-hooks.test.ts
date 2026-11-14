import { expect, test } from "bun:test"
import { ENTITLEMENTS, type EntitlementSnapshot } from "../../schema/src/codium-entitlements"
import { CODIUM_MODELS, CODIUM_TIER_MODELS } from "../../../api/_lib/codium-catalog"
import {
  beforeAdmit,
  afterSettle,
  registerGatewayHook,
  createHostedSessionVerifierRegistry,
} from "../../../api/_lib/model-plan-gateway-hooks"
import { modelPlanRequest } from "../../../api/_lib/model-plan-chat"
import type { ModelPlanCaller } from "../../../api/_lib/model-plan-caller"

const snapshot: EntitlementSnapshot = {
  v: 1,
  version: 1,
  livemode: false,
  account: "22222222-2222-4222-8222-222222222222",
  state: "active",
  plan: "vector-100",
  subscription: "sub_fixture",
  periodStart: 1793232000000,
  periodEnd: 1795824000000,
  meterEpoch: "sub_fixture:1793232000000",
  cancelAtPeriodEnd: false,
  ramp: { hostedUntil: 0, browserFrom: 0 },
  caps: ENTITLEMENTS["vector-100"],
  updatedAt: 1793232000000,
  checkedAt: 1793232000000,
  source: "request",
}
const caller: ModelPlanCaller = {
  account: { id: snapshot.account },
  kind: "run",
  purpose: "review",
  run: { id: "run_fixture", source: "github-comment", deadline: Date.now() + 3600000, service: "cloud-agents" },
}
const context = { snapshot, model: CODIUM_MODELS[0], toolNames: [] as string[] }

test.each(["computer", "computer_use", "computer_click", "computer-use", "COMPUTER_SCREENSHOT"])(
  "a cloud-agent run's verified review purpose cannot evade the computer tool restriction: %s",
  async (name) => {
    await expect(beforeAdmit(caller, { ...context, toolNames: [name] })).rejects.toMatchObject({
      code: "MODEL_PLAN_BLOCKED",
      statusCode: 403,
    })
  },
)

test("ordinary local tools remain allowed and desktop callers do not inherit run-only tool restrictions", async () => {
  await beforeAdmit(caller, { ...context, toolNames: ["read", "edit", "bash"] })
  await beforeAdmit(
    { account: caller.account, kind: "desktop", purpose: "chat" },
    { ...context, toolNames: ["computer_use"] },
  )
})

test("hosted runs require an available live session verifier even when their signed purpose is review", async () => {
  const hosted: ModelPlanCaller = {
    ...caller,
    run: { ...caller.run!, service: "hosted", sessionId: "session_fixture" },
  }
  await expect(beforeAdmit(hosted, context)).rejects.toMatchObject({ code: "HOSTED_UNAVAILABLE", statusCode: 503 })
  const checked: string[] = []
  await expect(
    beforeAdmit(hosted, context, {
      assertHostedSessionLive: async (id) => {
        checked.push(id)
        return false
      },
    }),
  ).rejects.toMatchObject({ code: "HOSTED_SESSION_PAUSED", statusCode: 409 })
  await beforeAdmit(hosted, context, {
    assertHostedSessionLive: async (id) => {
      checked.push(id)
      return true
    },
  })
  expect(checked).toEqual(["session_fixture", "session_fixture"])
})

test("a run whose signed purpose names the other service gets that service's guard too", async () => {
  // The contract's purpose reading (§4.8) is enforced beside the signed service: neither one alone opens a guard.
  const live = { assertHostedSessionLive: async () => true }
  const hostedPurpose: ModelPlanCaller = { ...caller, purpose: "hosted" }
  await expect(beforeAdmit(hostedPurpose, context, live)).rejects.toMatchObject({
    code: "HOSTED_UNAVAILABLE",
    statusCode: 503,
  })
  const cloudPurpose: ModelPlanCaller = {
    ...caller,
    purpose: "cloud-agents",
    run: { ...caller.run!, service: "hosted", sessionId: "session_fixture" },
  }
  await expect(beforeAdmit(cloudPurpose, { ...context, toolNames: ["computer_use"] }, live)).rejects.toMatchObject({
    code: "MODEL_PLAN_BLOCKED",
    statusCode: 403,
  })
  await beforeAdmit(cloudPurpose, { ...context, toolNames: ["read"] }, live)
})

test("scoped hooks receive immutable caller/model identity and settlement observations without replacing production hooks", async () => {
  const observed: string[] = []
  const options = {
    hooks: [
      {
        id: "fixture",
        beforeAdmit: async () => {
          observed.push("before")
        },
        afterSettle: async () => {
          observed.push("after")
        },
      },
    ],
  }
  await beforeAdmit(caller, context, options)
  await afterSettle(caller, { snapshot, model: context.model, startedAt: 1, endedAt: 2, streamed: false }, options)
  expect(observed).toEqual(["before", "after"])
  const hook = { id: "fixture-registration" }
  registerGatewayHook(hook)
  expect(() => registerGatewayHook(hook)).toThrow("unique")
  const verifier = async () => true
  const registry = createHostedSessionVerifierRegistry()
  registry.register(verifier)
  expect(() => registry.register(verifier)).toThrow("one verifier")
})

test.each([
  "openai/gpt-6.1-sol:deep",
  "openai/gpt-6.1-sol:deepest",
  "moonshotai/kimi-k3.1-pro:fast",
  "google/gemini-4-argon:fast",
])("synthetic planned routing pins upstream and exact providers for %s without implying qualification", (id) => {
  const model = CODIUM_TIER_MODELS.find((model) => model.id === id)!
  const body = modelPlanRequest(
    {
      model: id,
      messages: [{ role: "user", content: "fixture" }],
      provider: { only: ["unreviewed"], allow_fallbacks: true },
      reasoning: { effort: "low" },
    },
    [model],
  )
  expect(body.model).toBe("upstream" in model ? model.upstream : model.id)
  expect(body.provider).toMatchObject({
    only: "providerOnly" in model ? [...model.providerOnly] : [],
    allow_fallbacks: false,
    zdr: true,
    data_collection: "deny",
  })
  expect(body.reasoning).toEqual({ effort: model.reasoningEffort })
})
