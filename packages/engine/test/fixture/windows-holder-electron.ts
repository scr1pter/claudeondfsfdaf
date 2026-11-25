import { channel } from "node:diagnostics_channel"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { ChildProcess } from "effect/unstable/process"
import { windowsHolderCompanionName } from "../../src/tool/shell/windows-holder-companion-name"
import { windowsHolderCompanion } from "../../src/tool/shell/windows-holder-direct"
import { WindowsProcess, WindowsProcessError } from "../../src/tool/shell/windows-process"

const [mode, architecture, version] = process.argv.slice(2)
const electron = process as NodeJS.Process & {
  type?: string
  resourcesPath?: string
  parentPort?: {
    on(event: "message", listener: (event: { data: unknown }) => void): void
    postMessage(message: string): void
  }
}
const root = "C:\\Windows"

async function verify() {
  const resources = path.win32.join(path.win32.dirname(await realpath(process.execPath)), "resources")
  if (
    process.platform !== "win32" ||
    process.arch !== architecture ||
    process.versions.electron !== version ||
    electron.type !== "utility" ||
    electron.resourcesPath?.toLowerCase() !== resources.toLowerCase() ||
    (mode !== "present" && mode !== "missing" && mode !== "changed")
  )
    throw new Error("Invalid packaged Electron utility.")
  const selected = windowsHolderCompanion(root)
  if (selected?.placement !== "electron" || selected.image.arch !== architecture)
    throw new Error("The packaged holder selection is missing.")
  const file = path.win32
    .join(resources, "engine", "windows-holder", windowsHolderCompanionName(selected.image.arch, selected.image.sha256))
    .toLowerCase()
  const command = ChildProcess.make(`${root}\\System32\\cmd.exe`, ["/d", "/s", "/c", "exit 23"], {
    cwd: root,
    env: { SystemRoot: root },
    stdin: "ignore",
  })

  let acknowledged: number | undefined
  let launches = 0
  let direct = false
  const traffic = channel("tracing:child_process.spawn:start")
  const observe = (value: unknown) => {
    launches++
    const invoked = (value as { options?: { file?: string } })?.options?.file
    direct = typeof invoked === "string" && invoked.toLowerCase() === file
  }
  traffic.subscribe(observe)
  try {
    const handle = await WindowsProcess.start(command, {
      async onReady(pid) {
        acknowledged = pid
      },
      async onOutput() {
        throw new Error("The synthetic command cannot write output.")
      },
    })
    const result = await handle.completion
    if (
      mode !== "present" ||
      launches !== 1 ||
      !direct ||
      handle.pid !== acknowledged ||
      result.exitCode !== 23 ||
      !result.terminated
    ) {
      throw new Error("The exact direct holder did not acknowledge and terminate the synthetic command.")
    }
  } catch (error) {
    if (
      mode === "present" ||
      launches !== 0 ||
      acknowledged !== undefined ||
      !(error instanceof WindowsProcessError) ||
      !error.terminationProven ||
      error.message !== "The installed Windows containment helper failed verification"
    ) {
      throw error
    }
  } finally {
    traffic.unsubscribe(observe)
  }
}

try {
  if (!electron.parentPort) throw new Error("The Electron utility channel is missing.")
  await verify()
  electron.parentPort.on("message", (event) => {
    if (event.data === "acknowledge") process.exit(0)
  })
  electron.parentPort.postMessage(`vector-holder-electron ${mode}\n`)
} catch {
  process.exit(1)
}
