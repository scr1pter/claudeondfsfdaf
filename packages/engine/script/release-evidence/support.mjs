import { createHash } from "node:crypto"
import { open, readFile, appendFile, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import net from "node:net"
import { syncBuiltinESMExports } from "node:module"
import { networkInterfaces } from "node:os"

export const MODEL = "gpt-6.1-sol"
export const REPLY = "CACHE_CHECK_DONE"
export const PROMPT =
  "This is a request-cache instrumentation check. Reply only with CACHE_CHECK_DONE. Do not call tools, edit files, delegate, or research."
export const MAX_BODY = 1024 * 1024
export const MAX_RESPONSE = 4 * 1024 * 1024
export const MAX_OUTPUT = 512
export const sha256 = (value) => createHash("sha256").update(value).digest("hex")
export const json = (file) => readFile(file, "utf8").then(JSON.parse)
export const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
export const execute = promisify(execFile)

/** CI enters a fresh Linux network namespace before launching this process, workers or subprocesses. */
export function requireOfflineNetwork(platform = process.platform, interfaces = networkInterfaces()) {
  const addresses = Object.values(interfaces).flatMap((values) => values ?? [])
  if (
    platform !== "linux" ||
    !addresses.some((item) => item.address === "127.0.0.1") ||
    addresses.some((item) => !item.internal)
  )
    throw new Error("OFFLINE_NETWORK_NAMESPACE_REQUIRED")
}

export function validateIdentity(value, entryBytes) {
  const hash = /^[a-f0-9]{64}$/
  if (
    value?.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(value.sourceSha ?? "") ||
    typeof value.version !== "string" ||
    value.channel !== "prod" ||
    typeof value.platform !== "string" ||
    !hash.test(value.entrySha256 ?? "") ||
    !hash.test(value.catalogSha256 ?? "") ||
    !hash.test(value.artifact?.archiveSha256 ?? "") ||
    !hash.test(value.artifact?.asarSha256 ?? "") ||
    !Number.isSafeInteger(value.artifact?.runId) ||
    !Number.isSafeInteger(value.artifact?.artifactId)
  )
    throw new Error("INVALID_RELEASE_IDENTITY")
  if (sha256(entryBytes) !== value.entrySha256) throw new Error("ENTRY_HASH_MISMATCH")
  return value
}

/** No inherited credentials/proxies or user profile enter the child. */
export function environment(root, inherited = process.env) {
  return {
    PATH: inherited.PATH ?? "",
    ...(process.platform === "win32" && inherited.SystemRoot ? { SystemRoot: inherited.SystemRoot } : {}),
    HOME: `${root}/home`,
    USERPROFILE: `${root}/home`,
    VECTOR_TEST_HOME: `${root}/home`,
    TMPDIR: `${root}/tmp`,
    TMP: `${root}/tmp`,
    TEMP: `${root}/tmp`,
    XDG_DATA_HOME: `${root}/profile/xdg-data`,
    XDG_CONFIG_HOME: `${root}/profile/xdg-config`,
    XDG_CACHE_HOME: `${root}/profile/xdg-cache`,
    XDG_STATE_HOME: `${root}/profile/xdg-state`,
    VECTOR_AGENT_CONFIG_DIR: `${root}/profile/config/vector`,
    VECTOR_APP_NAMESPACE: "vector",
    VECTOR_CLIENT: "desktop",
    VECTOR_DISABLE_CHANNEL_DB: "1",
    VECTOR_DISABLE_MODELS_FETCH: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    VECTOR_DISABLE_AUTOUPDATE: "1",
    VECTOR_DISABLE_PROJECT_CONFIG: "1",
    VECTOR_PRINT_LOGS: "1",
    VECTOR_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
    VECTOR_EXPERIMENTAL_LSP_TOOL: "true",
    VECTOR_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(MAX_OUTPUT),
    VECTOR_DISABLE_WEBSOCKETS: "1",
    VECTOR_EXPERIMENTAL_WEBSOCKETS: "0",
    VECTOR_AUTH_CONTENT: JSON.stringify({
      openai: { type: "api", key: "vector-offline-synthetic-key" },
    }),
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  }
}

/** Supplement the fixed fake key/base URL with a socket-level offline fence. */
export function installLoopbackGuard(onBlocked = () => {}) {
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    const host =
      typeof first === "object" ? (first.host ?? "localhost") : typeof args[1] === "string" ? args[1] : "localhost"
    const pipe = typeof first === "string" || (typeof first === "object" && first.path !== undefined)
    if (pipe || !["127.0.0.1", "::1", "localhost"].includes(host)) {
      onBlocked({ code: "OFFLINE_NETWORK_BLOCKED", host: String(host) })
      throw new Error("OFFLINE_NETWORK_BLOCKED")
    }
    return original.apply(this, args)
  }
  syncBuiltinESMExports()
  return () => {
    net.Socket.prototype.connect = original
    syncBuiltinESMExports()
  }
}

function contentText(body) {
  return (Array.isArray(body.input) ? body.input : [])
    .flatMap((item) => {
      if (item?.role !== "user") return []
      if (typeof item.content === "string") return [item.content]
      return Array.isArray(item.content)
        ? item.content.filter((part) => part.type === "input_text").map((part) => part.text)
        : []
    })
    .join("\n")
}

export function requestShape(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BODY) throw new Error("REQUEST_BODY_LIMIT")
  const body = JSON.parse(raw)
  if (body.model !== MODEL) throw new Error("REQUEST_MODEL_MISMATCH")
  if (body.reasoning?.effort !== "medium") throw new Error("REQUEST_EFFORT_MISMATCH")
  if (body.max_output_tokens !== MAX_OUTPUT) throw new Error("REQUEST_OUTPUT_LIMIT_MISSING")
  if (body.stream !== true || !Array.isArray(body.tools) || !body.tools.length)
    throw new Error("REQUEST_STANDARD_TOOLS_MISSING")
  if (
    body.previous_response_id !== undefined ||
    body.prompt_cache_retention !== undefined ||
    body.reasoning?.context !== undefined ||
    ![undefined, "auto", "default"].includes(body.service_tier)
  )
    throw new Error("REQUEST_EXPERIMENT_NOT_ALLOWED")
  if (!contentText(body).includes(PROMPT)) throw new Error("REQUEST_PROMPT_MISMATCH")
  const system = {
    instructions: body.instructions ?? null,
    messages: (body.input ?? []).filter((item) => ["system", "developer"].includes(item?.role)),
  }
  return {
    body,
    model: body.model,
    effort: body.reasoning.effort,
    maxOutputTokens: body.max_output_tokens,
    requestSha256: sha256(raw),
    systemSha256: sha256(JSON.stringify(system)),
    toolsSha256: sha256(JSON.stringify(body.tools)),
    toolCount: body.tools.length,
    firstSystemBlockSha256: sha256(JSON.stringify(body.instructions ?? system.messages[0] ?? null)),
    cacheKey: body.prompt_cache_key ?? null,
    requestBytes: Buffer.byteLength(raw),
  }
}

/** A grant is consumed on disk before forwarding, including failed/cancelled sends. */
export class SendFence {
  constructor(directory, origin) {
    this.directory = directory
    this.origin = origin
  }
  async reserve(url, init) {
    const destination = new URL(url instanceof Request ? url.url : url)
    const sessionID = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined)).get(
      "x-session-id",
    )
    const grants = await json(`${this.directory}/grants.json`)
    if (
      !Array.isArray(grants.sessions) ||
      grants.sessions.length !== 2 ||
      new Set(grants.sessions).size !== 2 ||
      grants.sessions.some((id) => !/^ses_[A-Za-z0-9_-]+$/.test(id))
    )
      throw new Error("INVALID_GRANTS")
    if (!grants.sessions.includes(sessionID)) throw new Error("SESSION_WITHOUT_GRANT")
    const ordinal = grants.sessions.indexOf(sessionID) + 1
    const file = `${this.directory}/grant-${ordinal}.json`
    const reserved = {
      sessionID,
      ordinal,
      attemptedAt: new Date().toISOString(),
      state: "reserved",
      usage: null,
      actualCostUsd: null,
    }
    const handle = await open(file, "wx", 0o600).catch((error) => {
      if (error.code === "EEXIST") throw new Error("SESSION_GRANT_EXHAUSTED")
      throw error
    })
    try {
      await handle.writeFile(JSON.stringify(reserved) + "\n")
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Persist the directory entry before a network send as well as the file contents (POSIX).
    if (process.platform !== "win32") {
      const directory = await open(this.directory, "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    try {
      if (
        destination.origin !== this.origin ||
        destination.pathname !== "/v1/responses" ||
        destination.search ||
        destination.hash ||
        destination.username ||
        destination.password ||
        (init?.method ?? (url instanceof Request ? url.method : "GET")) !== "POST"
      )
        throw new Error("REQUEST_ENDPOINT_MISMATCH")
      const shape = requestShape(init?.body)
      await writeFile(`${this.directory}/request-${ordinal}.json`, init.body, {
        flag: "wx",
        mode: 0o600,
      })
      const { body: _body, ...fields } = shape
      Object.assign(reserved, fields)
      await save(file, reserved)
      return { file, reserved }
    } catch (error) {
      await save(file, { ...reserved, state: "blocked", error: error.message })
      throw error
    }
  }
}

export async function capture(response, limit = MAX_RESPONSE) {
  const chunks = []
  let size = 0
  let failure = null
  const reader = response.body?.getReader()
  if (!reader) failure = "RESPONSE_BODY_MISSING"
  try {
    while (reader) {
      const item = await reader.read()
      if (item.done) break
      const room = limit - size
      chunks.push(item.value.subarray(0, room))
      size += Math.min(room, item.value.byteLength)
      if (item.value.byteLength > room) {
        failure = "RESPONSE_BYTE_LIMIT"
        break
      }
    }
  } catch {
    failure = "RESPONSE_STREAM_FAILED"
  }
  if (failure) await reader?.cancel().catch(() => {})
  const bytes = Buffer.concat(chunks)
  const events = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice(5))]
      } catch {
        return []
      }
    })
  const terminal = events.filter((event) => event.type === "response.completed")
  const usage = terminal.length === 1 ? terminal[0].response?.usage : undefined
  const counts = [
    usage?.input_tokens,
    usage?.input_tokens_details?.cached_tokens,
    usage?.output_tokens,
    usage?.output_tokens_details?.reasoning_tokens,
  ]
  const known =
    counts.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    counts[1] <= counts[0] &&
    counts[3] <= counts[2]
  const error =
    failure ??
    (response.status !== 200
      ? `HTTP_${response.status}`
      : terminal.length !== 1
        ? "TERMINAL_USAGE_MISSING"
        : terminal[0].response?.model !== MODEL || terminal[0].response?.status !== "completed"
          ? "TERMINAL_RESPONSE_MISMATCH"
          : !known
            ? "INVALID_USAGE"
            : null)
  return {
    bytes,
    evidence: {
      httpStatus: response.status,
      responseSha256: sha256(bytes),
      responseBytes: bytes.byteLength,
      error,
      usage: known
        ? {
            inputTokens: counts[0],
            cachedInputTokens: counts[1],
            outputTokens: counts[2],
            reasoningTokens: counts[3],
          }
        : null,
      actualCostUsd: null,
      synthetic: true,
    },
  }
}

/** Global fetch is wrapped before importing the bundle; its API-key adapter remains in charge of auth. */
export function installCapture(directory, providerOrigin) {
  const native = globalThis.fetch
  const fence = new SendFence(directory, providerOrigin)
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    // A misrouted model request must not escape the grant check just because its origin changed.
    let inference = /\/(responses|chat\/completions)$/.test(url.pathname)
    if (typeof init?.body === "string") {
      try {
        inference ||= typeof JSON.parse(init.body)?.model === "string"
      } catch {
        /* The expected endpoint still checks invalid JSON. */
      }
    }
    if (url.origin !== providerOrigin && !inference) return native(input, init)
    let grant
    try {
      grant = await fence.reserve(input, init)
      const response = await native(input, {
        ...init,
        signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
      })
      const result = await capture(response)
      await writeFile(`${directory}/response-${grant.reserved.ordinal}.sse`, result.bytes, { flag: "wx", mode: 0o600 })
      await save(grant.file, {
        ...grant.reserved,
        state: result.evidence.error ? "failed" : "recorded",
        ...result.evidence,
      })
      if (result.evidence.error) throw new Error(result.evidence.error)
      return new Response(result.bytes, {
        status: response.status,
        headers: response.headers,
      })
    } catch (error) {
      if (grant && (await json(grant.file)).state === "reserved")
        await save(grant.file, {
          ...grant.reserved,
          state: "failed",
          error: "FETCH_OR_CAPTURE_FAILED",
          usage: null,
          actualCostUsd: null,
        })
      await appendFile(
        `${directory}/blocked-sends.jsonl`,
        JSON.stringify({ at: new Date().toISOString(), code: error.message }) + "\n",
        { mode: 0o600 },
      )
      throw error
    }
  }
  return () => {
    globalThis.fetch = native
  }
}

export function responseEvents(ordinal, cached = ordinal === 2 ? 1024 : 0) {
  const item = {
    type: "message",
    id: `msg_offline_${ordinal}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: REPLY, annotations: [] }],
  }
  const response = {
    id: `resp_offline_${ordinal}`,
    object: "response",
    created_at: 0,
    model: MODEL,
    status: "completed",
    output: [item],
    usage: {
      input_tokens: 2048,
      input_tokens_details: { cached_tokens: cached },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 2056,
    },
  }
  const at = { item_id: item.id, output_index: 0, content_index: 0 }
  return [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      ...at,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", ...at, delta: REPLY },
    { type: "response.output_text.done", ...at, text: REPLY },
    { type: "response.content_part.done", ...at, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")
}

export function selectProcesses(text, rootPID, tracked = new Map()) {
  const processes = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, rss, ...start] = line.trim().split(/\s+/)
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        rssKiB: Number(rss),
        start: start.join(" "),
      }
    })
    .filter(
      (item) => Number.isSafeInteger(item.pid) && item.pid > 0 && Number.isFinite(item.rssKiB) && item.rssKiB >= 0,
    )
  const ids = new Set(
    processes
      .filter(
        (item) =>
          (item.pid === rootPID && (!tracked.has(rootPID) || tracked.get(rootPID) === item.start)) ||
          tracked.get(item.pid) === item.start,
      )
      .map((item) => item.pid),
  )
  for (let prior = -1; prior !== ids.size; ) {
    prior = ids.size
    processes.filter((item) => ids.has(item.ppid)).forEach((item) => ids.add(item.pid))
  }
  const selected = processes.filter((item) => ids.has(item.pid))
  selected.forEach((item) => tracked.set(item.pid, item.start))
  return selected
}

export const MEMORY_PHASES = ["startup", "idle", "session-1", "session-2", "settled"]

export function summarizeMemory(samples, errors) {
  const observed = samples.filter((sample) => sample.processes.length && Number.isFinite(sample.rssKiB))
  const missingPhases = MEMORY_PHASES.filter((phase) => !observed.some((sample) => sample.phase === phase))
  return {
    complete: !missingPhases.length && !errors.length,
    missingPhases,
    sampledPeakProcessTreeRssKiB: observed.length ? Math.max(...observed.map((sample) => sample.rssKiB)) : null,
    phases: Object.fromEntries(
      MEMORY_PHASES.map((phase) => {
        const found = observed.filter((sample) => sample.phase === phase)
        return [
          phase,
          {
            sampleCount: samples.filter((sample) => sample.phase === phase).length,
            processSampleCount: found.length,
            sampledPeakRssKiB: found.length ? Math.max(...found.map((sample) => sample.rssKiB)) : null,
          },
        ]
      }),
    ),
    samples,
    errors,
  }
}

export function startSampler(pid, phase, { run = execute, intervalMs = 100 } = {}) {
  const start = performance.now()
  const samples = []
  const errors = []
  const tracked = new Map()
  let pending
  const sample = () => {
    // Explicit boundary samples must not reuse an in-flight sample from the previous phase.
    const name = phase()
    const current = (pending ?? Promise.resolve())
      .then(() =>
        run("ps", ["-axo", "pid=,ppid=,rss=,lstart="], {
          maxBuffer: 4 * 1024 * 1024,
          timeout: 5000,
        }),
      )
      .then(({ stdout }) => {
        const processes = selectProcesses(stdout, pid, tracked)
        samples.push({
          atMs: performance.now() - start,
          phase: name,
          rssKiB: processes.length ? processes.reduce((sum, item) => sum + item.rssKiB, 0) : null,
          processes,
        })
      })
      .catch((error) =>
        errors.push({
          atMs: performance.now() - start,
          phase: name,
          code: error.code ?? "PS_FAILED",
        }),
      )
      .finally(() => {
        if (pending === current) pending = undefined
      })
    pending = current
    return current
  }
  void sample()
  const timer = setInterval(() => {
    if (!pending) void sample()
  }, intervalMs)
  return {
    sample,
    samples,
    errors,
    stop: async () => {
      clearInterval(timer)
      await pending
      return { samples, errors }
    },
  }
}
