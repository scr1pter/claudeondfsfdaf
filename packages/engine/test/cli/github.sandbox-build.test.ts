import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { sandboxProbeTarget } from "../../script/sandbox-probe-target"
import { sandboxBunUndici } from "../../script/sandbox-bun-undici"
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

test("the Bun sandbox preserves and can import the installed Undici wrapper without bundler rewriting", async () => {
  await using temporary = await tmpdir()
  const wrapper = await sandboxBunUndici(fileURLToPath(new URL("../..", import.meta.url)))
  const build = await Bun.build({
    ...sandboxProbeTarget("bun"),
    entrypoints: [fileURLToPath(new URL("../fixture/sandbox-undici-import.ts", import.meta.url))],
    outdir: temporary.path,
    format: "esm",
    plugins: [wrapper.plugin],
  })
  expect(build.success).toBe(true)
  const entry = build.outputs.find((value) => value.kind === "entry-point")
  expect(entry).toBeDefined()
  expect(await entry!.text()).toContain(`./${wrapper.asset}`)
  await Bun.write(path.join(temporary.path, wrapper.asset), wrapper.contents)
  expect(await Bun.file(path.join(temporary.path, wrapper.asset)).arrayBuffer()).toEqual(
    await Bun.file(wrapper.source).arrayBuffer(),
  )
  const child = Bun.spawn([process.execPath, "--no-env-file", entry!.path], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(stdout)).toEqual({ agent: "function", dispatcher: "function", same: true })
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
