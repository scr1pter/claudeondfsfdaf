import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"

// The backstop guard under Node, the runtime of the desktop's engine (Electron's utility process) and main process. The
// fixtures are bundled for Node the way the desktop build bundles them, then run with Node, and with Electron as Node
// when this checkout has Electron's binary. The CLI's runtime, Bun, is covered by core's guard and egress tests.

const MARK = "guard-smoke "
const NODE = Bun.which(process.env.VECTOR_NODE ?? "node")
const require = createRequire(import.meta.url)
// The engine's own copy of the ws package, which Node loads as it is (Bun would serve its own instead).
const WS = path.join(import.meta.dir, "../../../engine/node_modules/ws")

// Electron's binary, when its install has downloaded it; a checkout installed without scripts has none.
const electron = (() => {
  const directory = path.dirname(require.resolve("electron/package.json"))
  const recorded = path.join(directory, "path.txt")
  if (!existsSync(recorded)) return undefined
  const binary = path.join(directory, "dist", readFileSync(recorded, "utf8").trim())
  return existsSync(binary) ? binary : undefined
})()

const bundle = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vector-guard-smoke-"))
  // The worker is bundled on its own, as the engine build bundles the brain's reader, and started from its source.
  const built = await Bun.build({
    entrypoints: ["guard-smoke.fixture.ts", "guard-smoke-strict.fixture.ts", "guard-smoke.worker.ts"].map((name) =>
      path.join(import.meta.dir, name),
    ),
    target: "node",
    format: "esm",
    outdir: directory,
    naming: "[name].mjs",
    // As the engine build names guard-worker.ts: strict mode starts no Worker without its preload, which Node ignores
    // but a bundle in a temporary folder would not have beside it.
    define: {
      VECTOR_GUARD_WORKER_PATH: JSON.stringify(
        path.join(import.meta.dir, "../../../core/src/local-mode/guard-worker.ts"),
      ),
    },
  })
  if (!built.success) throw new AggregateError(built.logs, "The guard smoke did not bundle")
  return {
    directory,
    file: path.join(directory, "guard-smoke.fixture.mjs"),
    strict: path.join(directory, "guard-smoke-strict.fixture.mjs"),
  }
}

const run = async (command: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // No proxy of the machine's own, so every request the smoke makes is decided as the smoke sets it up.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const line = stdout.split("\n").find((item) => item.startsWith(MARK))
  if (code !== 0 || !line) throw new Error(`The guard smoke failed (${code}):\n${stdout}\n${stderr}`)
  return JSON.parse(line.slice(MARK.length)) as Record<string, unknown>
}

const expected = {
  fetch: "EgressBlocked",
  // Node's fetch connects through net, so a copy taken before the guard is still decided at the socket.
  capturedFetch: "EgressBlocked",
  https: "EgressBlocked",
  net: "EgressBlocked",
  webSocket: "EgressBlocked",
  // Node's WebSocket connects through net too: the guard refused it, not the unrouted address.
  capturedWebSocket: { outcome: "error", refused: true },
  here: "here",
  capturedHere: "here",
  redirect: "EgressBlocked",
  labelled: "answered",
  unlabelled: "EgressBlocked",
  resolvedOutside: "EgressBlocked",
  proxyUnlabelled: "EgressBlocked",
  proxyUnlabelledFetch: "EgressBlocked",
  proxyLabelled: "proxied",
  proxyLocalInference: "here",
  proxyLoopbackFetch: "here",
  proxyLoopbackHttp: "EgressBlocked",
  // A model call's prompt, or anything else for this computer, never reaches the proxy.
  seenByProxy: ["CONNECT catalog.web.test:80"],
  ws: "EgressBlocked",
  worker: { net: "EgressBlocked", fetch: "EgressBlocked" },
  researchProxy: ["HTTP/1.1 407 Proxy Authentication Required", "here"],
}
const local = { GUARD_SMOKE_WS: WS }

describe("the backstop guard under Node", () => {
  test.skipIf(!NODE)(
    "blocks every client's unlabelled connection off this computer, and lets labelled ones through",
    async () => {
      const smoke = await bundle()
      const results = await run([NODE!, smoke.file], local).finally(() =>
        rm(smoke.directory, { recursive: true, force: true }),
      )
      expect(String(results.runtime)).toStartWith("node ")
      expect(results).toMatchObject(expected)
      // Every refusal is in the log as an unlabelled request; the labelled ones are not among them.
      const blocked = results.blocked as [string, string][]
      expect(blocked.filter(([source]) => source !== "unlabelled")).toEqual([])
      expect(blocked.filter(([, rule]) => rule === "resolved-outside")).toHaveLength(1)
      expect(blocked).toHaveLength(13)
    },
    60_000,
  )

  test.skipIf(!NODE)(
    "installs the strict test guard, which runs no proxy of its own there",
    async () => {
      const smoke = await bundle()
      const results = await run([NODE!, smoke.strict], { VECTOR_TEST_EGRESS: "strict" }).finally(() =>
        rm(smoke.directory, { recursive: true, force: true }),
      )
      expect(results).toMatchObject({
        installed: true,
        proxyEnvironment: null,
        fetch: "EgressBlocked",
        https: "EgressBlocked",
        net: "EgressBlocked",
        here: "here",
        worker: { net: "EgressBlocked", fetch: "EgressBlocked" },
      })
    },
    60_000,
  )

  test.skipIf(!electron)(
    "does the same in Electron's own Node",
    async () => {
      const smoke = await bundle()
      const results = await run([electron!, smoke.file], { ...local, ELECTRON_RUN_AS_NODE: "1" }).finally(() =>
        rm(smoke.directory, { recursive: true, force: true }),
      )
      expect(results.electron).not.toBeNull()
      expect(results).toMatchObject(expected)
    },
    60_000,
  )
})
