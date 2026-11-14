import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { sandboxProbeTarget } from "../../script/sandbox-probe-target"
import { tmpdir } from "../fixture/fixture"

test("each sandbox artifact selects the actual matching Core SQLite adapter", async () => {
  await using temporary = await tmpdir()
  for (const runtime of ["node", "bun"] as const) {
    // Staging uses distinct serial Bun processes too; mixed-target bundler caches cannot substitute adapters.
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(new URL("../fixture/sandbox-build-selection.ts", import.meta.url)),
        runtime,
        temporary.path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual({
      runtime,
      file: sandboxProbeTarget(runtime).naming.entry,
      nodeSqlite: runtime === "node",
      bunSqlite: runtime === "bun",
    })
  }
}, 30_000)

test("the existing Bun cell executes its installed Bun artifact while host assertions remain on Node", async () => {
  const workflow = await Bun.file(
    fileURLToPath(new URL("../../../../.github/workflows/vector-at-mention.yml", import.meta.url)),
  ).text()
  expect(workflow).toContain(
    'install -m 0555 "$RUNNER_TEMP/vector-probe-tools/probe-bun.mjs" /opt/vector-sandbox-probe-bun.mjs',
  )
  expect(workflow).toContain("vector github sandbox run -- /opt/vector-probe-bun /opt/vector-sandbox-probe-bun.mjs")
  expect(workflow).toContain("node /opt/vector-sandbox-probe.mjs --assert")
  expect(workflow).toContain("runtime: bun")
})
