import { CONTROL, TEMP, WORKSPACE, control, controllerAction, ci, need, jsonFile, object } from "./common"

// Gate direct invocation too: no production module is initialized on any rejected argv.
async function main() {
  ci()
  const action = controllerAction(process.argv.slice(2))
  const selected = control()
  need(
    process.execPath === `${CONTROL}/runtime/node` &&
      process.env.GITHUB_WORKSPACE === WORKSPACE &&
      process.env.VECTOR_MODE === selected.mode,
  )
  if (action === "finish") {
    // Product finish permits absent-state no-op; this acceptance controller must never call that clean.
    const state = jsonFile(`${TEMP}/vector-sandbox/state.json`, false)
    need(
      object(state) &&
        state.workspace === WORKSPACE &&
        state.mode === selected.mode &&
        state.sudo === false &&
        state.nativeRequired === true,
    )
  }
  const { GithubIsolation } = await import("../../../src/cli/cmd/github.isolation")
  const { ProcessIsolation } = await import("@vectordevai/core/process-isolation")
  need(GithubIsolation.enabled() && ProcessIsolation.nativeBuild().entrySHA === selected.assetSHA256)
  // Only the existing fixture's normal production dispatch is reused. Prototype installer/observe/run code is absent.
  const sandbox = await import("../../../src/cli/cmd/github.sandbox")
  try {
    if (action === "prepare") await sandbox.prepare()
    else await sandbox.finish()
  } catch (error) {
    const failure = GithubIsolation.failureMetadata(error)
    if (failure) {
      const encoded = JSON.stringify(failure)
      need(Buffer.byteLength(encoded) <= 4096)
      process.stderr.write("VECTOR_NATIVE_CONTROL_FAILURE " + encoded + "\n")
    } else process.stderr.write("Native Shell CI controller refused\n")
    process.exitCode = 125
  }
}
void main().catch(() => {
  process.stderr.write("Native Shell CI controller refused\n")
  process.exitCode = 125
})
