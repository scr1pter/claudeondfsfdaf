import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { cloudRunArtifactKey, cloudBrainArtifactKey } from "../../../api/_lib/cloud-agents-artifact"

const claims = { sub: "17da3820-500b-4d92-8c50-6092ec6ee9bd", repo: "123", gen: 1, thr: "5" }
const secret = "artifact-fixture-secret-at-least-32-characters"

test("artifact keys are stable per account, repository, generation and authenticated thread", () => {
  const first = cloudRunArtifactKey(claims, { VECTOR_RUN_ARTIFACT_SECRET: secret })
  expect(first).toEqual(cloudRunArtifactKey(claims, { VECTOR_RUN_ARTIFACT_SECRET: secret }))
  expect(Buffer.from(first.key, "base64url")).toHaveLength(32)
  expect(first.keyId).toMatch(/^[0-9a-f]{16}$/)
  for (const changed of [
    { ...claims, sub: "04068ab1-7c56-4e6a-b81d-77d59f07d68f" },
    { ...claims, repo: "124" },
    { ...claims, gen: 2 },
    { ...claims, thr: "6" },
  ])
    expect(cloudRunArtifactKey(changed, { VECTOR_RUN_ARTIFACT_SECRET: secret }).key).not.toBe(first.key)
  expect(JSON.stringify(first)).not.toContain(secret)
  expect(JSON.stringify(first)).not.toContain(claims.sub)
})

test("artifact key fallback uses a separate HMAC domain and missing configuration fails closed", () => {
  const fallback = cloudRunArtifactKey(claims, { VECTOR_LICENSE_SECRET: secret })
  const master = createHmac("sha256", secret).update("vector-run-artifact-key-v1").digest()
  expect(fallback.key).toBe(createHmac("sha256", master).update(`${claims.sub}|123|1|5`).digest("base64url"))
  expect(fallback.key).not.toBe(cloudRunArtifactKey(claims, { VECTOR_RUN_ARTIFACT_SECRET: secret }).key)
  expect(() => cloudRunArtifactKey(claims, {})).toThrow("Run artifacts are unavailable.")
  expect(() => cloudRunArtifactKey(claims, { VECTOR_RUN_ARTIFACT_SECRET: "short" })).toThrow()
})

test("Brain conversation authority is separately keyed by exact approved digest and visibility under the artifact master", () => {
  const env = { VECTOR_RUN_ARTIFACT_SECRET: secret }
  const context = { sha256: "a".repeat(64), publicRepository: false }
  const ordinary = cloudRunArtifactKey(claims, env)
  const brain = cloudBrainArtifactKey(claims, context, env)
  expect(brain).toEqual(cloudBrainArtifactKey(claims, context, env))
  expect(brain.key).not.toBe(ordinary.key)
  expect(brain.keyId).toBe(ordinary.keyId)
  expect(cloudBrainArtifactKey(claims, { ...context, sha256: "b".repeat(64) }, env).key).not.toBe(brain.key)
  expect(cloudBrainArtifactKey(claims, { ...context, publicRepository: true }, env).key).not.toBe(brain.key)
  expect(cloudBrainArtifactKey({ ...claims, gen: 2 }, context, env).key).not.toBe(brain.key)
  expect(cloudBrainArtifactKey({ ...claims, thr: "6" }, context, env).key).not.toBe(brain.key)
  const label = `vector-brain-conversation-v1|${claims.sub}|123|1|5|owner-desktop|${context.sha256}|private`
  expect(brain.key).toBe(createHmac("sha256", secret).update(label).digest("base64url"))
  expect(brain.key).not.toBe(
    createHmac("sha256", Buffer.from(ordinary.key, "base64url")).update(label).digest("base64url"),
  )
  expect(() => cloudBrainArtifactKey(claims, { ...context, sha256: "bad" }, env)).toThrow()
})
