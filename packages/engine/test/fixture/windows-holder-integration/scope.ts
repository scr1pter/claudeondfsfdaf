import path from "node:path"

export function integrationRunner() {
  const env = process.env
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    env.RUNNER_ARCH !== "X64" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.VECTOR_DIRECT_HOLDER_FIXTURE !== "1" ||
    env.GITHUB_JOB !== "direct-holder-integration"
  ) {
    throw new Error("The direct holder integration requires its dedicated hosted Windows x64 job")
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
  return { arch: "x64" as const, temporary, run, attempt, revision }
}
