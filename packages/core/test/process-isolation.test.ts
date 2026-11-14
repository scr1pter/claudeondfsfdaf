import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProcessIsolation } from "../src/process-isolation"

test("native loader hooks are refused before a tool namespace wrapper can start", () => {
  for (const name of [
    "LD_PRELOAD",
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "GCONV_PATH",
    "GLIBC_TUNABLES",
    "LIBPATH",
  ])
    expect(() => ProcessIsolation.assertLoaderEnvironment({ [name]: "fixture-value" })).toThrow(
      "native loader environment",
    )
  expect(() =>
    ProcessIsolation.assertLoaderEnvironment({ PATH: "/usr/bin", LANG: "C.UTF-8", VECTOR_PROBE_ORDINARY: "preserved" }),
  ).not.toThrow()
})

test("hosted process boundaries hide engine proc and give tools their own PID and proc", () => {
  const engine = ProcessIsolation.engineArguments("/usr/bin/setpriv", ["--no-new-privs", "--", "/bin/true"], "/tmp")
  expect(engine).toContain("--tmpfs")
  expect(engine.slice(engine.indexOf("--tmpfs"), engine.indexOf("--tmpfs") + 4)).toEqual([
    "--tmpfs",
    "/proc",
    "--remount-ro",
    "/proc",
  ])
  expect(engine).not.toContain("--unshare-pid")
  const tool = ProcessIsolation.argumentsForTool("/bin/sh", ["-c", "echo example"], "/tmp")
  expect(tool).toContain("--unshare-user")
  expect(tool).toContain("--unshare-pid")
  expect(tool.slice(tool.indexOf("--proc"), tool.indexOf("--proc") + 2)).toEqual(["--proc", "/proc"])
  expect(tool).not.toContain("--unshare-user-try")
  expect(tool).not.toContain("--not-a-security-boundary")
  expect(tool.slice(-4)).toEqual(["--", "/bin/sh", "-c", "echo example"])
})

test.skipIf(process.platform !== "linux")(
  "kernel file guards refuse direct, symlinked and chained process aliases",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vector-process-paths-"))
    try {
      const alias = path.join(root, "ordinary-name")
      const chain = path.join(root, "ordinary-chain")
      await fs.symlink("/proc/self/fd/3", alias)
      await fs.symlink(alias, chain)
      const parent = path.join(root, "parent-link")
      await fs.symlink("/proc/self", parent)
      for (const target of [
        "/proc/self/fd/3",
        "/proc/1/task/1/mem",
        "/sys/kernel",
        "/dev/fd/3",
        "/dev/stdout",
        alias,
        chain,
        parent + "/../1/mem",
      ])
        expect(() => ProcessIsolation.assertKernelPath(target)).toThrow("kernel process files")
      expect(() => ProcessIsolation.assertKernelPath(path.join(root, "normal", "new-file.txt"))).not.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

test("this build holds the bubblewrap floor off and launches only through the explicit decision", () => {
  expect(ProcessIsolation.FLOOR).toBe(false)
  // Portable tests never call requireIsolation: it has no reset, and test files share one process.
  expect(ProcessIsolation.required()).toBe(false)
  const loader = { LD_PRELOAD: "/fixture/loader.so" }
  expect(ProcessIsolation.launch("/bin/true", ["--fixture"], { env: loader, shell: false })).toEqual({
    file: "/bin/true",
    args: ["--fixture"],
    shell: false,
  })
})

test("outside a hosted agent run, launches pass through even with a loader environment", () => {
  const options = { env: { LD_PRELOAD: "/fixture/loader.so" } }
  for (const floor of [false, true])
    expect(ProcessIsolation.decide("/bin/sh", ["-c", "true"], options, { guarded: false, floor })).toEqual({
      file: "/bin/sh",
      args: ["-c", "true"],
      shell: undefined,
    })
})

test("a hosted run without the floor keeps the loader refusal and starts the tool itself on Linux only", () => {
  const boundary = { guarded: true, floor: false }
  expect(() =>
    ProcessIsolation.decide("/bin/true", [], { env: { LD_PRELOAD: "/fixture/loader.so" } }, boundary),
  ).toThrow("native loader environment")
  if (process.platform !== "linux") {
    expect(() => ProcessIsolation.decide("/bin/true", [], { env: {} }, boundary)).toThrow(ProcessIsolation.REFUSAL)
    return
  }
  expect(
    ProcessIsolation.decide(
      "/bin/echo",
      ["ordinary"],
      { cwd: "/tmp", shell: true, env: { PATH: "/usr/bin" } },
      boundary,
    ),
  ).toEqual({ file: "/bin/echo", args: ["ordinary"], shell: true })
})

test("a hosted run with the floor wraps every tool in its own namespaces or refuses", () => {
  const boundary = { guarded: true, floor: true }
  expect(() =>
    ProcessIsolation.decide("/bin/true", [], { env: { LD_PRELOAD: "/fixture/loader.so" } }, boundary),
  ).toThrow("native loader environment")
  const usable = (() => {
    try {
      ProcessIsolation.assertBinary()
      return true
    } catch {
      return false
    }
  })()
  const attempt = () =>
    ProcessIsolation.decide("echo", ["ordinary"], { cwd: "/tmp", shell: true, env: { PATH: "/usr/bin" } }, boundary)
  if (!usable) {
    expect(attempt).toThrow(ProcessIsolation.REFUSAL)
    return
  }
  expect(attempt()).toEqual({
    file: ProcessIsolation.BINARY,
    args: ProcessIsolation.argumentsForTool("/bin/sh", ["-c", "echo ordinary"], "/tmp"),
    shell: false,
  })
})
