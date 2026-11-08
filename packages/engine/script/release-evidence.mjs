#!/usr/bin/env node
// Offline only. Runs explicit release bytes under Node; never chooses a source/installed-CLI fallback.
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { hostname, cpus, totalmem } from "node:os"
import {
  MODEL,
  MAX_BODY,
  PROMPT,
  REPLY,
  environment,
  execute,
  json,
  save,
  sha256,
  validateIdentity,
  responseEvents,
  startSampler,
  summarizeMemory,
  requireOfflineNetwork,
} from "./release-evidence/support.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const HELP =
  "node release-evidence.mjs --bundle ABS_ENTRY --entry-kind packaged-sidecar|server --identity PROVENANCE_JSON --out FRESH_DIRECTORY [--dependency-package DESKTOP_PACKAGE_JSON] [--offline]"

export function parseArgs(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name === "--offline") {
      if (values.offline) throw new Error("DUPLICATE_ARGUMENT")
      values.offline = true
      continue
    }
    if (!["--bundle", "--entry-kind", "--identity", "--out", "--dependency-package"].includes(name))
      throw new Error(`UNSUPPORTED_ARGUMENT: ${name}`)
    if (values[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--"))
      throw new Error("MISSING_OR_DUPLICATE_ARGUMENT")
    values[name] = argv[++i]
  }
  for (const name of ["--bundle", "--entry-kind", "--identity", "--out"])
    if (!values[name]) throw new Error(`REQUIRED_ARGUMENT: ${name}`)
  if (!["server", "packaged-sidecar"].includes(values["--entry-kind"])) throw new Error("INVALID_ENTRY_KIND")
  return {
    bundle: resolve(values["--bundle"]),
    entryKind: values["--entry-kind"],
    identityFile: resolve(values["--identity"]),
    out: resolve(values["--out"]),
    dependencyPackage: values["--dependency-package"] ? resolve(values["--dependency-package"]) : undefined,
  }
}

async function unusedPort() {
  const server = createServer()
  await new Promise((done, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", done)
  })
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}

async function fakeProvider(out) {
  const requests = []
  const failures = []
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/responses") throw new Error("FAKE_ENDPOINT_MISMATCH")
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.byteLength
        if (size > MAX_BODY) throw new Error("FAKE_BODY_LIMIT")
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks)
      const sessionID = req.headers["x-session-id"]
      if (requests.length >= 2 || requests.some((item) => item.sessionID === sessionID))
        throw new Error("FAKE_SEND_LIMIT")
      const ordinal = requests.length + 1
      requests.push({
        ordinal,
        sessionID,
        at: new Date().toISOString(),
        requestSha256: sha256(raw),
        bytes: raw.byteLength,
      })
      await save(join(out, "fake-provider.json"), {
        synthetic: true,
        requests,
        failures,
      })
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      })
      res.end(responseEvents(ordinal))
    } catch (error) {
      failures.push({ at: new Date().toISOString(), code: error.message })
      await save(join(out, "fake-provider.json"), {
        synthetic: true,
        requests,
        failures,
      })
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: error.message }))
    }
  })
  await new Promise((done, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", done)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    failures,
    stop: async () => {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    },
  }
}

function providerConfig(origin, plugin) {
  return {
    model: `openai/${MODEL}`,
    small_model: `openai/${MODEL}`,
    formatter: false,
    lsp: false,
    plugin: [pathToFileURL(plugin).href],
    // Keep the verified release catalog's model metadata and built-in medium variant.
    // A release without this exact model must fail rather than silently synthesize a replacement.
    provider: {
      openai: {
        options: {
          apiKey: "vector-offline-synthetic-key",
          baseURL: `${origin}/v1`,
        },
      },
    },
  }
}

async function startEngine(settings, report, phase) {
  const port = await unusedPort()
  const password = randomBytes(24).toString("hex")
  const env = {
    ...environment(settings.out),
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: password,
    VECTOR_EVIDENCE_DIRECTORY: settings.out,
  }
  const file = join(settings.out, "bootstrap.json")
  await save(file, settings)
  const child = spawn(process.execPath, [join(here, "release-evidence/engine.mjs"), file], {
    cwd: settings.project,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const output = []
  let outputBytes = 0
  const collect = (chunk) => {
    if (outputBytes < 4 * 1024 * 1024) output.push(chunk.subarray(0, 4 * 1024 * 1024 - outputBytes))
    outputBytes += chunk.byteLength
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  const memory = []
  child.on("message", (message) => {
    if (message?.type === "memory") memory.push({ ...message, phase: phase() })
    if (message?.type === "runtime") report.runtime = message
  })
  const sampler = startSampler(child.pid, phase)
  let exit
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => {
      exit = { code, signal }
      done(exit)
    }),
  )
  const stop = async () => {
    await sampler.sample()
    if (!exit) {
      if (child.connected) child.send({ type: "stop" })
      else child.kill("SIGTERM")
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000)
      await exited
      clearTimeout(timeout)
    }
    await sampler.stop()
    report.memory = {
      intervalMs: 100,
      ...summarizeMemory(sampler.samples, sampler.errors),
      nodeSamples: memory,
    }
    report.engineExit = exit
    report.engineLogTruncated = outputBytes > 4 * 1024 * 1024
    const log = Buffer.concat(output)
    report.transport = {
      configuredWire: "HTTP to loopback fake Responses provider",
      observedWire: null,
      diagnostics: log
        .toString("utf8")
        .split("\n")
        .filter((line) => line.includes("openai transport"))
        .map((line) => line.slice(0, 2048)),
    }
    await writeFile(join(settings.out, "engine.log"), log, { mode: 0o600 })
  }
  try {
    await new Promise((done, fail) => {
      const timeout = setTimeout(() => fail(new Error("ENGINE_START_TIMEOUT")), 60_000)
      const finish = (error) => {
        clearTimeout(timeout)
        child.off("message", message)
        child.off("error", finish)
        error ? fail(error) : done()
      }
      const message = (value) => {
        if (value?.type === "error") finish(new Error(`ENGINE_START_FAILED: ${value.error?.message}`))
        if (value?.type === "bootstrap-ready")
          child.send({
            type: "start",
            hostname: "127.0.0.1",
            port,
            password,
            userDataPath: join(settings.out, "profile"),
            environment: env,
            authorities: [],
          })
        if (value?.type === "ready") finish()
      }
      child.on("message", message)
      child.once("error", finish)
      void exited.then(() => finish(new Error("ENGINE_EXITED_BEFORE_READY")))
    })
  } catch (error) {
    await stop()
    throw error
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    authorization: `Basic ${Buffer.from(`vector:${password}`).toString("base64")}`,
    pid: child.pid,
    sample: sampler.sample,
    stop,
  }
}

async function watchTurn(body, sessionID, eventsFile) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ""
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("EVENT_STREAM_ENDED")
      bytes += chunk.value.byteLength
      if (bytes > 4 * 1024 * 1024) throw new Error("EVENT_STREAM_LIMIT")
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
      const blocks = buffer.split("\n\n")
      buffer = blocks.pop()
      for (const block of blocks) {
        for (const line of block.split("\n").filter((line) => line.startsWith("data:"))) {
          const event = JSON.parse(line.slice(5))
          if (event.properties?.sessionID !== sessionID) continue
          events.push(event)
          if (event.type === "session.error") throw new Error("SESSION_ERROR")
          if (["permission.asked", "question.asked"].includes(event.type)) throw new Error("UNEXPECTED_OWNER_ASK")
          if (event.type === "session.status" && event.properties.status?.type === "idle") return
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    await save(eventsFile, events)
  }
}

export async function run(settings) {
  if (process.versions.bun) throw new Error("NODE_REQUIRED")
  requireOfflineNetwork()
  const identity = validateIdentity(await json(settings.identityFile), await readFile(settings.bundle))
  const platform = `${process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  if (identity.platform !== platform) throw new Error("ARTIFACT_PLATFORM_MISMATCH")
  await mkdir(settings.out, { recursive: false, mode: 0o700 })
  const report = {
    schemaVersion: 1,
    kind: "offline-release-engine-evidence",
    status: "failed",
    synthetic: true,
    measuredCacheReuse: false,
    actualProviderCostUsd: null,
    startedAt: new Date().toISOString(),
    identity,
    entryKind: settings.entryKind,
    execution:
      settings.entryKind === "packaged-sidecar" ? "Node-hosted packaged sidecar" : "Node release engine bundle",
    limitations: [
      "Not a full Electron desktop memory profile.",
      "Cached tokens and provider usage are scripted; no live cache, quality, speed or cost result.",
      "RSS is sampled process-tree resident memory; shared pages may be counted more than once.",
      "Capture buffers each response before replay; instrumentation affects memory and timing.",
      "The evidence plugin applies the requested 512-token cap after built-in chat.params hooks.",
    ],
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? null,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      hostnameSha256: sha256(hostname()),
    },
    controls: {
      model: MODEL,
      variant: "medium",
      size: "standard",
      judge: "off",
      executionMode: "normal",
      steps: 1,
      outputTokenMax: 512,
      outputTokenMaxMechanism: "Evidence plugin chat.params hook; exact value independently required on the wire",
      transportOverride: "HTTP forced for offline instrumentation",
      cacheWarmup: false,
      cacheRetentionOverride: false,
    },
    sessions: [],
    errors: [],
  }
  let engine
  let model
  let phase = "startup"
  try {
    for (const directory of [
      "home",
      "tmp",
      "profile/config/vector",
      "profile/xdg-data",
      "profile/xdg-config",
      "profile/xdg-cache",
      "profile/xdg-state",
      "project",
    ])
      await mkdir(join(settings.out, directory), {
        recursive: true,
        mode: 0o700,
      })
    const project = join(settings.out, "project")
    const files = {
      "README.md": "# Vector release instrumentation fixture\n",
      "notes.txt": "This fixed fixture is unchanged between the two sessions.\n",
    }
    for (const [name, text] of Object.entries(files)) await writeFile(join(project, name), text)
    const git = (args) => execute("git", args, { cwd: project, env: environment(settings.out) })
    await git(["init", "--quiet"])
    await git(["add", "README.md", "notes.txt"])
    await git([
      "-c",
      "user.name=Vector offline fixture",
      "-c",
      "user.email=offline@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixed cache instrumentation fixture",
    ])
    report.fixture = {
      path: project,
      files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])),
    }
    const harnessFiles = [
      "release-evidence.mjs",
      "release-evidence/support.mjs",
      "release-evidence/engine.mjs",
      "release-evidence/veto.mjs",
    ]
    report.harness = Object.fromEntries(
      await Promise.all(harnessFiles.map(async (name) => [name, sha256(await readFile(join(here, name)))])),
    )
    model = await fakeProvider(settings.out)
    const configuration = providerConfig(model.origin, join(here, "release-evidence/veto.mjs"))
    report.configuration = configuration
    await save(join(settings.out, "profile/config/vector/vector.json"), configuration)
    engine = await startEngine({ ...settings, identity, project, providerOrigin: model.origin }, report, () => phase)
    const setPhase = async (next) => {
      await engine.sample()
      phase = next
      await engine.sample()
    }
    const request = async (route, { method = "GET", body, signal } = {}) => {
      const response = await fetch(new URL(route, engine.origin), {
        method,
        signal: signal ?? AbortSignal.timeout(30_000),
        headers: {
          authorization: engine.authorization,
          "content-type": "application/json",
          "x-vector-directory": encodeURIComponent(project),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`ENGINE_HTTP_${response.status}`)
      return response
    }
    const health = await (await request("/global/health")).json()
    report.health = health
    if (health.version !== identity.version) throw new Error("RUNTIME_VERSION_MISMATCH")
    await setPhase("idle")
    await new Promise((done) => setTimeout(done, 500))
    const sessions = []
    for (let i = 0; i < 2; i++)
      sessions.push(
        await (
          await request("/session", {
            method: "POST",
            body: { title: "Release cache instrumentation" },
          })
        ).json(),
      )
    await save(join(settings.out, "grants.json"), {
      sessions: sessions.map((item) => item.id),
    })
    for (let i = 0; i < sessions.length; i++) {
      const sessionID = sessions[i].id
      await setPhase(`session-${i + 1}`)
      const entry = {
        sessionID,
        ordinal: i + 1,
        enginePID: engine.pid,
        startedAt: new Date().toISOString(),
        status: "failed",
      }
      report.sessions.push(entry)
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 60_000)
      let watched
      try {
        const stream = await request("/event", { signal: abort.signal })
        watched = watchTurn(stream.body, sessionID, join(settings.out, `events-${i + 1}.json`))
        // Observe a failing event stream even if prompt admission rejects first.
        void watched.catch(() => {})
        const prompt = {
          agent: "build",
          model: { providerID: "openai", modelID: MODEL },
          variant: "medium",
          executionMode: "normal",
          size: "standard",
          judge: "off",
          budget: { steps: 1 },
          parts: [{ type: "text", text: PROMPT }],
        }
        await save(join(settings.out, `prompt-${i + 1}.json`), prompt)
        await request(`/session/${sessionID}/prompt_async`, {
          method: "POST",
          body: prompt,
        })
        await watched
        const messages = await (await request(`/session/${sessionID}/message`)).json()
        await save(join(settings.out, `messages-${i + 1}.json`), messages)
        const parts = messages
          .filter((message) => message.info?.role === "assistant")
          .flatMap((message) => message.parts ?? [])
        const steps = parts.filter((part) => part.type === "step-finish")
        entry.projectedUsage = steps.map((part) => ({
          tokens: part.tokens,
          cost: part.cost ?? null,
        }))
        entry.provider = await json(join(settings.out, `grant-${i + 1}.json`))
        const received = model.requests[i]
        if (received?.sessionID !== sessionID || received.requestSha256 !== entry.provider.requestSha256)
          throw new Error("WIRE_CAPTURE_MISMATCH")
        if (entry.provider.state !== "recorded" || steps.length !== 1 || parts.some((part) => part.type === "tool"))
          throw new Error("SESSION_EVIDENCE_MISMATCH")
        if (!parts.some((part) => part.type === "text" && part.text.trim() === REPLY))
          throw new Error("SESSION_REPLY_MISMATCH")
        if (steps[0].tokens?.cache?.read !== entry.provider.usage?.cachedInputTokens)
          throw new Error("PROJECTED_CACHE_MISMATCH")
        entry.status = "completed"
      } finally {
        clearTimeout(timer)
        abort.abort()
        // Admission can reject before the event stream ends; flush its failure record before writing the report.
        await watched?.catch(() => {})
        entry.completedAt = new Date().toISOString()
        await request(`/session/${sessionID}/abort`, { method: "POST" }).catch(() => {})
        await engine.sample()
      }
    }
    await setPhase("settled")
    await new Promise((done) => setTimeout(done, 500))
    report.fixture.changed = (await git(["status", "--porcelain", "--untracked-files=all"])).stdout.trim()
    if (report.fixture.changed) throw new Error("FIXTURE_CHANGED")
    if ((await json(join(settings.out, "veto-loaded.json"))).loaded !== true) throw new Error("TOOL_VETO_NOT_LOADED")
    if ((await readdir(settings.out)).some((name) => name === "blocked-sends.jsonl" || name === "vetoed-tools.jsonl"))
      throw new Error("UNEXPECTED_SEND_OR_TOOL")
    if (model.requests.length !== 2 || model.failures.length) throw new Error("PROVIDER_SEND_COUNT_MISMATCH")
    if (report.sessions[0].provider.toolsSha256 !== report.sessions[1].provider.toolsSha256)
      throw new Error("TOOL_DEFINITIONS_CHANGED")
    report.status = "completed"
  } catch (error) {
    report.errors.push({ code: error.message })
  } finally {
    await engine?.stop().catch((error) => {
      report.errors.push({ code: `STOP_FAILED: ${error.message}` })
      report.status = "failed"
    })
    await model?.stop().catch((error) => {
      report.errors.push({
        code: `FAKE_PROVIDER_STOP_FAILED: ${error.message}`,
      })
      report.status = "failed"
    })
    if (report.transport) {
      report.transport.forwardedRequests = model?.requests.length ?? 0
      report.transport.observedWire = model?.requests.length ? "http" : null
    }
    if (!report.memory?.complete) {
      report.errors.push({ code: "MEMORY_SAMPLING_INCOMPLETE" })
      report.status = "failed"
    }
    if (report.engineExit && (report.engineExit.code !== 0 || report.engineExit.signal)) {
      report.errors.push({ code: "ENGINE_EXIT_NOT_CLEAN" })
      report.status = "failed"
    }
    report.attempts = []
    for (const name of (await readdir(settings.out)).filter((name) => /^grant-\d\.json$/.test(name)).sort())
      report.attempts.push(
        await json(join(settings.out, name)).catch(() => ({
          file: name,
          state: "unreadable",
          usage: null,
          actualCostUsd: null,
        })),
      )
    report.completedAt = new Date().toISOString()
    await save(join(settings.out, "report.json"), report)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) console.log(HELP)
  else {
    try {
      const report = await run(parseArgs(process.argv.slice(2)))
      console.log(
        JSON.stringify({
          status: report.status,
          synthetic: true,
          sessions: report.sessions.length,
          errors: report.errors,
        }),
      )
      process.exitCode = report.status === "completed" ? 0 : 1
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
