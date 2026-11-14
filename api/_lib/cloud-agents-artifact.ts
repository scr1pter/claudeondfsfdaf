import { createHash, createHmac } from "node:crypto"
import type { RunTokenClaims } from "./cloud-agents-run-token.js"
import { ApiError } from "./http.js"

/** Inputs come only from live run claims or separately verified owner/private-run provenance, never routing echoes. */
export function cloudRunArtifactKey(
  claims: Pick<RunTokenClaims, "sub" | "repo" | "gen" | "thr">,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const master = artifactMaster(env)
  return {
    key: createHmac("sha256", master)
      .update(`${claims.sub}|${claims.repo}|${claims.gen}|${claims.thr}`)
      .digest("base64url"),
    keyId: createHash("sha256").update(master).digest("hex").slice(0, 16),
  }
}

/** Never derive this from the ordinary conversation key: ordinary repository runs can obtain that lesser grant. */
export function cloudBrainArtifactKey(
  claims: Pick<RunTokenClaims, "sub" | "repo" | "gen" | "thr">,
  context: { sha256: string; publicRepository: boolean },
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (!/^[0-9a-f]{64}$(?![\s\S])/.test(context.sha256) || typeof context.publicRepository !== "boolean")
    throw new ApiError(503, "RUN_ARTIFACTS_UNAVAILABLE", "Run artifacts are unavailable.")
  const master = artifactMaster(env)
  return {
    key: createHmac("sha256", master)
      .update(
        `vector-brain-conversation-v1|${claims.sub}|${claims.repo}|${claims.gen}|${claims.thr}|owner-desktop|${context.sha256}|${context.publicRepository ? "public" : "private"}`,
      )
      .digest("base64url"),
    keyId: createHash("sha256").update(master).digest("hex").slice(0, 16),
  }
}

/** Synthetic scopes exercise real key derivation without granting an account, run or artifact read. */
export function artifactCryptoReady(env: Readonly<Record<string, string | undefined>> = process.env) {
  const bytes: Buffer[] = []
  try {
    const scope = { sub: "00000000-0000-4000-8000-000000000001", repo: "1", gen: 1, thr: "1" }
    const ordinary = cloudRunArtifactKey(scope, env)
    const brain = cloudBrainArtifactKey(scope, { sha256: "0".repeat(64), publicRepository: false }, env)
    for (const grant of [ordinary, brain]) {
      const value = Buffer.from(grant.key, "base64url")
      bytes.push(value)
      if (value.length !== 32 || value.toString("base64url") !== grant.key || !/^[0-9a-f]{16}$/.test(grant.keyId))
        return false
    }
    return ordinary.key !== brain.key
  } catch {
    return false
  } finally {
    bytes.forEach((value) => value.fill(0))
  }
}

function artifactMaster(env: Readonly<Record<string, string | undefined>>) {
  const dedicated = env.VECTOR_RUN_ARTIFACT_SECRET ?? ""
  const license = env.VECTOR_LICENSE_SECRET ?? ""
  const master =
    dedicated.length >= 32
      ? Buffer.from(dedicated)
      : license.length >= 32
        ? createHmac("sha256", license).update("vector-run-artifact-key-v1").digest()
        : undefined
  if (!master) throw new ApiError(503, "RUN_ARTIFACTS_UNAVAILABLE", "Run artifacts are unavailable.")
  return master
}
