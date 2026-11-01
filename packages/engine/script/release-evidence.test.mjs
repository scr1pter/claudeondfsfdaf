import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { parseArgs } from "./release-evidence.mjs"
import {
  MODEL,
  MEMORY_PHASES,
  PROMPT,
  SendFence,
  capture,
  environment,
  installCapture,
  installLoopbackGuard,
  json,
  requestShape,
  responseEvents,
  save,
  selectProcesses,
  startSampler,
  summarizeMemory,
  sha256,
  validateIdentity,
  requireOfflineNetwork,
} from "./release-evidence/support.mjs"
import veto from "./release-evidence/veto.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const body = (extra = {}) =>
  JSON.stringify({
    model: MODEL,
    reasoning: { effort: "medium" },
    max_output_tokens: 512,
    stream: true,
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
    input: [{ role: "user", content: [{ type: "input_text", text: PROMPT }] }],
    ...extra,
  })
const input = (sessionID, extra = {}) => ({
  method: "POST",
  headers: { "x-session-id": sessionID, "content-type": "application/json" },
  body: body(),
  ...extra,
})
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "vector-evidence-test-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function grants(t) {
  const dir = await directory(t)
  await save(join(dir, "grants.json"), { sessions: ["ses_one", "ses_two"] })
  return dir
}

test("CLI requires exact release inputs and refuses live, URL and source fallbacks", () => {
  const argv = [
    "--bundle",
    "/bundle.js",
    "--entry-kind",
    "packaged-sidecar",
    "--identity",
    "/identity.json",
    "--out",
    "/new",
  ]
  assert.equal(parseArgs(argv).entryKind, "packaged-sidecar")
  for (const added of [
    ["--live"],
    ["--url", "https://api.openai.com"],
    ["--engine-root", "/source"],
    ["--bundle", "/other"],
  ])
    assert.throws(() => parseArgs([...argv, ...added]))
  assert.throws(() => parseArgs([]))
})

test("release identity requires pinned archive, ASAR, catalog and matching entry bytes", () => {
  const bytes = Buffer.from("immutable entry")
  const identity = {
    schemaVersion: 1,
    sourceSha: "a".repeat(40),
    version: "1.99.112",
    channel: "prod",
    platform: "linux-x64",
    entrySha256: sha256(bytes),
    catalogSha256: "b".repeat(64),
    artifact: {
      runId: 1,
      artifactId: 2,
      archiveSha256: "c".repeat(64),
      asarSha256: "d".repeat(64),
    },
  }
  assert.equal(validateIdentity(identity, bytes), identity)
  assert.throws(() => validateIdentity(identity, Buffer.from("different")), /ENTRY_HASH_MISMATCH/)
  assert.throws(() => validateIdentity({ ...identity, channel: "local" }, bytes), /INVALID_RELEASE_IDENTITY/)
  assert.throws(() => validateIdentity({ ...identity, artifact: {} }, bytes), /INVALID_RELEASE_IDENTITY/)
})

test("child environment excludes real credentials, inherited Vector flags, proxies and profiles", () => {
  const result = environment("/fresh", {
    PATH: "/bin",
    HOME: "/real",
    OPENAI_API_KEY: "secret",
    VECTOR_AUTH_CONTENT: "real",
    HTTPS_PROXY: "http://private",
    NODE_OPTIONS: "--inspect",
  })
  assert.equal(result.HOME, "/fresh/home")
  for (const name of ["OPENAI_API_KEY", "HTTPS_PROXY", "NODE_OPTIONS"]) assert.equal(result[name], undefined)
  assert.equal(JSON.parse(result.VECTOR_AUTH_CONTENT).openai.key, "vector-offline-synthetic-key")
  assert.equal(result.VECTOR_EXPERIMENTAL_OUTPUT_TOKEN_MAX, "512")
})

test("wire validation rejects model, effort, output ceilings, missing tools and policy changes", () => {
  assert.equal(requestShape(body()).maxOutputTokens, 512)
  for (const changed of [
    { model: "another-model" },
    { reasoning: { effort: "high" } },
    { max_output_tokens: undefined },
    { max_output_tokens: 513 },
    { tools: [] },
    { stream: false },
    { previous_response_id: "resp_other" },
    { prompt_cache_retention: "24h" },
    { reasoning: { effort: "medium", context: "all_turns" } },
    { service_tier: "priority" },
    { input: [] },
  ])
    assert.throws(() => requestShape(body(changed)))
  assert.throws(() => requestShape("x".repeat(1024 * 1024 + 1)), /REQUEST_BODY_LIMIT/)
})

test("concurrent and restarted attempts cannot reuse a consumed session grant", async (t) => {
  const dir = await grants(t)
  const fence = new SendFence(dir, "http://127.0.0.1:1234")
  const attempts = await Promise.allSettled([
    fence.reserve("http://127.0.0.1:1234/v1/responses", input("ses_one")),
    fence.reserve("http://127.0.0.1:1234/v1/responses", input("ses_one")),
  ])
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(attempts.filter((result) => result.status === "rejected")[0].reason.message, "SESSION_GRANT_EXHAUSTED")
  await assert.rejects(
    new SendFence(dir, fence.origin).reserve(`${fence.origin}/v1/responses`, input("ses_one")),
    /SESSION_GRANT_EXHAUSTED/,
  )
  await fence.reserve(`${fence.origin}/v1/responses`, input("ses_two"))
  await assert.rejects(fence.reserve(`${fence.origin}/v1/responses`, input("ses_helper")), /SESSION_WITHOUT_GRANT/)
  assert.equal((await readdir(dir)).filter((name) => /^grant-/.test(name)).length, 2)
})

test("bad endpoint and oversized output requests consume grants without forwarding", async (t) => {
  const dir = await grants(t)
  const fence = new SendFence(dir, "http://127.0.0.1:1234")
  await assert.rejects(
    fence.reserve("http://127.0.0.1:1234/v1/chat/completions", input("ses_one")),
    /REQUEST_ENDPOINT_MISMATCH/,
  )
  await assert.rejects(
    fence.reserve("http://127.0.0.1:1234/v1/responses", input("ses_two", { body: body({ max_output_tokens: 900 }) })),
    /REQUEST_OUTPUT_LIMIT_MISSING/,
  )
  for (const ordinal of [1, 2]) assert.equal((await json(join(dir, `grant-${ordinal}.json`))).state, "blocked")
})

test("bounded SSE capture preserves synthetic usage and never invents missing usage or cost", async () => {
  const complete = await capture(new Response(responseEvents(2)))
  assert.equal(complete.evidence.error, null)
  assert.deepEqual(complete.evidence.usage, {
    inputTokens: 2048,
    cachedInputTokens: 1024,
    outputTokens: 8,
    reasoningTokens: 2,
  })
  assert.equal(complete.evidence.actualCostUsd, null)
  const missing = await capture(new Response("data: {}\n\n"))
  assert.equal(missing.evidence.error, "TERMINAL_USAGE_MISSING")
  assert.equal(missing.evidence.usage, null)
  const failed = await capture(new Response(responseEvents(1), { status: 500 }))
  assert.equal(failed.evidence.error, "HTTP_500")
  assert.equal(failed.evidence.usage.cachedInputTokens, 0)
})

test("capture cancels oversized bodies and keeps stream failures explicitly unknown", async () => {
  let cancelled = false
  const large = await capture(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(100))
        },
        cancel() {
          cancelled = true
        },
      }),
    ),
    50,
  )
  assert.equal(large.evidence.error, "RESPONSE_BYTE_LIMIT")
  assert.equal(large.bytes.length, 50)
  assert.equal(cancelled, true)
  const broken = await capture(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection lost"))
        },
      }),
    ),
  )
  assert.equal(broken.evidence.error, "RESPONSE_STREAM_FAILED")
  assert.equal(broken.evidence.usage, null)
})

test("real loopback fetch forwards once, blocks a retry, and preserves an aborted grant", async (t) => {
  const dir = await grants(t)
  let forwarded = 0
  const server = createServer((req, res) => {
    forwarded++
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(responseEvents(forwarded))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  const restore = installCapture(dir, origin)
  t.after(() => {
    restore()
    server.closeAllConnections()
    server.close()
  })
  assert.equal((await fetch(`${origin}/v1/responses`, input("ses_one"))).status, 200)
  await assert.rejects(fetch(`${origin}/v1/responses`, input("ses_one")), /SESSION_GRANT_EXHAUSTED/)
  await assert.rejects(fetch(`${origin}/v1/responses`, input("ses_two", { signal: AbortSignal.abort() })))
  assert.equal(forwarded, 1)
  assert.equal((await json(join(dir, "grant-2.json"))).state, "failed")
  assert.equal((await json(join(dir, "grant-2.json"))).usage, null)
  await assert.rejects(fetch(`${origin}/v1/responses`, input("ses_two")), /SESSION_GRANT_EXHAUSTED/)
})

test("a model request cannot bypass capture by switching to a different loopback endpoint", async (t) => {
  const dir = await grants(t)
  let forwarded = 0
  const server = createServer((_req, res) => {
    forwarded++
    res.end("unexpected")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const restore = installCapture(dir, "http://127.0.0.1:1")
  t.after(() => {
    restore()
    server.closeAllConnections()
    server.close()
  })
  await assert.rejects(
    fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, input("ses_one")),
    /REQUEST_ENDPOINT_MISMATCH/,
  )
  assert.equal(forwarded, 0)
})

test("socket fence rejects remote destinations before connection", () => {
  const blocked = []
  const restore = installLoopbackGuard((event) => blocked.push(event))
  try {
    const socket = new net.Socket()
    assert.throws(() => socket.connect({ host: "203.0.113.1", port: 443 }), /OFFLINE_NETWORK_BLOCKED/)
    socket.destroy()
    assert.equal(blocked.length, 1)
  } finally {
    restore()
  }
})

test("the full study refuses hosts with non-loopback networking before launching an engine", () => {
  const lo = [
    { address: "127.0.0.1", internal: true },
    { address: "::1", internal: true },
  ]
  assert.doesNotThrow(() => requireOfflineNetwork("linux", { lo }))
  assert.throws(
    () =>
      requireOfflineNetwork("linux", {
        lo,
        eth0: [{ address: "192.0.2.1", internal: false }],
      }),
    /OFFLINE_NETWORK_NAMESPACE_REQUIRED/,
  )
  assert.throws(() => requireOfflineNetwork("linux", {}), /OFFLINE_NETWORK_NAMESPACE_REQUIRED/)
  assert.throws(() => requireOfflineNetwork("darwin", { lo }), /OFFLINE_NETWORK_NAMESPACE_REQUIRED/)
})

test("tool veto throws before execution and records no tool arguments", async (t) => {
  const dir = await directory(t)
  const previous = process.env.VECTOR_EVIDENCE_DIRECTORY
  process.env.VECTOR_EVIDENCE_DIRECTORY = dir
  t.after(() => {
    if (previous === undefined) delete process.env.VECTOR_EVIDENCE_DIRECTORY
    else process.env.VECTOR_EVIDENCE_DIRECTORY = previous
  })
  const hooks = await veto()
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_one", callID: "call_one" },
      { args: { command: "secret" } },
    ),
    /OFFLINE_TOOL_VETO/,
  )
  assert.equal((await json(join(dir, "veto-loaded.json"))).loaded, true)
  assert.equal((await readFile(join(dir, "vetoed-tools.jsonl"), "utf8")).includes("secret"), false)
})

test("RSS selection follows descendants, retains orphans and excludes reused PIDs", () => {
  const tracked = new Map()
  assert.equal(
    selectProcesses(
      "10 1 100 root-start\n11 10 50 child-start\n12 11 25 worker-start\n99 1 900 unrelated",
      10,
      tracked,
    ).reduce((n, item) => n + item.rssKiB, 0),
    175,
  )
  assert.deepEqual(
    selectProcesses("11 1 55 child-start\n12 1 500 new-process", 10, tracked).map((item) => item.pid),
    [11],
  )
  assert.deepEqual(selectProcesses("10 1 999 reused-root", 10, tracked), [])
})

test("explicit RSS samples cover fast phases without a timer tick and missing phases prevent completion", async (t) => {
  let phase = "startup"
  let calls = 0
  const sampler = startSampler(10, () => phase, {
    intervalMs: 60_000,
    run: async () => {
      calls++
      return { stdout: "10 1 100 root-start\n11 10 50 child-start" }
    },
  })
  t.after(() => sampler.stop())
  for (const next of MEMORY_PHASES) {
    phase = next
    await sampler.sample()
  }
  const { samples, errors } = await sampler.stop()
  assert.equal(calls, MEMORY_PHASES.length + 1)
  const report = summarizeMemory(samples, errors)
  assert.equal(report.complete, true)
  assert.deepEqual(report.missingPhases, [])
  for (const next of MEMORY_PHASES) {
    assert.ok(report.phases[next].processSampleCount > 0)
    assert.equal(report.phases[next].sampledPeakRssKiB, 150)
  }
  const missing = summarizeMemory(
    samples.filter((sample) => sample.phase !== "session-1"),
    [],
  )
  assert.equal(missing.complete, false)
  assert.deepEqual(missing.missingPhases, ["session-1"])
  assert.equal(missing.phases["session-1"].sampledPeakRssKiB, null)
  assert.equal(summarizeMemory(samples, [{ code: "PS_FAILED", phase: "idle" }]).complete, false)
})

test("an in-flight RSS sample retains its invocation phase and cannot replace the next boundary sample", async (t) => {
  let phase = "startup"
  let calls = 0
  const first = Promise.withResolvers()
  const sampler = startSampler(10, () => phase, {
    intervalMs: 60_000,
    run: async () => (++calls === 1 ? first.promise : { stdout: "10 1 200 root-start" }),
  })
  t.after(() => sampler.stop())
  phase = "idle"
  const boundary = sampler.sample()
  first.resolve({ stdout: "10 1 100 root-start" })
  await boundary
  const { samples, errors } = await sampler.stop()
  assert.deepEqual(errors, [])
  assert.deepEqual(
    samples.map((sample) => [sample.phase, sample.rssKiB]),
    [
      ["startup", 100],
      ["idle", 200],
    ],
  )
})

test("failed and empty RSS samples remain incomplete with unknown peaks rather than zero", async (t) => {
  for (const failed of [false, true]) {
    const sampler = startSampler(10, () => "startup", {
      intervalMs: 60_000,
      run: async () => {
        if (failed) throw Object.assign(new Error("ps failed"), { code: "PS_FIXTURE_FAILURE" })
        return { stdout: "99 1 900 unrelated" }
      },
    })
    t.after(() => sampler.stop())
    const { samples, errors } = await sampler.stop()
    const report = summarizeMemory(samples, errors)
    assert.equal(report.complete, false)
    assert.deepEqual(report.missingPhases, MEMORY_PHASES)
    assert.equal(report.sampledPeakProcessTreeRssKiB, null)
    assert.ok(Object.values(report.phases).every((phase) => phase.sampledPeakRssKiB === null))
    if (failed) assert.equal(errors[0].code, "PS_FIXTURE_FAILURE")
    else
      assert.deepEqual(
        samples.map((sample) => [sample.processes, sample.rssKiB]),
        [[[], null]],
      )
  }
})

test("packaged-sidecar bootstrap uses parentPort IPC without altering entry bytes", async (t) => {
  const dir = await grants(t)
  for (const name of ["home", "tmp"]) await mkdir(join(dir, name))
  const entry = join(dir, "sidecar.mjs")
  const source = `process.parentPort.on("message", ({data}) => { if (data.type === "start") process.parentPort.postMessage({type:"ready", userDataPath:data.userDataPath}); if (data.type === "stop") process.exit(0) })\n`
  await writeFile(entry, source)
  await save(join(dir, "settings.json"), {
    bundle: entry,
    entryKind: "packaged-sidecar",
    out: dir,
    providerOrigin: "http://127.0.0.1:1",
    identity: { entrySha256: sha256(source) },
  })
  const child = spawn(process.execPath, [join(here, "release-evidence/engine.mjs"), join(dir, "settings.json")], {
    env: environment(dir),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  t.after(() => child.kill())
  const errors = []
  child.stderr.on("data", (chunk) => errors.push(chunk.toString()))
  const ready = new Promise((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`bootstrap timed out: ${errors.join("")}`)), 5000)
    child.on("message", (message) => {
      if (message.type === "bootstrap-ready") child.send({ type: "start", userDataPath: join(dir, "profile") })
      if (message.type === "ready") {
        clearTimeout(timeout)
        done(message)
      }
    })
    child.once("error", fail)
  })
  assert.equal((await ready).userDataPath, join(dir, "profile"))
  const exited = once(child, "exit")
  child.send({ type: "stop" })
  assert.equal((await exited)[0], 0)
  assert.equal(sha256(await readFile(entry)), sha256(source))
})
