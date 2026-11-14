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
// hardware probe must work without Bun. A fourth turn takes a generated screenshot through a loopback fake computer
// bridge, approves the real app/sensitive asks over HTTP, clicks its fixture control and receives the changed image.
// This tests the packaged engine loop and image handling, not native desktop behavior. It uses node: APIs only and
// must run under node, never bun:
//
//   bun script/build-node.ts && node script/smoke-node-bundle.ts [path/to/node.js]

import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { connectedReviews } from "./smoke-connect-node.ts"
import { deflateSync } from "node:zlib"
import type { Computer } from "@vectordevai/schema/computer"

type ComputerBridgeResponse<C extends Computer.BridgeCommandName> =
  (typeof Computer.BridgeCommands)[C]["response"]["Type"]

const PROVIDER = "smoke"
const MODEL = "smoke-model"
// Not in BUNDLED_PROVIDERS, so the engine loads it through Npm.add from the package cache.
const NPM_PROVIDER = "smoke-npm"
const NPM_PACKAGE = "smoke-ai-provider"
const REPLY = "The notes file holds the smoke marker."
const KEEP = "Keep spec.pdf from this repository as a document for the next tasks."
const KEPT = "The spec is kept."
const COMPUTER =
  "Use the isolated Smoke Notes computer fixture: take a screenshot, then click its Send button at 32,24."
const COMPUTER_REPLY = "The isolated computer fixture was inspected and its Send button was clicked."
const COMPUTER_APP = {
  platform: "macos",
  bundleId: "com.example.VectorNodeSmoke",
  teamId: "SMOKE12345",
  apple: false,
  system: false,
  verified: true,
  name: "Smoke Notes",
  path: "/Applications/VectorNodeSmoke.app",
  pid: 501,
} as const
const COMPUTER_KEY = "app:macos:com.example.vectornodesmoke"
const COMPUTER_CLICK_DIGEST = createHash("sha256")
  .update('{"at":{"x":32,"y":24},"button":"left","count":1,"kind":"click","modifiers":[]}')
  .digest("hex")
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
  const computer = await startComputerBridge(project).catch((error) => {
    model.close()
    throw error
  })
  try {
    const engine = await startEngine(bundle, root, model.url, computer)
    const turn = await runTurn(engine, project, marker, PROVIDER)
      .then(async (failures) => [
        ...failures,
        ...(await runTurn(engine, project, marker, NPM_PROVIDER)).map((failure) => `${NPM_PACKAGE}: ${failure}`),
        ...(await runTurn(engine, project, marker, PROVIDER, KEEP)).map((failure) => `document: ${failure}`),
        ...(await runComputerTurn(engine, project, computer, model.requests)).map((failure) => `computer: ${failure}`),
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
        `node bundle smoke passed on node ${process.version}: Read tool completed with bundled and cached provider SDKs; a PDF was kept through the brain's eval worker${process.env.VECTOR_TEST_EMBED_DIR ? " and embedded there" : "; the search model's wasm ships beside the bundle"}; computer screenshot/click, HTTP app/sensitive approval, image attachments and lease cleanup passed against an isolated fake bridge`,
      )
      return
    }
    console.error(`node bundle smoke FAILED on node ${process.version} (${bundle}):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error(`\nengine output and logs (tail):\n${logs.slice(-8_000)}`)
    process.exitCode = 1
  } finally {
    model.close()
    await computer.close()
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

async function startEngine(bundle: string, root: string, modelUrl: string, computer?: { url: string; token: string }) {
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
    env: {
      ...sidecarEnv({ home, userData, configDir, password }),
      ...(computer ? { VECTOR_COMPUTER_BRIDGE_URL: computer.url, VECTOR_COMPUTER_BRIDGE_TOKEN: computer.token } : {}),
    },
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
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
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
    permission: {
      connect: "ask",
      computer_observe: "allow",
      computer_interact: "allow",
      computer_app: "ask",
      computer_sensitive: "ask",
    },
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

function requireComputer(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`computer-smoke: ${detail}`)
}

/** Two generated PNGs, never captured pixels. The real Node image decoder must accept their complete bytes. */
function computerImage(clicked: boolean) {
  const chunk = (type: string, bytes: Buffer) => {
    const contents = Buffer.concat([Buffer.from(type), bytes])
    const crc = { value: 0xffffffff }
    for (const byte of contents) {
      crc.value ^= byte
      for (let bit = 0; bit < 8; bit++) crc.value = (crc.value >>> 1) ^ (crc.value & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    checksum.writeUInt32BE((crc.value ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, contents, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64, 0)
  header.writeUInt32BE(48, 4)
  header[8] = 8
  header[9] = 6
  const pixels = Buffer.alloc(48 * (64 * 4 + 1))
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 64; x++) {
      const offset = y * (64 * 4 + 1) + 1 + x * 4
      pixels.set(clicked ? [32, 180, 90, 255] : [36, 86, 170, 255], offset)
    }
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64")}`
}

/** A dedicated authenticated fixture bridge in this Node process. It has no native helper or OS access. */
async function startComputerBridge(project: string) {
  const directory = await realpath(project)
  const token = randomBytes(24).toString("hex")
  const calls: Record<string, unknown>[] = []
  const approvals = new Map<string, { request: Record<string, unknown>; accepted: Promise<boolean> }>()
  const consumed = new Set<string>()
  const images = { before: computerImage(false), after: computerImage(true) }
  const state: {
    sessionID?: string
    holder?: string
    level?: "observe" | "interact"
    clicked: number
    frames: number
    frame?: string
    released: boolean
    capabilities: number
    failures: string[]
  } = {
    clicked: 0,
    frames: 0,
    released: false,
    capabilities: 0,
    failures: [],
  }
  const desktopState = (): Computer.ComputerState => ({
    phase: state.released ? "ready" : "working",
    backend: "local-macos",
    mode: "foreground",
    apps: state.level ? [{ key: COMPUTER_KEY, name: COMPUTER_APP.name }] : [],
    queue: [],
    escStops: !state.released,
    stopChord: "Command+Shift+Escape",
    lease: 1,
    reduceMotion: false,
  })
  const inspect = (): Computer.InspectResult => ({
    app: COMPUTER_APP,
    category: "office",
    pid: COMPUTER_APP.pid,
    window: { id: "smoke-window", title: "Isolated smoke message" },
    element: {
      role: "AXButton",
      label: "Send",
      ref: "ui_1",
      elementId: "smoke-send-element",
      secure: false,
      enabled: true,
      editable: false,
    },
    documentStatus: "none",
    clipboard: { agentOwned: true },
  })
  const appQuery = (value: unknown) =>
    isRecord(value) && (value.key === COMPUTER_KEY || value.name === COMPUTER_APP.name)
  const answer = async (body: Record<string, unknown>) => {
    requireComputer(
      body.v === 1 &&
        typeof body.sessionID === "string" &&
        body.sessionID === body.rootSessionID &&
        typeof body.directory === "string",
      "request envelope does not bind the fixture session and directory",
    )
    requireComputer((await realpath(body.directory)) === directory, "request belongs to another fixture directory")
    const command = body.command
    if (command === "acquire") {
      requireComputer(!state.holder && !state.released, "unexpected second acquire")
      state.sessionID = body.sessionID
      state.holder = body.sessionID
      return { lease: 1 } satisfies ComputerBridgeResponse<"acquire">
    }
    requireComputer(body.sessionID === state.sessionID, "request belongs to another fixture lease")
    requireComputer(
      command === "cancel" || command === "status" || body.lease === 1,
      "request has the wrong fixture lease",
    )
    if (command === "cancel") return { ok: true } satisfies ComputerBridgeResponse<"cancel">
    if (command === "release") {
      state.holder = undefined
      state.level = undefined
      state.released = true
      return { ok: true } satisfies ComputerBridgeResponse<"release">
    }
    if (command === "heartbeat") return { state: desktopState() } satisfies ComputerBridgeResponse<"heartbeat">
    if (command === "status")
      return {
        platform: "macos",
        backendVersion: "node-smoke-fixture",
        permissions: { screen: "granted", accessibility: "granted" },
        displays: [{ id: "1", name: "Fixture display", bounds: { x: 0, y: 0, w: 64, h: 48 }, scale: 1, primary: true }],
        mode: "foreground",
      } satisfies ComputerBridgeResponse<"status">
    if (command === "access") {
      requireComputer(appQuery(body.app), "access did not name the fixture app")
      return (
        state.level
          ? { identity: COMPUTER_APP, category: "office", verdict: "granted", level: state.level, via: "task" }
          : {
              identity: COMPUTER_APP,
              category: "office",
              verdict: "ask",
              canAlways: false,
              companyAllowed: false,
              changed: false,
            }
      ) satisfies ComputerBridgeResponse<"access">
    }
    if (command === "grant") {
      const identity = body.identity
      requireComputer(
        typeof body.requestID === "string" &&
          (body.level === "observe" || body.level === "interact") &&
          isRecord(identity) &&
          Object.entries(COMPUTER_APP).every(([key, value]) => identity[key] === value),
        "grant changed the observed fixture identity",
      )
      const approval = approvals.get(body.requestID)
      requireComputer(
        approval && (await approval.accepted) && !consumed.has(body.requestID),
        "grant lacks its actual HTTP approval",
      )
      const metadata = approval.request.metadata
      requireComputer(
        approval.request.permission === "computer_app" &&
          isRecord(metadata) &&
          metadata.level === body.level &&
          isRecord(metadata.target) &&
          metadata.target.appKey === COMPUTER_KEY,
        "app approval changed target or level",
      )
      consumed.add(body.requestID)
      state.level = body.level
      return { ok: true } satisfies ComputerBridgeResponse<"grant">
    }
    requireComputer(state.level !== undefined && !state.released, "observation preceded the app approval")
    if (command === "inspect") {
      requireComputer(
        body.frame === undefined || body.frame === state.frame,
        "inspection used an expired fixture frame",
      )
      return inspect()
    }
    if (command === "screenshot") {
      requireComputer(
        isRecord(body.scope) &&
          appQuery(body.scope.app) &&
          isRecord(body.budget) &&
          Number(body.budget.maxWidth) >= 64 &&
          Number(body.budget.maxHeight) >= 48 &&
          Number(body.budget.maxPixels) >= 64 * 48,
        "capture did not preserve the app scope and budget",
      )
      const image = state.clicked ? images.after : images.before
      state.frame = `smoke-frame-${++state.frames}`
      return {
        frame: {
          id: state.frame,
          scope: "window",
          windowId: "smoke-window",
          display: "1",
          bounds: { x: 0, y: 0, w: 64, h: 48 },
          scale: 1,
          image: { w: 64, h: 48 },
          at: Date.now(),
          hash: createHash("sha256").update(image).digest("hex").slice(0, 16),
        },
        image,
        visible: [COMPUTER_APP],
        hiddenCount: 0,
        pointer: { x: 32, y: 24 },
      } satisfies ComputerBridgeResponse<"screenshot">
    }
    if (command === "act") {
      requireComputer(
        state.level === "interact" &&
          state.clicked === 0 &&
          body.frame === state.frame &&
          Array.isArray(body.steps) &&
          body.steps.length === 1 &&
          Array.isArray(body.allowedApps) &&
          body.allowedApps.includes(COMPUTER_KEY),
        "click has no exact approved live frame",
      )
      const step = body.steps[0]
      requireComputer(
        isRecord(step) &&
          step.kind === "click" &&
          step.button === "left" &&
          step.count === 1 &&
          Array.isArray(step.modifiers) &&
          step.modifiers.length === 0 &&
          isRecord(step.at) &&
          step.at.x === 32 &&
          step.at.y === 24,
        "click changed the fixture action",
      )
      requireComputer(
        Array.isArray(body.approvals) &&
          body.approvals.length === 1 &&
          isRecord(body.approvals[0]) &&
          body.approvals[0].index === 0 &&
          typeof body.approvals[0].requestID === "string",
        "click has no exact sensitive proof",
      )
      const id = body.approvals[0].requestID
      const approval = approvals.get(id)
      requireComputer(
        approval && (await approval.accepted) && !consumed.has(id),
        "sensitive proof was unapproved or reused",
      )
      const metadata = approval.request.metadata
      requireComputer(
        approval.request.permission === "computer_sensitive" &&
          isRecord(metadata) &&
          metadata.why === "send" &&
          metadata.action === "click" &&
          metadata.stepDigest === COMPUTER_CLICK_DIGEST &&
          metadata.frame === state.frame &&
          isRecord(metadata.target) &&
          metadata.target.appKey === COMPUTER_KEY &&
          metadata.target.windowId === "smoke-window" &&
          metadata.target.pid === COMPUTER_APP.pid &&
          metadata.target.ref === "ui_1" &&
          metadata.target.elementId === "smoke-send-element",
        "sensitive proof changed the clicked target, frame or action",
      )
      consumed.add(id)
      state.clicked++
      return { done: 1, state: desktopState() } satisfies ComputerBridgeResponse<"act">
    }
    throw new Error("computer-smoke: unexpected fixture command")
  }
  const server = createServer((request, response) => {
    void (async () => {
      requireComputer(
        request.headers.authorization === `Bearer ${token}` && request.headers["vector-computer-protocol"] === "1",
        "bridge authentication or protocol header is missing",
      )
      if (request.method === "GET" && request.url === "/computer/capabilities") {
        state.capabilities++
        return {
          protocol: 1,
          available: true,
          backend: "fake",
          actions: ["screenshot", "click"],
          features: { background: false, uiTree: false, zoom: false, clipboard: false, locked: false },
        } satisfies Computer.Capabilities
      }
      requireComputer(request.method === "POST" && request.url === "/computer", "unexpected bridge HTTP route")
      const chunks: Buffer[] = []
      const retained = { bytes: 0 }
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk)
        retained.bytes += bytes.length
        requireComputer(retained.bytes <= 65_536, "bridge request exceeded its fixture bound")
        chunks.push(bytes)
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      requireComputer(isRecord(body) && typeof body.command === "string", "invalid bridge body")
      calls.push(body)
      return answer(body)
    })().then(
      (body) => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(body))
      },
      (error) => {
        state.failures.push(
          error instanceof Error && error.message.startsWith("computer-smoke:")
            ? error.message
            : "computer-smoke: invalid fixture request",
        )
        response.writeHead(409, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            ok: false,
            code: "failed",
            error: "The isolated computer smoke fixture refused the request.",
          }),
        )
      },
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  requireComputer(address && typeof address !== "string", "fixture bridge has no loopback address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    calls,
    approvals,
    images,
    state,
    consumed,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function runComputerTurn(
  engine: { url: URL; authorization: string },
  project: string,
  bridge: Awaited<ReturnType<typeof startComputerBridge>>,
  modelRequests: ChatRequest[],
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
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    })
  const json = async (route: string, init?: { method?: string; body?: unknown }) => {
    const response = await request(route, init)
    requireComputer(response.ok, `HTTP ${init?.method ?? "GET"} ${route} returned ${response.status}`)
    const text = await response.text()
    // prompt_async acknowledges admission with 204; permission replies still require their JSON true.
    if (response.status === 204) {
      requireComputer(text.length === 0, "HTTP no-content acknowledgement included a body")
      return undefined
    }
    requireComputer(text.length > 0, `HTTP ${init?.method ?? "GET"} ${route} returned empty JSON`)
    return JSON.parse(text) as unknown
  }
  const session = await json("/session", { method: "POST", body: { title: "isolated Node computer smoke" } })
  requireComputer(isRecord(session) && typeof session.id === "string", "HTTP session creation failed")
  const sessionID = session.id
  const abort = new AbortController()
  const events = await request("/event", { signal: abort.signal })
  requireComputer(events.ok && events.body, "computer event stream did not open")
  const turn = watchTurn(events.body, sessionID, async (permission) => {
    requireComputer(
      typeof permission.id === "string" && !bridge.approvals.has(permission.id),
      "permission ID is missing or repeated",
    )
    const metadata = permission.metadata
    requireComputer(
      isRecord(metadata) && isRecord(metadata.target) && metadata.target.appKey === COMPUTER_KEY,
      "HTTP permission names another app",
    )
    requireComputer(
      permission.permission === "computer_app"
        ? metadata.action === "use_app" &&
            metadata.level === "interact" &&
            metadata.target.pid === COMPUTER_APP.pid &&
            metadata.target.path === COMPUTER_APP.path &&
            metadata.target.teamId === COMPUTER_APP.teamId &&
            Array.isArray(permission.patterns) &&
            permission.patterns.includes(COMPUTER_KEY)
        : permission.permission === "computer_sensitive" &&
            metadata.action === "click" &&
            metadata.why === "send" &&
            metadata.stepDigest === COMPUTER_CLICK_DIGEST &&
            metadata.frame === bridge.state.frame &&
            metadata.target.pid === COMPUTER_APP.pid &&
            metadata.target.windowId === "smoke-window" &&
            metadata.target.ref === "ui_1" &&
            metadata.target.elementId === "smoke-send-element",
      "unexpected computer permission or target",
    )
    const accepted = json(`/permission/${encodeURIComponent(permission.id)}/reply`, {
      method: "POST",
      body: { reply: "once" },
    }).then((reply) => reply === true)
    bridge.approvals.set(permission.id, { request: permission, accepted })
    requireComputer(await accepted, "the real HTTP permission route did not accept Allow once")
  })
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT)
  const outcome = await (async () => {
    await json(`/session/${sessionID}/prompt_async`, {
      method: "POST",
      body: {
        agent: "build",
        model: { providerID: PROVIDER, modelID: MODEL },
        size: "light",
        parts: [{ type: "text", text: COMPUTER }],
      },
    })
    return turn
  })().finally(() => {
    clearTimeout(timer)
    abort.abort()
  })
  const messages = (await json(`/session/${sessionID}/message`)) as Message[]
  const deadline = Date.now() + 5000
  while (!bridge.state.released && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  const pending = await json("/permission")
  const assistant = messages.filter((message) => message.info.role === "assistant")
  const parts = assistant.flatMap((message) => message.parts)
  const tools = parts.filter((part) => part.type === "tool" && part.tool === "computer")
  const approvals = [...bridge.approvals.values()]
  const requests = modelRequests.filter(
    (body) =>
      JSON.stringify(body.messages ?? []).includes(COMPUTER) &&
      body.tools?.some((item) => item.function?.name === "computer"),
  )
  const afterScreenshot = requests.find((body) =>
    body.messages?.some(
      (message) => message.role === "tool" && message.tool_call_id === "call_smoke_computer_screenshot",
    ),
  )
  const afterClick = requests.find((body) =>
    body.messages?.some((message) => message.role === "tool" && message.tool_call_id === "call_smoke_computer_click"),
  )
  const failures = [
    ...outcome,
    ...bridge.state.failures,
    ...assistant.flatMap((message) => (message.info.error ? ["assistant message recorded a computer-turn error"] : [])),
    ...(tools.length === 2 &&
    tools[0]?.state?.metadata?.action === "screenshot" &&
    tools[1]?.state?.metadata?.action === "click"
      ? []
      : ["computer screenshot/click tool sequence did not complete"]),
    ...tools.flatMap((part) =>
      part.state?.status !== "completed" || part.state.metadata?.code !== undefined
        ? ["a computer tool did not finish successfully"]
        : [],
    ),
    ...(tools[0]?.state?.attachments?.some((file) => file.mime === "image/png" && file.url === bridge.images.before) &&
    tools[1]?.state?.attachments?.some((file) => file.mime === "image/png" && file.url === bridge.images.after)
      ? []
      : ["the recorded computer tool parts lack their exact pre/post-click image attachments"]),
    ...(afterScreenshot &&
    requestImages(afterScreenshot).includes(bridge.images.before) &&
    afterClick &&
    requestImages(afterClick).includes(bridge.images.after)
      ? []
      : ["the actual model requests lack pre/post-click screenshot image parts"]),
    ...(approvals.length === 2 &&
    approvals.some((item) => item.request.permission === "computer_app") &&
    approvals.some((item) => item.request.permission === "computer_sensitive") &&
    bridge.consumed.size === 2
      ? []
      : ["app and sensitive permission IDs were not approved over HTTP and consumed once"]),
    ...(bridge.calls.filter((body) => body.command === "screenshot").length === 2 &&
    bridge.calls.filter((body) => body.command === "act").length === 1 &&
    bridge.state.clicked === 1 &&
    bridge.state.capabilities > 0
      ? []
      : ["the bridge did not observe the expected screenshot/click/capture sequence"]),
    ...(bridge.state.released &&
    !bridge.state.holder &&
    !bridge.state.level &&
    bridge.calls.some((body) => body.command === "cancel")
      ? []
      : ["the finished turn did not cancel and release its exact fixture lease"]),
    ...(Array.isArray(pending) && !pending.some((item) => isRecord(item) && item.sessionID === sessionID)
      ? []
      : ["the finished computer turn left a pending permission"]),
    ...(parts.some((part) => part.type === "text" && part.text?.includes(COMPUTER_REPLY))
      ? []
      : ["the computer turn did not finish with the model's final reply"]),
  ]
  if (!failures.length)
    console.log(
      "node computer smoke passed: bridge screenshots/click, HTTP app/sensitive approvals, exact image attachments and clean lease finish (fake bridge; no native OS evidence)",
    )
  if (failures.length) {
    // Only closed protocol tokens, counts and presence flags leave this synthetic fixture. Never emit tool output,
    // image bytes, request/lease/frame IDs, app metadata, credentials or arbitrary errors from the worker.
    const statuses = new Set(["pending", "running", "completed", "error"])
    const codes = new Set([
      "unavailable",
      "permissions",
      "busy",
      "stopped",
      "paused",
      "locked",
      "blocked",
      "protected",
      "denied",
      "not_granted",
      "stale_frame",
      "stale_ref",
      "changed",
      "occluded",
      "secure_field",
      "elevated",
      "secure_desktop",
      "not_foreground",
      "capture_unavailable",
      "no_ui_tree",
      "out_of_bounds",
      "needs_foreground",
      "timeout",
      "app_not_found",
      "unsupported_action",
      "frame_too_large",
      "helper_incompatible",
      "unsupported_os",
      "blocked_by_os",
      "responsible_missing",
      "failed",
    ])
    const commands = new Set([
      "acquire",
      "release",
      "cancel",
      "heartbeat",
      "status",
      "access",
      "grant",
      "inspect",
      "screenshot",
      "act",
    ])
    failures.push(
      "closed fixture facts: " +
        JSON.stringify({
          tools: tools.slice(0, 4).map((part) => {
            const action = part.state?.metadata?.action
            const status = part.state?.status
            const code = part.state?.metadata?.code
            return {
              action: action === "screenshot" || action === "click" ? action : "unknown",
              status: status !== undefined && statuses.has(status) ? status : "unknown",
              code: code === undefined ? "none" : typeof code === "string" && codes.has(code) ? code : "unknown",
              imageBefore:
                part.state?.attachments?.some(
                  (file) => file.mime === "image/png" && file.url === bridge.images.before,
                ) === true,
              imageAfter:
                part.state?.attachments?.some(
                  (file) => file.mime === "image/png" && file.url === bridge.images.after,
                ) === true,
              framePresent: isRecord(part.state?.metadata?.frame),
            }
          }),
          commands: bridge.calls
            .slice(0, 64)
            .map((body) => (typeof body.command === "string" && commands.has(body.command) ? body.command : "unknown")),
          captures: bridge.state.frames,
          clicks: bridge.state.clicked,
          appApprovals: approvals.filter((item) => item.request.permission === "computer_app").length,
          sensitiveApprovals: approvals.filter((item) => item.request.permission === "computer_sensitive").length,
          consumedApprovals: bridge.consumed.size,
          released: bridge.state.released,
          holderPresent: bridge.state.holder !== undefined,
        }),
    )
  }
  return failures
}

function requestImages(body: ChatRequest) {
  return (body.messages ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part: unknown) =>
          isRecord(part) &&
          part.type === "image_url" &&
          isRecord(part.image_url) &&
          typeof part.image_url.url === "string"
            ? [part.image_url.url]
            : [],
        )
      : [],
  )
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
  state?: {
    status?: string
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    attachments?: { mime?: string; url?: string }[]
  }
}
type Message = { info: { role: string; error?: unknown }; parts: Part[] }
type Event = { type?: string; properties?: Record<string, unknown> }

// Resolves once the session goes idle, with every session error the engine published on the way.
async function watchTurn(
  body: ReadableStream<Uint8Array>,
  sessionID: string,
  approve?: (request: Record<string, unknown>) => Promise<void>,
) {
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
        if (event.type === "permission.asked") {
          if (approve && event.properties) await approve(event.properties)
          else failures.push(`unexpected permission request: ${JSON.stringify(event.properties)}`)
        }
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
  messages?: { role?: string; content?: unknown; tool_call_id?: string }[]
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
  const computer = JSON.stringify(body.messages ?? []).includes(COMPUTER)
  const screenshots = body.messages?.some(
    (message) => message.role === "tool" && message.tool_call_id === "call_smoke_computer_screenshot",
  )
  const clicked = body.messages?.some(
    (message) => message.role === "tool" && message.tool_call_id === "call_smoke_computer_click",
  )
  const tool = computer ? "computer" : keeping ? "memory" : "read"
  const call =
    body.tools?.some((item) => item.function?.name === tool) &&
    (computer ? !clicked : !body.messages?.some((message) => message.role === "tool"))
  const reply = computer ? COMPUTER_REPLY : keeping ? KEPT : REPLY
  const callID = computer
    ? screenshots
      ? "call_smoke_computer_click"
      : "call_smoke_computer_screenshot"
    : `call_smoke_${tool}`
  const args = JSON.stringify(
    computer
      ? screenshots
        ? { action: "click", x: 32, y: 24, intent: "Send the isolated fixture message." }
        : { action: "screenshot", app: COMPUTER_APP.name, intent: "Inspect the isolated fixture app." }
      : keeping
        ? { action: "add", file: "spec.pdf" }
        : { filePath: notes },
  )
  const finish = call ? "tool_calls" : "stop"
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  if (body.stream !== true) {
    const message = call
      ? {
          role: "assistant",
          content: null,
          tool_calls: [{ id: callID, type: "function", function: { name: tool, arguments: args } }],
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
          tool_calls: [{ index: 0, id: callID, type: "function", function: { name: tool, arguments: "" } }],
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
