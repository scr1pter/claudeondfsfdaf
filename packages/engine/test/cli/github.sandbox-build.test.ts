import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { sandboxProbeTarget } from "../../script/sandbox-probe-target"
import { sandboxBunUndici } from "../../script/sandbox-bun-undici"
import { sandboxBunEsprima } from "../../script/sandbox-bun-esprima"
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

test("the Bun sandbox keeps no aliased esprima require for plain Bun to auto-install", async () => {
  await using temporary = await tmpdir()
  const build = await Bun.build({
    ...sandboxProbeTarget("bun"),
    entrypoints: [fileURLToPath(new URL("../fixture/sandbox-yaml-import.ts", import.meta.url))],
    outdir: temporary.path,
    format: "esm",
    plugins: [sandboxBunEsprima],
  })
  expect(build.success).toBe(true)
  const entry = build.outputs.find((value) => value.kind === "entry-point")
  expect(entry).toBeDefined()
  const text = await entry!.text()
  expect(text).toContain("js-yaml/lib/js-yaml/type/js/function.js")
  expect(text).not.toContain('"esprima"')
  // --no-install keeps a regression from reaching the registry; the text check above is what proves the plugin.
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entry!.path], {
    cwd: temporary.path,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(stdout)).toEqual({ name: "probe" })
}, 30_000)

test("the existing Bun cell executes its installed Bun artifact while host assertions remain on Node", async () => {
  const workflow = await Bun.file(
    fileURLToPath(new URL("../../../../.github/workflows/vector-at-mention.yml", import.meta.url)),
  ).text()
  expect(workflow).toContain(
    'install -m 0555 "$RUNNER_TEMP/vector-probe-tools/probe-bun.mjs" /opt/vector-sandbox-runtime/probe-bun.mjs',
  )
  expect(workflow).toContain(
    "vector github sandbox run -- /opt/vector-probe-bun --no-install /opt/vector-sandbox-runtime/probe-bun.mjs",
  )
  expect(workflow).toContain("node /opt/vector-sandbox-runtime/probe.mjs --assert")
  expect(workflow).toContain("for directory in assets node_modules rust-pty; do")
  expect(workflow).toContain('chmod -R a+rX,go-w -- "/opt/vector-sandbox-runtime/$directory"')
  expect(workflow).toContain("runtime: bun")
})

test("the sandbox profile lasts from tool configuration through PTY event storage", async () => {
  await using temporary = await tmpdir()
  const engine = fileURLToPath(new URL("../..", import.meta.url))
  const entry = path.join(temporary.path, "startup-profile.ts")
  const output = path.join(temporary.path, "receipt.json")
  await Bun.write(
    entry,
    `
      import fs from "node:fs/promises"
      import path from "node:path"
      await import(${JSON.stringify(path.join(engine, "test/fixture/sandbox-probe.ts"))})
      const { withToolProbeProfile } = await import(${JSON.stringify(path.join(engine, "test/fixture/sandbox-tool-probe.ts"))})
      const { LayerNode } = await import(${JSON.stringify(path.join(engine, "../core/src/effect/layer-node.ts"))})
      const { Effect } = await import(${JSON.stringify(fileURLToPath(import.meta.resolve("effect")))})
      let profile
      let network
      let databaseOpened = false
      try {
        const startup = await withToolProbeProfile(
          async (root) => {
            profile = root
            const { Flag } = await import(${JSON.stringify(path.join(engine, "../core/src/flag/flag.ts"))})
            const { Global } = await import(${JSON.stringify(path.join(engine, "../core/src/global.ts"))})
            const { EgressGuard } = await import(${JSON.stringify(path.join(engine, "../core/src/local-mode/guard.ts"))})
            const { ModelCatalog } = await import(${JSON.stringify(path.join(engine, "../core/src/model-catalog.ts"))})
            network = EgressGuard.installStrict()
            await Effect.runPromise(
              Effect.gen(function* () {
                const catalog = yield* ModelCatalog.Service
                yield* catalog.refresh(true)
              }).pipe(Effect.provide(LayerNode.compile(ModelCatalog.node)), Effect.scoped),
            )
            return {
              disabled: Flag.VECTOR_DISABLE_MODELS_FETCH,
              cacheMatches: Global.Path.cache === path.join(root, "cache", "vector"),
            }
          },
          async () => {
            const { EventV2 } = await import(${JSON.stringify(path.join(engine, "../core/src/event.ts"))})
            const { Database } = await import(${JSON.stringify(path.join(engine, "../core/src/database/database.ts"))})
            await Effect.runPromise(
              Effect.gen(function* () {
                yield* EventV2.Service
                const database = Database.path()
                const stat = yield* Effect.promise(() => fs.stat(database))
                databaseOpened = path.dirname(database) === path.join(profile, "data", "vector") && stat.isFile()
              }).pipe(Effect.provide(LayerNode.compile(EventV2.node)), Effect.scoped),
            )
          },
        )
        const profileRemoved = await fs.stat(profile).then(() => false, (error) => error.code === "ENOENT")
        await fs.writeFile(${JSON.stringify(output)}, JSON.stringify({
          ...startup,
          databaseOpened,
          profileRemoved,
          refused: network.attempts().filter(attempt => !attempt.allowed).map(({ kind, host }) => ({ kind, host })),
        }))
      } finally {
        network?.uninstall()
      }
    `,
  )
  // Match staging: another test's Bun-target resolver cache must not select this Node bundle's imports.
  const builder = path.join(temporary.path, "build-profile.ts")
  const bundled = path.join(temporary.path, "bundle", "probe.mjs")
  await Bun.write(
    builder,
    `
    import { sandboxProbeTarget } from ${JSON.stringify(path.join(engine, "script/sandbox-probe-target.ts"))}
    const engine = ${JSON.stringify(engine)}
    const build = await Bun.build({
      ...sandboxProbeTarget("node"),
      entrypoints: [${JSON.stringify(entry)}],
      outdir: ${JSON.stringify(path.dirname(bundled))},
      tsconfig: ${JSON.stringify(path.join(engine, "tsconfig.json"))},
      format: "esm",
      plugins: [{
        name: "installed-jsonc-esm",
        setup(build) {
          build.onResolve({ filter: /^jsonc-parser$/ }, args => ({
            path: Bun.resolveSync("jsonc-parser/lib/esm/main.js", args.resolveDir || engine),
          }))
        },
      }],
      files: { "brain-worker.gen.ts": "export default undefined", "vector-web-ui.gen.ts": "export default {}" },
      define: {
        VECTOR_MODEL_CATALOG: "{}",
        VECTOR_VERSION: JSON.stringify("0.0.0-sandbox-probe"),
        VECTOR_CHANNEL: JSON.stringify("dev"),
        VECTOR_PLUGIN_VERSION: JSON.stringify("0.0.0-sandbox-probe"),
      },
    })
    if (!build.success) throw new AggregateError(build.logs, "The startup profile bundle did not build")
  `,
  )
  const compiler = Bun.spawn([process.execPath, "--no-env-file", "--no-install", builder], {
    cwd: engine,
    env: { PATH: process.env.PATH ?? "" },
    stdout: "ignore",
    stderr: "pipe",
    timeout: 15_000,
    killSignal: "SIGKILL",
  })
  const [compiled, diagnostics] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()])
  expect({ code: compiled, stderr: diagnostics }).toEqual({ code: 0, stderr: "" })
  expect(await Bun.file(bundled).exists()).toBe(true)
  const node = Bun.which("node")
  expect(node).not.toBeNull()
  const child = Bun.spawn([node!, bundled, "--module-load-check"], {
    cwd: temporary.path,
    env: {
      PATH: process.env.PATH ?? "",
      RUNNER_TEMP: temporary.path,
      TMPDIR: temporary.path,
      XDG_CACHE_HOME: path.join(temporary.path, "before-profile", "cache"),
      XDG_DATA_HOME: path.join(temporary.path, "data"),
      XDG_CONFIG_HOME: path.join(temporary.path, "config"),
      XDG_STATE_HOME: path.join(temporary.path, "state"),
    },
    stdout: "ignore",
    stderr: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(await Bun.file(output).json()).toEqual({
    disabled: true,
    cacheMatches: true,
    databaseOpened: true,
    profileRemoved: true,
    refused: [],
  })
}, 30_000)
