import { expect, test } from "bun:test"
import { ChildProcess } from "effect/unstable/process"
import { fileURLToPath } from "node:url"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { WindowsProcess } from "../../src/tool/shell/windows-process"

// Exercise the irreversible production switch in a child, without affecting later tests in the shard.
if (process.env.VECTOR_TEST_WINDOWS_PROCESS_REQUIRED_ISOLATION === "1") {
  ProcessIsolation.requireIsolation()
  test("WindowsProcess.start refuses required isolation before it starts the holder", async () => {
    const calls: string[] = []
    const error = await WindowsProcess.start(
      ChildProcess.make(process.execPath, ["-e", "process.exit(0)"], { stdin: "ignore" }),
      {
        onReady: async () => {
          calls.push("ready")
        },
        onOutput: async () => {
          calls.push("output")
        },
      },
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(WindowsProcess.WindowsProcessError)
    if (!(error instanceof WindowsProcess.WindowsProcessError)) throw new Error("The required boundary was bypassed.")
    expect(error.message).toBe(ProcessIsolation.REFUSAL)
    expect(error.terminationProven).toBe(true)
    expect(calls).toEqual([])
    console.log("WINDOWS_PROCESS_ISOLATION_REFUSED_BEFORE_HOLDER")
  })
} else {
  // The guard runs before the platform check, so every OS proves it: elsewhere the old code failed with the platform
  // message instead of the isolation refusal.
  test("WindowsProcess.start cannot bypass required tool isolation", async () => {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, VECTOR_TEST_WINDOWS_PROCESS_REQUIRED_ISOLATION: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stderr }).toMatchObject({ code: 0 })
      expect(stdout).toContain("WINDOWS_PROCESS_ISOLATION_REFUSED_BEFORE_HOLDER")
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
    }
  }, 30_000)
}
