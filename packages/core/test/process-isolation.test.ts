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
  const engine = ProcessIsolation.engineArguments("/usr/bin/setpriv", ["--no-new-privs", "--", "/bin/true"], {
    cwd: "/workspace/original-checkout",
    container: "/mnt/vector-agent-sandbox",
  })
  expect(engine.slice(1, 4)).toEqual(["--ro-bind", "/", "/"])
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
  for (const boundary of [engine, tool]) {
    expect(boundary.slice(boundary.indexOf("--dev"), boundary.indexOf("--dev") + 2)).toEqual(["--dev", "/dev"])
    expect(boundary).not.toContain("--dev-bind")
    expect(boundary).not.toContain("--dev-bind-try")
  }
  expect(tool).not.toContain("--unshare-user-try")
  expect(tool).not.toContain("--not-a-security-boundary")
  expect(tool.slice(-4)).toEqual(["--", "/bin/sh", "-c", "echo example"])
})

test("engine writable exceptions cannot select a home, host tmp, toolcache or repository-controlled scope", () => {
  const scope = {
    cwd: "/workspace/original-checkout",
    container: "/mnt/vector-agent-sandbox",
    proofFile: "/runner/private/vector-sandbox/session-proof.json",
  }
  const engine = ProcessIsolation.engineArguments("/bin/true", [], scope)
  const writable = engine.flatMap((value, index) => (value === "--bind" ? [engine[index + 1]] : []))
  expect(writable).toEqual([
    "/mnt/vector-agent-sandbox/checkout",
    "/home/vector-agent/.local/share/vector",
    "/home/vector-agent/.local/state/vector",
    "/home/vector-agent/.config/vector",
    "/home/vector-agent/.cache/vector",
    "/home/vector-agent/tmp/vector-agent",
    scope.proofFile,
  ])
  for (const container of [
    "/",
    "/home/vector-agent",
    "/tmp",
    "/opt/hostedtoolcache",
    "/mnt/vector-agent-sandbox/checkout",
  ])
    expect(() => ProcessIsolation.engineArguments("/bin/true", [], { ...scope, container })).toThrow("refused")
  for (const cwd of ["relative", "/workspace/../tmp", "/workspace/invalid\0path"])
    expect(() => ProcessIsolation.engineArguments("/bin/true", [], { ...scope, cwd })).toThrow("refused")
  for (const proofFile of [
    "/tmp/any-file",
    "/proc/self/vector-sandbox/session-proof.json",
    "/home/vector-agent/tmp/vector-agent/vector-sandbox/session-proof.json",
    "/mnt/vector-agent-sandbox/checkout/vector-sandbox/session-proof.json",
  ])
    expect(() => ProcessIsolation.engineArguments("/bin/true", [], { ...scope, proofFile })).toThrow()
  for (const file of [
    "/mnt/vector-agent-sandbox/checkout/vector",
    "/home/vector-agent/.cache/vector/bin/node",
    "/home/vector-agent/.local/share/vector/engine.mjs",
  ])
    expect(() => ProcessIsolation.assertEngineExecutable(file, scope)).toThrow("writable agent directory")
  expect(() => ProcessIsolation.assertEngineExecutable("/usr/libexec/vector/engine", scope)).not.toThrow()
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
