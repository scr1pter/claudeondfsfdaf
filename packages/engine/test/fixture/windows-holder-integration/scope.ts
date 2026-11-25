import path from "node:path"

export function integrationRunner() {
  const env = process.env
  const arch = env.VECTOR_DIRECT_HOLDER_ARCH
  const backend = env.VECTOR_DIRECT_HOLDER_BACKEND
  // The ordinary Engine lane disables Actions-specific application paths in its test process.
  const selection = env.VECTOR_DIRECT_HOLDER_SHARD
  const shard = selection === "1" || selection === "8"
  const delayConfig = env.VECTOR_DIRECT_HOLDER_DELAY_CONFIG === "1"
  if (
    (arch !== "x64" && arch !== "arm64") ||
    (backend !== "staged" && backend !== "carrier") ||
    (selection !== undefined && !shard) ||
    (shard && arch !== "x64") ||
    (delayConfig && (!shard || backend !== "staged")) ||
    process.platform !== "win32" ||
    process.arch !== arch ||
    env.RUNNER_ARCH !== arch.toUpperCase() ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== (shard ? "false" : "true") ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.VECTOR_DIRECT_HOLDER_FIXTURE !== "1" ||
    env.GITHUB_JOB !== "direct-holder-integration"
  ) {
    throw new Error("The direct holder integration requires its dedicated hosted Windows job")
  }
  const temporary = env.RUNNER_TEMP
  const run = env.GITHUB_RUN_ID
  const attempt = env.GITHUB_RUN_ATTEMPT
  const revision = env.GITHUB_SHA
  if (
    !temporary ||
    !/^[a-z]:\\/i.test(temporary) ||
    path.win32.normalize(temporary) !== temporary ||
    !run ||
    !/^\d{1,30}$/.test(run) ||
    !attempt ||
    !/^\d{1,9}$/.test(attempt) ||
    !revision ||
    !/^[a-f0-9]{40}$/.test(revision)
  ) {
    throw new Error("Invalid direct holder integration runner identity")
  }
  return { arch, temporary, run, attempt, revision, delayConfig, reportDelivery: selection === "1" || delayConfig }
}
