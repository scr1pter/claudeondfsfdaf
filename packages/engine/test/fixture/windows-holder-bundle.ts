import { ChildProcess } from "effect/unstable/process"
import { windowsHolderCompanion } from "../../src/tool/shell/windows-holder-direct"
import { WindowsProcess } from "../../src/tool/shell/windows-process"

const root = "C:\\Windows"
const check = process.env.VECTOR_WINDOWS_HOLDER_BUNDLE_CHECK
if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  process.env.CI !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.GITHUB_JOB !== "engine-windows" ||
  check !== "direct" ||
  windowsHolderCompanion(root)?.wire !== "vsh1"
) {
  throw new Error("The Windows bundle check requires its active hosted holder.")
}

let acknowledged: number | undefined
const command = ChildProcess.make(`${root}\\System32\\cmd.exe`, ["/d", "/s", "/c", "exit 23"], {
  cwd: root,
  env: { SystemRoot: root },
  stdin: "ignore",
})
const holder = await WindowsProcess.start(command, {
  async onReady(pid) {
    acknowledged = pid
  },
  async onOutput() {
    throw new Error("The synthetic command should not produce output.")
  },
})
const result = await holder.completion
if (holder.pid !== acknowledged || result.exitCode !== 23 || result.terminated !== true)
  throw new Error("The bundled holder did not acknowledge and clean up its test command.")
