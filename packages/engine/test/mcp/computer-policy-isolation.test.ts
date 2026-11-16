import { expect, test } from "bun:test"
import path from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

// ProcessIsolation.requireIsolation() is process-global and one-way, so the required-isolation MCP cases run in their
// own Bun process. Bun reads a test argument as a file path only when it starts with ./ or /, so the fixture, which
// has no .test. name, is passed relative to the engine package on every platform.
test("required isolation keeps the computer policy first and ends launch-floor refusals as failed MCP statuses", async () => {
  const started = performance.now()
  const child = Bun.spawn(
    [process.execPath, "test", "--timeout", "30000", "./test/fixture/mcp-required-isolation.ts"],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: untrustedChildEnvironment(process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 50_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stderr).toMatch(/\b4 pass\b/)
    expect(stderr).toContain(" 0 fail")
    // Linux plans an allowed command plainly while the bubblewrap floor is held, or refuses it without bubblewrap. Off
    // Linux the floor must refuse it, so a floor that starts planning there fails here, not only in the log line.
    expect(stdout).toMatch(
      process.platform === "linux"
        ? /MCP_REQUIRED_ISOLATION_LAUNCH=(planned|refused)/
        : /MCP_REQUIRED_ISOLATION_LAUNCH=refused/,
    )
    // The child's output is captured, so a passing run would otherwise leave neither its launch branch nor its elapsed
    // time in the shard log. The elapsed time shows how close a slow host comes to the 50 s kill.
    console.log(
      `${stdout.match(/MCP_REQUIRED_ISOLATION_LAUNCH=\w+/)?.[0]} childElapsedMs=${Math.round(performance.now() - started)}`,
    )
  } finally {
    clearTimeout(timer)
    child.kill("SIGKILL")
    await child.exited
  }
}, 60_000)
