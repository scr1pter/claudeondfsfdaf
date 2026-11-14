#!/usr/bin/env node
// Smoke test for the engine bundle the desktop app ships.
//
// The desktop app runs dist/node/node.js inside Electron's utility process, which is plain Node: there is no `Bun`
// global there. The CLI and the engine tests run on Bun, so a bare `Bun.*` call passes all of them and still fails
// every desktop message with "ReferenceError: Bun is not defined". This script boots the bundle the way
// packages/desktop/src/main/sidecar.ts does, points a provider at a fake OpenAI-compatible model that calls the Read
// tool on a file in a temporary project, sends one prompt over the HTTP API the app uses, and fails unless the turn
// finishes cleanly. It runs the turn twice: once through a bundled provider SDK, and once through an SDK the engine
// installs into its package cache, which Node must import from the package's real entry file rather than its
// directory. A third turn has the model keep a generated PDF as a document through the memory tool, which reads it in
// the brain's background reader: an eval worker started from the source the bundle carries, so the turn fails if the
// worker cannot start under Node and reading falls back to the main thread. Then it checks that ONNX Runtime's wasm for
// the search model ships beside the bundle and that /memory/model answers; given VECTOR_TEST_EMBED_DIR (a folder of the
// pinned arctic-embed-xs files) it installs the model over HTTP and waits until the eval worker has embedded the PDF,
// checked against the pinned canary vectors. It also reads this computer's local-model recommendation, whose
// hardware probe must work without Bun. It uses node: APIs only and must run under node, never bun:
//
//   bun script/build-node.ts && node script/smoke-node-bundle.ts [path/to/node.js]

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { connectedReviews } from "./smoke-connect-node.ts"

const PROVIDER = "smoke"
const MODEL = "smoke-model"
// Not in BUNDLED_PROVIDERS, so the engine loads it through Npm.add from the package cache.
const NPM_PROVIDER = "smoke-npm"
const NPM_PACKAGE = "smoke-ai-provider"
const REPLY = "The notes file holds the smoke marker."
const KEEP = "Keep spec.pdf from this repository as a document for the next tasks."
const KEPT = "The spec is kept."
const WORKER_STARTED = "brain reader started in a worker thread"
const WORKER_FALLBACK = "brain reader runs on the main thread"
const START_TIMEOUT = 60_000
const TURN_TIMEOUT = 120_000
const BUN_MISSING = /Bun is not defined/

if (typeof Bun !== "undefined" || process.versions.bun) {
  console.error("smoke-node-bundle must run under node: Bun defines the APIs this test exists to catch.")
  process.exit(1)
}

const script = fileURLToPath(import.meta.url)
await (process.argv[2] === "--serve"
  ? serve(process.argv[3])
  : process.argv[2] === "--connect-only"
    ? smokeConnect(path.resolve(process.argv[3] ?? path.join(path.dirname(script), "..", "dist", "node", "node.js")))
    : smoke(path.resolve(process.argv[2] ?? path.join(path.dirname(script), "..", "dist", "node", "node.js"))))

async function smokeConnect(bundle: string) {
  const root = await mkdtemp(path.join(tmpdir(), "vector-connect-node-smoke-"))
  const project = path.join(root, "project")
  await mkdir(project, { recursive: true })
  const model = await startFakeModel(path.join(project, "notes.txt"))
  try {
    const engine = await startEngine(bundle, root, model.url)
    try {
      await connectedReviews(engine, project)
      if (model.requests.length !== 0) throw new Error("a refused or cancelled non-Git review reached the model")
      console.log(
        `connect owner transport smoke passed on node ${process.version}: explicit approval, concurrent-start refusal, peer-disconnect cancellation and durable settlement`,
      )
    } catch (error) {
      console.error(
        `connect owner transport smoke FAILED on node ${process.version}: ${String(error)}\n${engine.output.join("").slice(-8_000)}`,
      )
      process.exitCode = 1
    } finally {
      await engine.stop()
    }
  } finally {
    model.close()
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function smoke(bundle: string) {
  const root = await mkdtemp(path.join(tmpdir(), "vector-node-smoke-"))
  const project = path.join(root, "project")
  const notes = path.join(project, "notes.txt")
  const marker = `smoke-marker-${randomBytes(6).toString("hex")}`
  await mkdir(project, { recursive: true })
  await writeFile(notes, `${marker}\n`)
  await writeFile(path.join(project, "spec.pdf"), specPdf())
  const model = await startFakeModel(notes)
  try {
    const engine = await startEngine(bundle, root, model.url)
    const turn = await runTurn(engine, project, marker, PROVIDER)
      .then(async (failures) => [
        ...failures,
        ...(await runTurn(engine, project, marker, NPM_PROVIDER)).map((failure) => `${NPM_PACKAGE}: ${failure}`),
        ...(await runTurn(engine, project, marker, PROVIDER, KEEP)).map((failure) => `document: ${failure}`),
        ...(await searchModel(engine, project, bundle)).map((failure) => `search model: ${failure}`),
        ...(await localRecommendation(engine, project)).map((failure) => `local recommendation: ${failure}`),
        ...(await connectedReviews(engine, project)).map((failure) => `connected review: ${failure}`),
      ])
      .catch((error) => [`the turn could not run: ${String(error)}`])
      .finally(engine.stop)
    const logs = engine.output.join("")
    const failures = [
      ...turn,
      ...modelFailures(model.requests, marker),
      ...(BUN_MISSING.test(logs) ? ["engine output or logs mention 'Bun is not defined'"] : []),
      ...(logs.includes(WORKER_STARTED) ? [] : ["the brain's background reader never started in a worker thread"]),
      ...(logs.includes(WORKER_FALLBACK) ? ["the brain's background reader fell back to the main thread"] : []),
    ]
    if (failures.length === 0) {
      console.log(
        `node bundle smoke passed on node ${process.version}: Read tool completed and the model replied, with a bundled and a cached provider SDK, and a PDF was kept as a document through the brain's eval worker${process.env.VECTOR_TEST_EMBED_DIR ? ", then embedded by the search model there" : ", and the search model's wasm ships beside the bundle"}`,
      )
      return
    }
    console.error(`node bundle smoke FAILED on node ${process.version} (${bundle}):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error(`\nengine output and logs (tail):\n${logs.slice(-8_000)}`)
    process.exitCode = 1
  } finally {
    model.close()
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

// Mirrors the desktop sidecar: environment prepared before the bundle is imported, then Server.listen with the
// sidecar's credentials and CORS. Runs in a child process so a crash or stray stderr write is observable.
async function serve(bundle: string | undefined) {
  if (!bundle) throw new Error("--serve needs the bundle path")
  // build-node.ts leaves @lydell/node-pty external and the desktop package supplies it at runtime, so a bare package
  // the bundle cannot resolve from its own location resolves from packages/desktop, as it does in the packaged app.
  const desktop = pathToFileURL(path.join(path.dirname(script), "..", "..", "desktop", "package.json")).href
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context)
      } catch (error) {
        if (!isRecord(error) || error.code !== "ERR_MODULE_NOT_FOUND") throw error
        return next(specifier, { ...context, parentURL: desktop })
      }
    },
  })
  const engine: { Server: { listen(options: ListenOptions): Promise<{ url: URL }> } } = await import(
    pathToFileURL(bundle).href
  )
  const listener = await engine.Server.listen({
    port: 0,
    hostname: "127.0.0.1",
    username: "vector",
    password: process.env.VECTOR_SERVER_PASSWORD ?? "",
    cors: ["oc://renderer"],
  })
  process.stdout.write(`smoke:listening ${listener.url.href}\n`)
}

type ListenOptions = { port: number; hostname: string; username: string; password: string; cors: string[] }

async function startEngine(bundle: string, root: string, modelUrl: string) {
  const home = path.join(root, "home")
  const userData = path.join(root, "user-data")
  const configDir = path.join(userData, "config", "vector")
  const password = randomBytes(16).toString("hex")
  await mkdir(home, { recursive: true })
  await mkdir(configDir, { recursive: true })
  // The desktop reads the user's global config from VECTOR_AGENT_CONFIG_DIR, so the provider goes there too.
  await writeFile(path.join(configDir, "vector.json"), JSON.stringify(providerConfig(modelUrl), null, 2))
  await seedCachedProvider(path.join(userData, "xdg-cache", "vector", "packages", NPM_PACKAGE))
  // execArgv carries --experimental-strip-types, which Node before 22.18 needs to run this script in the child too.
  const child = spawn(process.execPath, [...process.execArgv, script, "--serve", bundle], {
    cwd: root,
    env: sidecarEnv({ home, userData, configDir, password }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output: string[] = []
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")))
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`engine did not listen within ${START_TIMEOUT}ms:\n${output.join("")}`))
    }, START_TIMEOUT)
    child.stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("utf8"))
      const match = output.join("").match(/smoke:listening (\S+)/)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    })
    void exited.then((code) => {
      clearTimeout(timer)
      reject(new Error(`engine exited with code ${code} before listening:\n${output.join("")}`))
    })
  })
  return {
    url: new URL(url),
    authorization: `Basic ${Buffer.from(`vector:${password}`).toString("base64")}`,
    output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill("SIGTERM")
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
      await exited
      clearTimeout(timer)
    },
  }
}

// The sidecar inherits Electron's environment plus preferAppEnv (server.ts), VECTOR_AGENT_RUNTIME_ENV
// (agent-runtime.ts) and prepareSidecarEnv (sidecar.ts). HOME and the XDG roots are pinned to the temp dir here so the
// run never touches the machine's real Vector data.
function sidecarEnv(input: { home: string; userData: string; configDir: string; password: string }) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "DEBUG" && !entry[0].startsWith("VECTOR_"),
    ),
  )
  return {
    ...inherited,
    HOME: input.home,
    USERPROFILE: input.home,
    VECTOR_TEST_HOME: input.home,
    VECTOR_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
    VECTOR_EXPERIMENTAL_CONNECT: "true",
    VECTOR_EXPERIMENTAL_LSP_TOOL: "true",
    VECTOR_EXPERIMENTAL_ICON_DISCOVERY: "true",
    VECTOR_EXPERIMENTAL_FILEWATCHER: "true",
    VECTOR_CLIENT: "desktop",
    VECTOR_DISABLE_CHANNEL_DB: "1",
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: input.password,
    VECTOR_AGENT_CONFIG_DIR: input.configDir,
    VECTOR_APP_NAMESPACE: "vector",
    // The release catalog is embedded in the bundle; skip the network refresh so the run stays hermetic.
    VECTOR_DISABLE_MODELS_FETCH: "1",
    // Mirror the engine log to stderr: the file logger batches writes and loses its tail when the child is stopped.
    VECTOR_PRINT_LOGS: "1",
    XDG_DATA_HOME: path.join(input.userData, "xdg-data"),
    XDG_CONFIG_HOME: path.join(input.userData, "xdg-config"),
    XDG_CACHE_HOME: path.join(input.userData, "xdg-cache"),
    XDG_STATE_HOME: path.join(input.userData, "xdg-state"),
  }
}

// An installed package as Npm.add leaves it, ESM-only with just an `import` export condition. It wraps the repo's
// openai-compatible SDK so the turn reaches the same fake model.
async function seedCachedProvider(dir: string) {
  const pkg = path.join(dir, "node_modules", NPM_PACKAGE)
  await mkdir(path.join(pkg, "dist"), { recursive: true })
  await writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: NPM_PACKAGE,
      version: "1.0.0",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  )
  await writeFile(
    path.join(pkg, "dist", "index.js"),
    `export { createOpenAICompatible as createSmoke } from ${JSON.stringify(import.meta.resolve("@ai-sdk/openai-compatible"))}\n`,
  )
}

function providerConfig(baseURL: string) {
  const provider = (name: string, npm: string) => ({
    name,
    npm,
    models: {
      [MODEL]: {
        id: MODEL,
        name: "Smoke Model",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        release_date: "2025-01-01",
        limit: { context: 100_000, output: 10_000 },
        cost: { input: 0, output: 0 },
      },
    },
    options: { apiKey: "smoke-key", baseURL },
  })
  return {
    $schema: "https://vectordev.ai/config.json",
    model: `${PROVIDER}/${MODEL}`,
    small_model: `${PROVIDER}/${MODEL}`,
    formatter: false,
    lsp: false,
    permission: { connect: "ask" },
    provider: {
      [PROVIDER]: provider("Smoke", "@ai-sdk/openai-compatible"),
      [NPM_PROVIDER]: provider("Smoke npm", NPM_PACKAGE),
    },
  }
}

// Sends the prompt the way the app does (prompt_async, then the instance event stream) and reports what went wrong.
async function runTurn(
  engine: { url: URL; authorization: string },
  project: string,
  marker: string,
  providerID: string,
  text = "Read notes.txt and tell me what it says.",
) {
  const request = (route: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }) =>
    fetch(new URL(route, engine.url), {
      method: init?.method ?? "GET",
      headers: {
        authorization: engine.authorization,
        "content-type": "application/json",
        "x-vector-directory": encodeURIComponent(project),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init?.signal,
    })
  const json = async (route: string, init?: { method?: string; body?: unknown }) => {
    const response = await request(route, init)
    const text = await response.text()
    if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${route} returned ${response.status}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }

  const health = await request("/global/health")
  if (!health.ok) return [`GET /global/health returned ${health.status}`]
  const session = await json("/session", { method: "POST", body: { title: "node bundle smoke" } })
  const sessionID: string = session.id
  const abort = new AbortController()
  const events = await request("/event", { signal: abort.signal })
  if (!events.ok || !events.body) return [`GET /event returned ${events.status}`]
  const turn = watchTurn(events.body, sessionID)
  await json(`/session/${sessionID}/prompt_async`, {
    method: "POST",
    body: {
      agent: "build",
      model: { providerID, modelID: MODEL },
      ...(text === KEEP ? { size: "light" } : {}),
      parts: [{ type: "text", text }],
    },
  })
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT)
  const outcome = await turn.finally(() => {
    clearTimeout(timer)
    abort.abort()
  })
  const messages: Message[] = await json(`/session/${sessionID}/message`)
  return [...outcome, ...(text === KEEP ? keptFailures(messages) : messageFailures(messages, marker))]
}

// The desktop's local-model setup reads hardware through this route; Bun-only probes otherwise pass unit tests.
async function localRecommendation(engine: { url: URL; authorization: string }, project: string) {
  const response = await fetch(new URL("/local/recommend", engine.url), {
    headers: {
      authorization: engine.authorization,
      "x-vector-directory": encodeURIComponent(project),
    },
    signal: AbortSignal.timeout(15_000),
  })
  const body: unknown = await response.json()
  if (
    response.ok &&
    isRecord(body) &&
    isRecord(body.hardware) &&
    typeof body.hardware.total === "number" &&
    body.hardware.total > 0 &&
    typeof body.hardware.usable === "number" &&
    body.hardware.usable > 0 &&
    typeof body.hardware.summary === "string" &&
    body.hardware.summary.length > 0
  )
    return []
  return [`GET /local/recommend answered ${response.status}: ${JSON.stringify(body)}`]
}

// The search model on the bundle: its wasm beside it, /memory/model answering, and with the pinned files at hand, the
// model installed over HTTP, checked against its canaries and embedding the kept PDF in the eval worker.
async function searchModel(engine: { url: URL; authorization: string }, project: string, bundle: string) {
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(new URL(route, engine.url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: engine.authorization,
        "content-type": "application/json",
        "x-vector-directory": encodeURIComponent(project),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json().catch(() => undefined)) as ModelStatus | undefined }
  }
  const wasm = (await readdir(path.dirname(bundle))).filter((file) => /^ort-wasm-simd-threaded.*\.wasm$/.test(file))
  const first = await request("/memory/model")
  const failures = [
    ...(wasm.length === 1 ? [] : [`expected ONNX Runtime's wasm beside the bundle, found ${JSON.stringify(wasm)}`]),
    ...(first.status === 200 && first.body?.state === "absent" && first.body.options?.length === 2
      ? []
      : [`GET /memory/model answered ${first.status}: ${JSON.stringify(first.body)}`]),
  ]
  const from = process.env.VECTOR_TEST_EMBED_DIR
  if (!from || failures.length > 0) return failures
  const installed = await request("/memory/model", { action: "install", from })
  if (
    installed.body?.state !== "ready" ||
    installed.body.check?.by !== "vectors" ||
    installed.body.check.lowest < 0.995
  )
    return [`installing from ${from} answered ${installed.status}: ${JSON.stringify(installed.body)}`]
  const deadline = Date.now() + TURN_TIMEOUT
  for (;;) {
    const status = (await request("/memory/model")).body
    const embedded = status?.embedded
    if (embedded && embedded.total > 0 && embedded.done === embedded.total) return []
    if (Date.now() > deadline) return [`the kept PDF was not embedded in time: ${JSON.stringify(status)}`]
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

type ModelStatus = {
  state: string
  options?: unknown[]
  check?: { by: string; lowest: number }
  embedded?: { done: number; total: number }
}

// The memory tool kept the PDF: read, structured and searchable, with the records its two sentences give.
function keptFailures(messages: Message[]) {
  const parts = messages.filter((message) => message.info.role === "assistant").flatMap((message) => message.parts)
  const kept = parts.find((part) => part.type === "tool" && part.tool === "memory")
  if (!kept) return ["the memory tool never ran"]
  if (kept.state?.status !== "completed") return [`memory tool ended ${kept.state?.status}: ${kept.state?.error ?? ""}`]
  const output = kept.state.output ?? ""
  return output.includes("searchable now") && /\b[1-9]\d* records\b/.test(output)
    ? []
    : [`the PDF was not kept as a searchable document: ${JSON.stringify(output)}`]
}

// A one-page PDF with a title and two sentences of spec, written here so no binary fixture is committed.
function specPdf() {
  const lines = [
    { text: "Auth spec", size: 20, font: "F2", y: 740 },
    { text: "1 Sessions", size: 14, font: "F2", y: 700 },
    { text: "Refresh tokens expire after 14 days.", size: 11, font: "F1", y: 680 },
    { text: "Clients MUST retry at most 3 times after a 429 response.", size: 11, font: "F1", y: 664 },
  ]
  const content = lines
    .map((line) => `BT /${line.font} ${line.size} Tf 72 ${line.y} Td (${line.text}) Tj ET`)
    .join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ]
  const body = objects.reduce(
    (out, object, index) => ({
      text: `${out.text}${index + 1} 0 obj\n${object}\nendobj\n`,
      offsets: [...out.offsets, out.text.length],
    }),
    { text: "%PDF-1.4\n", offsets: [] as number[] },
  )
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...body.offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    `${body.text.length}`,
    "%%EOF",
  ].join("\n")
  return `${body.text}${xref}\n`
}

type Part = {
  type: string
  text?: string
  tool?: string
  state?: { status?: string; output?: string; error?: string }
}
type Message = { info: { role: string; error?: unknown }; parts: Part[] }
type Event = { type?: string; properties?: Record<string, unknown> }

// Resolves once the session goes idle, with every session error the engine published on the way.
async function watchTurn(body: ReadableStream<Uint8Array>, sessionID: string) {
  const failures: string[] = []
  const decoder = new TextDecoder()
  let buffer = ""
  let idle = false
  // A reader rather than for await: the engine's DOM lib types give ReadableStream no async iterator.
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const blocks = buffer.split("\n\n")
      buffer = blocks.pop() ?? ""
      const events = blocks.flatMap((block) =>
        block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line): Event => JSON.parse(line.slice(5))),
      )
      for (const event of events) {
        if (event.properties?.sessionID !== sessionID) continue
        if (event.type === "session.error") failures.push(`session.error: ${JSON.stringify(event.properties.error)}`)
        if (event.type === "permission.asked")
          failures.push(`unexpected permission request: ${JSON.stringify(event.properties)}`)
        const status = event.properties.status
        if (event.type === "session.status" && isRecord(status) && status.type === "idle") idle = true
      }
      if (idle) break
    }
  } catch (error) {
    if (!idle) failures.push(`event stream ended before the session went idle: ${String(error)}`)
  }
  if (!idle && failures.length === 0) failures.push("event stream closed before the session went idle")
  return failures
}

function messageFailures(messages: Message[], marker: string) {
  const assistant = messages.filter((message) => message.info.role === "assistant")
  const parts = assistant.flatMap((message) => message.parts)
  const read = parts.find((part) => part.type === "tool" && part.tool === "read")
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
  return [
    ...assistant.flatMap((message) =>
      message.info.error ? [`assistant message error: ${JSON.stringify(message.info.error)}`] : [],
    ),
    ...(assistant.length === 0 ? ["no assistant message was recorded"] : []),
    ...(read ? [] : ["the Read tool never ran"]),
    ...(read && read.state?.status !== "completed"
      ? [`Read tool ended ${read.state?.status}: ${read.state?.error ?? JSON.stringify(read.state)}`]
      : []),
    ...(read?.state?.status === "completed" && !read.state.output?.includes(marker)
      ? ["Read tool output does not contain the file contents"]
      : []),
    ...(text.includes(REPLY) ? [] : [`final reply missing; assistant text was ${JSON.stringify(text)}`]),
  ]
}

function modelFailures(requests: ChatRequest[], marker: string) {
  const followUp = requests.find((body) => body.messages?.some((message) => message.role === "tool"))
  if (requests.length === 0) return ["the engine never called the model"]
  if (!followUp) return ["the engine never sent the Read result back to the model"]
  if (!JSON.stringify(followUp.messages).includes(marker)) return ["the Read result sent to the model lacks the file"]
  return []
}

type ChatRequest = {
  stream?: boolean
  messages?: { role?: string; content?: unknown }[]
  tools?: { function?: { name?: string } }[]
}

// A minimal OpenAI-compatible chat endpoint. The answer depends on the request rather than a queue, so side requests
// such as title generation cannot steal the scripted turn: with the Read tool on offer and no tool result yet it calls
// Read, otherwise it answers in text.
async function startFakeModel(notes: string) {
  const requests: ChatRequest[] = []
  const server = createServer((req, res) => {
    void handleModelRequest(req, res, notes, requests)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fake model has no TCP address")
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

async function handleModelRequest(req: IncomingMessage, res: ServerResponse, notes: string, requests: ChatRequest[]) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: `fake model does not serve ${req.method} ${req.url}` } }))
    return
  }
  const body: ChatRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  requests.push(body)
  // The document turn asks to keep the PDF: the model calls the memory tool once, then answers.
  const keeping = JSON.stringify(body.messages ?? []).includes(KEEP)
  const tool = keeping ? "memory" : "read"
  const call =
    body.tools?.some((item) => item.function?.name === tool) &&
    !body.messages?.some((message) => message.role === "tool")
  const reply = keeping ? KEPT : REPLY
  const args = JSON.stringify(keeping ? { action: "add", file: "spec.pdf" } : { filePath: notes })
  const finish = call ? "tool_calls" : "stop"
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  if (body.stream !== true) {
    const message = call
      ? {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `call_smoke_${tool}`, type: "function", function: { name: tool, arguments: args } }],
        }
      : { role: "assistant", content: reply }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: "chatcmpl-smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      }),
    )
    return
  }
  const chunk = (choice: Record<string, unknown>, usage?: Record<string, number>) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, ...choice }],
      ...(usage ? { usage } : {}),
    })}\n\n`
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const deltas = call
    ? [
        {
          tool_calls: [
            { index: 0, id: `call_smoke_${tool}`, type: "function", function: { name: tool, arguments: "" } },
          ],
        },
        { tool_calls: [{ index: 0, function: { arguments: args } }] },
      ]
    : [{ content: reply }]
  res.write(chunk({ delta: { role: "assistant" } }))
  for (const delta of deltas) res.write(chunk({ delta }))
  res.write(chunk({ delta: {}, finish_reason: finish }, usage))
  res.end("data: [DONE]\n\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
