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
