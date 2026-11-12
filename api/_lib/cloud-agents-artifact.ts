import { createHash, createHmac } from "node:crypto"
import type { RunTokenClaims } from "./cloud-agents-run-token.js"
import { ApiError } from "./http.js"

/** Derivation inputs come only from an authenticated live run token, never request routing echoes. */
export function cloudRunArtifactKey(
  claims: Pick<RunTokenClaims, "sub" | "repo" | "gen" | "thr">,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const dedicated = env.VECTOR_RUN_ARTIFACT_SECRET ?? ""
  const license = env.VECTOR_LICENSE_SECRET ?? ""
  const master =
    dedicated.length >= 32
      ? Buffer.from(dedicated)
      : license.length >= 32
        ? createHmac("sha256", license).update("vector-run-artifact-key-v1").digest()
        : undefined
  if (!master) throw new ApiError(503, "RUN_ARTIFACTS_UNAVAILABLE", "Run artifacts are unavailable.")
  return {
    key: createHmac("sha256", master)
      .update(`${claims.sub}|${claims.repo}|${claims.gen}|${claims.thr}`)
      .digest("base64url"),
    keyId: createHash("sha256").update(master).digest("hex").slice(0, 16),
  }
}
