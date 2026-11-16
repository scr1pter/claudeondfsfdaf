#!/usr/bin/env bun
// Smoke test for the brain's background reader in the compiled CLI.
//
// The compiled binary carries the reader as one string, the virtual module brain-worker.gen.ts, and starts it as an
// eval worker; from source the reader starts from entry.ts instead, so only a compiled binary can show the bundled
// reader starts. This runs `vector memory doc extract` on a generated PDF with the binary, in a home of its own, and
// fails unless the PDF was read in a worker thread from the bundle, not on the main thread. It also asks the binary
// for its search model; with VECTOR_TEST_EMBED_DIR (a folder of the pinned arctic-embed-xs files) it installs the
// model from there, which loads ONNX Runtime's wasm embedded in the binary, keeps the PDF, and searches it by meaning.
// First it checks that the reader as the build bundles it stays sealed under the egress test variables, which only a
// test may honour.
//
//   bun script/verify-brain-worker.ts dist/<platform>/bin/vector    (build.ts runs this after each native build)
//   bun script/verify-brain-worker.ts                                (compiles a binary for this machine first)
//
// Without a binary it compiles one the way build.ts does for this machine, with no web UI, catalog, notices or
// package installs, into a temporary folder, so the smoke runs on its own in about a minute. Nothing leaves this
// computer: the account, site, registry and model catalog all point at nothing.

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { lines, pdf } from "../../core/test/brain/fixture/pdf"
import { bundleBrainWorker } from "./brain-worker"
import { linuxIsolationBuildPlugin } from "../../../script/linux-isolation-asset"

const SMOKE = { version: "0.0.0-brain-worker-smoke", channel: "brain-worker-smoke" }
const isolation = await linuxIsolationBuildPlugin(false)
const STARTED = "brain reader started in a worker thread"
const FALLBACK = "brain reader runs on the main thread"
const dir = path.resolve(import.meta.dirname, "..")

const given = process.argv[2] ? path.resolve(process.argv[2]) : undefined
// As build.ts does, so the binary is built from the same relative entrypoints.
process.chdir(dir)
const scratch = await mkdtemp(path.join(os.tmpdir(), "vector-brain-worker-"))
try {
  const binary = given ?? (await compile(path.join(scratch, "bin")))
  const failures = [...(await sealed()), ...(await smoke(binary, path.join(scratch, "home")))]
  if (failures.length > 0) {
    console.error(`brain worker smoke FAILED (${binary}):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  }
  if (failures.length === 0)
    console.log(
      `brain worker smoke passed: the compiled CLI read a PDF in its bundled background reader${process.env.VECTOR_TEST_EMBED_DIR ? ", and searched it by meaning with the search model on its embedded wasm" : ""}`,
    )
} finally {
  await rm(scratch, { recursive: true, force: true })
}

async function smoke(binary: string, home: string) {
  const repository = path.join(home, "repo")
  await mkdir(repository, { recursive: true })
  await writeFile(
    path.join(repository, "spec.pdf"),
    pdf({
      pages: [
        {
          runs: [
            { text: "Auth spec", x: 72, y: 740, size: 20, font: "bold" },
            ...lines(["Refresh tokens expire after 14 days."], { top: 700 }),
          ],
        },
        { runs: lines(["Clients MUST retry at most 3 times after a 429 response."]) },
      ],
    }),
  )
  // A signed-in account as the CLI keeps one, verified today, so it asks the site nothing.
  await mkdir(path.join(home, "data", "vector"), { recursive: true })
  await writeFile(
    path.join(home, "data", "vector", "cli-auth.json"),
    JSON.stringify({
      token: "vct_synthetic-brain-worker-smoke.synthetic",
      user: { id: "synthetic-brain-worker-smoke", email: "synthetic@example.invalid" },
      verifiedAt: Date.now(),
    }),
  )
  await writeFile(path.join(home, "models.json"), "{}")
  const run = (args: string[]) =>
    spawnSync(binary, ["--print-logs", "--log-level", "INFO", ...args], {
      cwd: repository,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(home, "home"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_STATE_HOME: path.join(home, "state"),
        VECTOR_DISABLE_MODELS_FETCH: "true",
        VECTOR_MODELS_PATH: path.join(home, "models.json"),
        VECTOR_DISABLE_AUTOUPDATE: "true",
        VECTOR_DISABLE_DEFAULT_PLUGINS: "true",
        VECTOR_DISABLE_USAGE: "true",
        VECTOR_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        VECTOR_PURE: "1",
        VECTOR_SITE_URL: "http://127.0.0.1:1",
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:1",
      },
    })
  const result = run(["memory", "doc", "extract", "spec.pdf", "--json"])
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  if (result.error) return [`the binary could not run: ${result.error.message}`]
  if (result.status !== 0) return [`vector memory doc extract exited ${result.status}:\n${output.slice(-4_000)}`]
  const structured = await Promise.resolve()
    .then(() => JSON.parse(result.stdout) as { format?: string; pages?: number; records?: { card: string }[] })
    .catch(() => undefined)
  return [
    ...(structured?.format === "pdf" && structured.pages === 2
      ? []
      : [`the PDF was not read as two pages: ${result.stdout.slice(0, 400)}`]),
    ...(structured?.records?.some((record) => record.card.includes("retry at most 3 times"))
      ? []
      : ["no record of the retry requirement came back"]),
    ...(output.includes(STARTED) ? [] : ["the background reader never started in a worker thread"]),
    ...(output.includes(STARTED) && !/started in a worker thread[^\n]*bundle/.test(output)
      ? ["the background reader did not start from the bundled source"]
      : []),
    ...(output.includes(FALLBACK) ? ["the background reader fell back to the main thread"] : []),
    ...(await meaning(run)),
  ]
}

// The reader as the build bundles it knows it runs in a build of Vector, so it stays sealed whatever the test variables
// say: a name they pin to this computer, answered there by its resolver, is still refused. Run under Bun, as the CLI
// runs it, from its source as an eval worker.
async function sealed() {
  const sink = net.createServer((socket) => socket.end())
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve))
  const port = (sink.address() as net.AddressInfo).port
  const probe = `
;(async () => {
  const net = await import("node:net")
  const { parentPort } = await import("node:worker_threads")
  const lookup = (_host, options, callback) =>
    options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4)
  const named = await new Promise((resolve) => {
    try {
      const socket = net.connect({ host: "api.example.com", port: ${port}, lookup })
      socket.on("connect", () => {
        socket.destroy()
        resolve("connected")
      })
      socket.on("error", (error) => resolve(error.name))
    } catch (error) {
      resolve(error.name)
    }
  })
  parentPort.postMessage({ named })
})()`
  const worker = new Worker((await bundleBrainWorker(SMOKE, isolation)) + probe, {
    eval: true,
    env: { ...process.env, VECTOR_TEST_EGRESS: "strict", VECTOR_TEST_EGRESS_NAMES: "example.com" },
  })
  const answer = await new Promise<unknown>((resolve) => {
    worker.on("message", (message) => {
      if (message && typeof message === "object" && "named" in message) resolve(message.named)
    })
    worker.on("error", (error) => resolve(`the reader failed: ${error.message}`))
    setTimeout(() => resolve("no answer in 20 seconds"), 20_000).unref()
  }).finally(() => {
    void worker.terminate()
    sink.close()
  })
  return answer === "EgressBlocked"
    ? []
    : [`the bundled reader honoured the test variables, so its seal let a pinned name through: ${String(answer)}`]
}

// The search model in the binary: absent until asked for, and with the pinned files at hand, installed (its wasm
// embedded in the binary, its load checked against the pinned canaries) and finding the PDF's sentence by meaning.
async function meaning(run: (args: string[]) => SpawnSyncReturns<string>) {
  const json = async (args: string[]) => {
    const result = run([...args, "--json"])
    const stdout = result.stdout ?? ""
    return {
      status: result.status,
      value: await Promise.resolve()
        .then(
          () => JSON.parse(stdout.slice(Math.max(0, stdout.search(/^[[{]/m)))) as Record<string, unknown> & unknown[],
        )
        .catch(() => undefined),
      output: `${stdout}${result.stderr ?? ""}`.slice(-4_000),
    }
  }
  const absent = await json(["memory", "model", "status"])
  if (absent.value?.state !== "absent" || !Array.isArray(absent.value.options))
    return [`vector memory model status did not say the model is absent: ${absent.output}`]
  const from = process.env.VECTOR_TEST_EMBED_DIR
  if (!from) return []
  const installed = await json(["memory", "model", "install", "--from", from])
  const check = installed.value?.check as { by?: string; lowest?: number } | undefined
  if (installed.value?.state !== "ready" || check?.by !== "vectors" || (check.lowest ?? 0) < 0.995)
    return [`vector memory model install did not leave a checked model: ${installed.output}`]
  const added = await json(["memory", "doc", "add", "spec.pdf", "--wait=all"])
  const document = (added.value?.[0] as { document?: { status?: string; stats?: { embedded?: number } } } | undefined)
    ?.document
  if (document?.status !== "ready" || !document.stats?.embedded)
    return [`the PDF was not embedded by meaning: ${added.output}`]
  const found = await json(["memory", "doc", "search", "how", "long", "do", "sessions", "last", "--why"])
  const cards = Array.isArray(found.value) ? (found.value as { text: string }[]) : []
  return cards.some((card) => card.text.includes("Refresh tokens expire after 14 days"))
    ? []
    : [`a search by meaning did not find the refresh token sentence: ${found.output}`]
}

// A binary for this machine, built as build.ts builds one, minus what the smoke does not need.
async function compile(out: string) {
  const started = Date.now()
  const local = path.join(dir, "node_modules/@opentui/core/parser.worker.js")
  const parserWorker = await realpath(local).catch(() =>
    realpath(path.join(dir, "../../node_modules/@opentui/core/parser.worker.js")),
  )
  const workerPath = "./src/cli/tui/worker.ts"
  const system = process.platform === "win32" ? "windows" : process.platform
  const outfile = path.join(out, process.platform === "win32" ? "vector.exe" : "vector")
  const bunfsRoot = process.platform === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const result = await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [createSolidTransformPlugin(), isolation],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: `bun-${system}-${process.arch}` as Bun.Build.CompileTarget,
      outfile,
    },
    files: {
      "brain-worker.gen.ts": `export default ${JSON.stringify(await bundleBrainWorker(SMOKE, isolation))}`,
    },
    entrypoints: ["./src/index.ts", parserWorker, workerPath, "brain-worker.gen.ts"],
    define: {
      FFF_LIBC: JSON.stringify("gnu"),
      VECTOR_VERSION: JSON.stringify(SMOKE.version),
      VECTOR_CLI_STANDALONE: "true",
      VECTOR_PLUGIN_VERSION: JSON.stringify("0.0.0-brain-worker-smoke"),
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + path.relative(dir, parserWorker).replaceAll("\\", "/"),
      VECTOR_WORKER_PATH: workerPath,
      VECTOR_CHANNEL: JSON.stringify(SMOKE.channel),
      VECTOR_LIBC: process.platform === "linux" ? `'glibc'` : "",
    },
  })
  if (!result.success) throw new AggregateError(result.logs, "The smoke binary failed to build")
  console.log(`compiled a smoke binary in ${Math.round((Date.now() - started) / 1000)}s`)
  return outfile
}
