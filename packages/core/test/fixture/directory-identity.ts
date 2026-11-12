// CI-only observer. Production never accepts these paths/modes/environment/hooks and does not read /proc.
import fs from "node:fs"
import promises from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { DirectoryIdentityReader } from "../../src/directory-identity"
import { ReadOnlyGit } from "../../src/read-only-git"

const directory = process.argv[2],
  proof = process.argv[3],
  scenario = process.argv[4] ?? "positive",
  replacement = process.argv[5]
if (!directory || !proof) throw new Error("Missing CI fixture inputs")
const privateValue = fs.readFileSync(proof, "utf8")
const limited = spawnSync("/usr/bin/prlimit", ["--pid", String(process.pid), "--nofile=256:4096"], {
  env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  stdio: "ignore",
})
if (limited.status !== 0 || !/Max open files\s+256\s+4096/.test(fs.readFileSync("/proc/self/limits", "utf8")))
  throw new Error("No actual lowered descriptor limit")
for (const fd of [3, 2003]) {
  const value = Buffer.alloc(Buffer.byteLength(privateValue))
  fs.readSync(fd, value, 0, value.length, 0)
  if (value.toString() !== privateValue) throw new Error("Missing actual inherited private descriptor")
}
const poison = path.dirname(proof)
process.env.PYTHONPATH = poison
process.env.PYTHONHOME = poison
process.env.PYTHONSTARTUP = path.join(poison, "sitecustomize.py")
process.env.LD_PRELOAD = path.join(poison, "untrusted.so")
process.env.LD_LIBRARY_PATH = poison
process.chdir(poison)
const controller = new AbortController()
let observationError: unknown
let observed: { pid: number; start: string } | undefined
const identity = (pid: number) => {
  const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
  const fields = value.slice(value.lastIndexOf(")") + 2).split(" ")
  return fields[19]
}
const observer = setInterval(() => {
  if (observed) return
  for (const task of fs.readdirSync("/proc/self/task")) {
    let children: string
    try {
      children = fs.readFileSync(`/proc/self/task/${task}/children`, "utf8")
    } catch {
      continue
    }
    for (const value of children.trim().split(/\s+/)) {
      const pid = Number(value)
      if (!Number.isSafeInteger(pid) || pid <= 1) continue
      try {
        const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
        if (
          command[0] !== "/usr/bin/python3" ||
          command[1] !== "-I" ||
          command[2] !== "-S" ||
          command[3] !== "-c" ||
          command[4] !== DirectoryIdentityReader.SOURCE
        )
          continue
        const start = identity(pid)
        if (!start) throw new Error("Missing actual child start identity")
        observed = { pid, start }
        if (scenario === "timeout" || scenario === "cancel-child" || scenario === "metadata-race")
          process.kill(pid, "SIGSTOP")
        if (scenario === "cancel-child") controller.abort()
        if (scenario === "metadata-race") {
          if (!replacement) throw new Error("Missing actual replacement repository")
          fs.renameSync(path.join(directory, ".git"), path.join(directory, ".git-retired"))
          fs.cpSync(path.join(replacement, ".git"), path.join(directory, ".git"), { recursive: true })
          process.kill(pid, "SIGCONT")
        }
      } catch (error) {
        if (observed) {
          observationError = error
          controller.abort()
          try {
            if (identity(observed.pid) === observed.start) process.kill(observed.pid, "SIGKILL")
          } catch {}
        }
      }
    }
  }
}, 1)
let early: ReturnType<typeof setTimeout> | undefined
const handle = await promises.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
let result: DirectoryIdentityReader.Info | undefined,
  rejected = false
try {
  const before = await handle.stat({ bigint: true })
  if (scenario === "cancel-preflight") early = setTimeout(() => controller.abort(), 5)
  if (scenario === "metadata-race") {
    try {
      await ReadOnlyGit.metadataHead(directory, { signal: controller.signal })
    } catch {
      rejected = true
    }
  } else result = await DirectoryIdentityReader.read(handle, controller.signal)
  if (result && (result.dev !== before.dev.toString() || result.ino !== before.ino.toString()))
    throw new Error("Wrong actual pinned directory")
} finally {
  clearInterval(observer)
  if (early) clearTimeout(early)
  await handle.close()
}
if (observed) {
  const deadline = performance.now() + 2000
  while (true) {
    try {
      if (identity(observed.pid) !== observed.start) break
    } catch {
      break
    }
    if (performance.now() >= deadline) {
      try {
        if (identity(observed.pid) === observed.start) process.kill(observed.pid, "SIGKILL")
      } catch {}
      throw new Error("Actual proof child was not reaped")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
if (observationError) throw observationError
process.stdout.write(
  JSON.stringify({
    runtime: process.versions.bun ? "bun" : "node",
    value: result ?? null,
    inheritedPrivateDescriptors: [3, 2003],
    loweredLimit: 256,
    observedChild: !!observed,
    rejected,
  }) + "\n",
)
