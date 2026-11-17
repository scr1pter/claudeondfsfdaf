// Actual CLI acceptance against isolated production share handlers and disposable storage.
// bun script/verify-sharing.ts <synthetic-backend-state.json> [compiled-binary]
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { connect } from "node:net"
import os from "node:os"
import path from "node:path"

const backend = (await Bun.file(process.argv[2]!).json()) as {
  synthetic: boolean
  origin: string
  owner: string
  token: string
}
assert.equal(backend.synthetic, true, "Use the disposable share acceptance backend, never a production account.")
const origin = new URL(backend.origin)
assert.equal(origin.protocol, "http:")
assert.equal(origin.hostname, "127.0.0.1")
assert.match(backend.token, /^vct_/)
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-share-acceptance-")))
const project = path.join(home, "sample")
const model = "qwen/qwen3.8-27b:free"
const source = "A harmless visible fixture file.\n"
await Bun.write(path.join(project, "notes.txt"), source)
await Bun.write(path.join(project, "vector.json"), JSON.stringify({ share: "auto", autoshare: true }))
const git = Bun.spawn(["git", "init", "--quiet", project], {
  env: { HOME: home, PATH: "/usr/bin:/bin" },
  stdout: "ignore",
  stderr: "pipe",
})
assert.equal(await git.exited, 0, await new Response(git.stderr).text())
for (const args of [
  ["add", "."],
  ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"],
]) {
  const child = Bun.spawn(["git", "-C", project, ...args], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    stdout: "ignore",
    stderr: "pipe",
  })
  assert.equal(await child.exited, 0, await new Response(child.stderr).text())
}
const certificate = path.join(home, "cert.pem")
const key = path.join(home, "key.pem")
const openssl = Bun.which("openssl")
assert(openssl)
const ca = Bun.spawn(
  [
    openssl,
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "1",
    "-subj",
    "/CN=Vector sharing acceptance",
    "-addext",
    "subjectAltName=DNS:vectordev.ai,DNS:api.github.com",
  ],
  { stdout: "ignore", stderr: "pipe" },
)
assert.equal(await ca.exited, 0, await new Response(ca.stderr).text())
const requests: Array<{ method: string; path: string; status?: number; kind: string }> = []
const denied: string[] = []
const failures: string[] = []
const stream = (text: string, tool?: { name: string; arguments: Record<string, unknown> }) =>
  new Response(
    [
      {
        id: "sharing-fixture",
        choices: [
          {
            delta: tool
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "read-sharing-fixture",
                      type: "function",
                      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
                    },
                  ],
                }
              : { role: "assistant", content: text },
          },
        ],
      },
      {
        id: "sharing-fixture",
        choices: [{ delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 5 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  async fetch(request) {
    const url = new URL(request.url)
    if (url.hostname === "api.github.com" && request.method === "GET" && url.pathname === "/repos/fixture/project") {
      assert.equal(request.headers.get("authorization"), "token ghp_synthetic_fixture")
      requests.push({ method: request.method, path: url.pathname, kind: "fixture-github-metadata" })
      return Response.json({ default_branch: "main", full_name: "fixture/project" })
    }
    assert.equal(url.hostname, "vectordev.ai")
    if (url.pathname === "/api/account/cli-verify") {
      assert.deepEqual(await request.json(), { token: backend.token })
      requests.push({ method: request.method, path: url.pathname, kind: "fixture-login" })
      return Response.json({ ok: true, user: { id: backend.owner, email: "fixture@example.invalid" } })
    }
    if (url.pathname === "/api/org/keys") {
      assert.equal(request.method, "GET")
      assert.equal(request.headers.get("authorization"), null)
      requests.push({ method: request.method, path: url.pathname, status: 503, kind: "fixture-teams-disabled" })
      return Response.json(
        { error: { code: "TEAMS_NOT_CONFIGURED", message: "Vector Teams is not enabled or configured." } },
        { status: 503 },
      )
    }
    if (/^\/api\/shares(?:\/[a-f0-9]{32})?$/.test(url.pathname)) {
      assert.equal(request.headers.get("authorization"), request.method === "GET" ? null : `Bearer ${backend.token}`)
      const response = await fetch(`${origin.origin}${url.pathname}`, {
        method: request.method,
        headers: {
          ...(request.headers.has("authorization") ? { authorization: request.headers.get("authorization")! } : {}),
          ...(request.method === "GET" ? {} : { "content-type": "application/json" }),
        },
        ...(request.method === "GET" ? {} : { body: await request.text() }),
        redirect: "error",
      })
      requests.push({
        method: request.method,
        path: url.pathname,
        status: response.status,
        kind: "production-share-handler",
      })
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
    }
    if (url.pathname === "/api/free-models/models") {
      requests.push({ method: request.method, path: url.pathname, kind: "fixture-catalog" })
      return Response.json({
        enabled: true,
        updatedAt: Date.now(),
        models: [
          {
            id: model,
            name: "Sharing fixture",
            contextLength: 131072,
            maxOutputTokens: 4096,
            providers: [{ id: "modelrun", name: "Fixture", retention: "Local test only" }],
          },
        ],
      })
    }
    if (url.pathname === "/api/free-models/chat") {
      assert.equal(request.headers.get("authorization"), `Bearer ${backend.token}`)
      const body = (await request.json()) as { model: string; messages: unknown; provider: { max_price: unknown } }
      assert.equal(body.model, model)
      assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 })
      const text = JSON.stringify(body.messages)
      const title = text.includes("Generate a title for this conversation:")
      requests.push({ method: request.method, path: url.pathname, kind: title ? "fixture-title" : "fixture-model" })
      if (title) return stream("Sharing acceptance conversation")
      if (text.includes(source.trim()) && text.includes('"role":"tool"')) return stream("Shared fixture answer.")
      return stream("", { name: "read", arguments: { filePath: path.join(project, "notes.txt") } })
    }
    denied.push(url.href)
    return new Response("Unexpected endpoint", { status: 403 })
  },
  error(error) {
    failures.push(error.message)
    return new Response("Fixture failed", { status: 500 })
  },
})
const proxy = createServer((_request, response) => response.writeHead(403).end())
proxy.on("connect", (request, client, head) => {
  if (!["vectordev.ai:443", "api.github.com:443"].includes(request.url ?? "")) {
    denied.push(request.url ?? "")
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    return
  }
  const socket = connect(upstream.port!, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head.length) socket.write(head)
    client.pipe(socket)
    socket.pipe(client)
  })
  socket.on("error", () => client.destroy())
  client.on("error", () => socket.destroy())
})
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
const address = proxy.address()
assert(address && typeof address !== "string")
const proxyURL = `http://127.0.0.1:${address.port}`
const command = process.argv[3]
  ? [path.resolve(process.argv[3])]
  : [process.execPath, "run", "--conditions=browser", path.resolve(import.meta.dir, "../src/index.ts")]
const env = {
  HOME: home,
  PATH: `${path.join(home, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  VECTOR_TEST_HOME: home,
  VECTOR_CLI: "1",
  VECTOR_PURE: "1",
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  XDG_STATE_HOME: path.join(home, "state"),
  VECTOR_CLI_TOKEN: backend.token,
  VECTOR_DISABLE_AUTOUPDATE: "1",
  VECTOR_DISABLE_CHANNEL_DB: "1",
  VECTOR_DISABLE_LSP_DOWNLOAD: "1",
  VECTOR_DISABLE_AUTOCOMPACT: "1",
  VECTOR_MODELS_PATH: path.resolve(import.meta.dir, "../test/tool/fixtures/models-api.json"),
  VECTOR_CONFIG_CONTENT: JSON.stringify({
    lsp: false,
    formatter: false,
    snapshot: false,
    permission: { read: "allow" },
  }),
  VECTOR_SERVER_USERNAME: "vector",
  VECTOR_SERVER_PASSWORD: "sharing-fixture-password",
  HTTPS_PROXY: proxyURL,
  https_proxy: proxyURL,
  HTTP_PROXY: proxyURL,
  http_proxy: proxyURL,
  ALL_PROXY: proxyURL,
  all_proxy: proxyURL,
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
  NODE_EXTRA_CA_CERTS: certificate,
}
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = []
const logs: Array<{ stage: string; durationMs: number; code: number; stdout: string; stderr: string }> = []
const spawn = (args: string[], overrides: Record<string, string> = {}) => {
  const child = Bun.spawn([...command, ...args], {
    cwd: project,
    env: { ...env, ...overrides },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  return child
}
const run = async (stage: string, args: string[], expected = 0, overrides: Record<string, string> = {}) => {
  const start = performance.now()
  const child = spawn(args, overrides)
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer))
  assert.ok(
    !stdout.includes(backend.token) && !stderr.includes(backend.token),
    "Synthetic credential must never be logged",
  )
  logs.push({ stage, durationMs: Math.round(performance.now() - start), code, stdout, stderr })
  assert.equal(code, expected, `${stage}: ${stderr}\n${stdout}`)
  return { stdout, stderr }
}
const shareRequests = () => requests.filter((request) => request.kind === "production-share-handler")
const modelRequests = () =>
  requests.filter((request) => request.kind === "fixture-model" || request.kind === "fixture-title").length
const jsonLines = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const progress = { stage: "untrusted auto config", success: false }
try {
  await run("synthetic-cli-login", ["login", "--token", backend.token])
  await run("project-auto-is-not-consent", ["run", "Read notes.txt and answer.", "--format", "json"])
  assert.equal(
    shareRequests().length,
    0,
    "A repository's share:auto/autoshare preference must never authorize an upload",
  )
  progress.stage = "explicit publication"
  const published = await run("run-share", [
    "run",
    "Read notes.txt and share this conversation.",
    "--share",
    "--format",
    "json",
  ])
  const event = jsonLines(published.stdout).find((event) => event.type === "share")
  assert(event)
  assert.match(event.share.url, /^https:\/\/vectordev\.ai\/s\/[a-f0-9]{32}$/)
  const id = event.share.id as string
  const sessionID = event.sessionID as string
  const read = async () => {
    const response = await fetch(`${origin.origin}/api/shares/${id}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    return response.json()
  }
  const first = await read()
  assert.equal(first.archive.title, "Sharing acceptance conversation")
  assert.ok(
    first.archive.messages.some((message: { parts: { type: string; output?: string }[] }) =>
      message.parts.some((part) => part.type === "tool" && part.output?.includes(source.trim())),
    ),
  )
  assert.ok(JSON.stringify(first.archive).includes("Shared fixture answer."))
  assert.ok(!JSON.stringify(first).includes(backend.token) && !JSON.stringify(first).includes(backend.owner))
  assert.equal(Object.keys(first).sort().join(","), "archive,expiresAt,id,revision,updatedAt,updates,url")
  assert.equal(shareRequests().filter((request) => request.method === "POST").length, 1)

  progress.stage = "continued updates"
  await run("continue-shared-session", ["run", "CONTINUED_SHARED_HISTORY", "--session", sessionID, "--format", "json"])
  const continued = await read()
  assert.ok(JSON.stringify(continued.archive).includes("CONTINUED_SHARED_HISTORY"))
  assert.ok(continued.revision > first.revision)
  assert.equal(continued.url, first.url)
  const beforeImport = modelRequests()
  progress.stage = "remote import"
  const imported = await run("import-owned-url", ["import", event.share.url])
  const newID = imported.stdout.match(/Imported session: (ses_\S+)/)?.[1]
  assert(newID && newID !== sessionID)
  const exported = await run("export-imported-public", ["export", newID, "--public"])
  const archive = JSON.parse(exported.stdout)
  assert.equal(archive.messages.length, continued.archive.messages.length)
  assert.ok(JSON.stringify(archive).includes("CONTINUED_SHARED_HISTORY"))
  assert.equal(modelRequests(), beforeImport, "Import must not wake a model or replay tools")
  const local = await run("export-full-local", ["export", sessionID])
  const file = path.join(home, "local.json")
  await Bun.write(file, local.stdout)
  const restoredLocal = await run("import-local-archive", ["import", file])
  const localID = restoredLocal.stdout.match(/Imported session: (ses_\S+)/)?.[1]
  assert(localID && localID !== sessionID)
  const restoredExport = JSON.parse((await run("export-restored-local", ["export", localID])).stdout)
  assert.equal(restoredExport.messages.length, JSON.parse(local.stdout).messages.length)
  assert.ok(
    restoredExport.messages.some((message: { parts: { type: string; state?: { output?: string } }[] }) =>
      message.parts.some((part) => part.type === "tool" && part.state?.output?.includes(source.trim())),
    ),
  )
  assert.equal(modelRequests(), beforeImport)

  // Seed one native-engine portable transcript through the same real hosted API.
  const native = {
    id: randomBytes(16).toString("hex"),
    secret: randomBytes(32).toString("hex"),
    consent: { version: 1, public: true, updates: false },
    expiresAt: Date.now() + 86_400_000,
    archive: { ...continued.archive, engine: "v2" },
  }
  const nativeCreated = await fetch(`${origin.origin}/api/shares`, {
    method: "POST",
    headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
    body: JSON.stringify(native),
  })
  assert.equal(nativeCreated.status, 200)
  const nativeURL = `https://vectordev.ai/s/${native.id}`
  const nativeImported = await run("import-native-public-url", ["import", nativeURL])
  assert.ok(nativeImported.stdout.includes("portable v2 transcript into v1"))
  const nativeID = nativeImported.stdout.match(/Imported session: (ses_\S+)/)?.[1]
  assert(nativeID)
  const nativeVisible = JSON.parse((await run("export-native-public-import", ["export", nativeID])).stdout)
  assert.equal(nativeVisible.messages.length, continued.archive.messages.length)
  assert.ok(JSON.stringify(nativeVisible).includes("CONTINUED_SHARED_HISTORY"))

  progress.stage = "PR linked import"
  const launchFile = path.join(home, "launched.json")
  const prFile = path.join(home, "pr.json")
  await Bun.write(prFile, JSON.stringify({ body: `[Native public session](${nativeURL})`, isCrossRepository: false }))
  await Bun.write(
    path.join(home, "bin/gh"),
    `#!${process.execPath}\nif (process.argv[3] === "view") process.stdout.write(await Bun.file(${JSON.stringify(prFile)}).text())\n`,
  )
  await Bun.write(
    path.join(home, "bin/vector"),
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(launchFile)}, JSON.stringify(process.argv.slice(2)))\n`,
  )
  await chmod(path.join(home, "bin/gh"), 0o755)
  await chmod(path.join(home, "bin/vector"), 0o755)
  const prImported = await run("pr-import", ["pr", "7"])
  assert.ok((prImported.stdout + prImported.stderr).includes("portable v2 transcript into v1"))
  const launched = await Bun.file(launchFile).json()
  assert.equal(launched[0], "--session")
  assert.match(launched[1], /^ses_/)
  assert.notEqual(launched[1], sessionID)
  const prHistory = JSON.parse((await run("export-pr-import", ["export", launched[1]])).stdout)
  assert.equal(prHistory.messages.length, continued.archive.messages.length)
  assert.equal(modelRequests(), beforeImport)
  const nativeDeleted = await fetch(`${origin.origin}/api/shares/${native.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
    body: JSON.stringify({ secret: native.secret }),
  })
  assert.equal(nativeDeleted.status, 200)
  const gets = shareRequests().filter((request) => request.method === "GET").length
  await Bun.write(
    prFile,
    JSON.stringify({ body: `[Untrusted](https://foreign.invalid/s/${id})`, isCrossRepository: false }),
  )
  await run("pr-ignores-foreign-url", ["pr", "8"])
  assert.deepEqual(await Bun.file(launchFile).json(), [])
  assert.equal(shareRequests().filter((request) => request.method === "GET").length, gets)
  await run("reject-foreign-import", ["import", `https://foreign.invalid/s/${id}`], 1)
  await run("reject-query-import", ["import", `${event.share.url}?secret=forbidden`], 1)
  assert.equal(shareRequests().filter((request) => request.method === "GET").length, gets)

  progress.stage = "unshare"
  const server = spawn(["serve", "--hostname", "127.0.0.1", "--port", "0"])
  const serverError = new Response(server.stderr).text()
  const ready = Promise.withResolvers<string>()
  const output: string[] = []
  const stdout = (async () => {
    const reader = server.stdout.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      output.push(new TextDecoder().decode(chunk.value))
      const url = output.join("").match(/listening on (http:\/\/\S+)/)?.[1]
      if (url) ready.resolve(url)
    }
    ready.reject(new Error("Serve exited before startup"))
  })()
  const timer = setTimeout(() => ready.reject(new Error("Serve startup timed out")), 15_000)
  const localURL = await ready.promise.finally(() => clearTimeout(timer))
  const removed = await fetch(`${localURL}/session/${sessionID}/share`, {
    method: "DELETE",
    headers: { authorization: `Basic ${btoa("vector:sharing-fixture-password")}` },
  })
  assert.equal(removed.status, 200, await removed.text())
  assert.equal((await fetch(`${origin.origin}/api/shares/${id}`)).status, 404)
  server.kill()
  await server.exited
  await stdout
  assert.ok(!(await serverError).includes(backend.token))
  const writes = shareRequests().filter((request) => request.method !== "GET").length
  await run("continue-after-unshare", ["run", "AFTER_UNSHARE", "--session", sessionID, "--format", "json"])
  assert.equal(shareRequests().filter((request) => request.method !== "GET").length, writes)
  assert.equal((await fetch(`${origin.origin}/api/shares/${id}`)).status, 404)
  progress.stage = "GitHub consent"
  // Earlier CLI setup may create project metadata; begin each task on a clean fixture repository.
  for (const args of [
    ["add", "."],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture metadata",
    ],
  ]) {
    const child = Bun.spawn(["git", "-C", project, ...args], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      stdout: "ignore",
      stderr: "pipe",
    })
    assert.equal(await child.exited, 0, await new Response(child.stderr).text())
  }
  const githubArgs = [
    "github",
    "run",
    "--event",
    JSON.stringify({ eventName: "workflow_dispatch", payload: {}, repo: { owner: "fixture", repo: "project" } }),
    "--token",
    "ghp_synthetic_fixture",
  ]
  const githubEnv = {
    GITHUB_RUN_ID: "12345",
    GITHUB_ACTIONS: "true",
    VECTOR_WORKFLOW_VERSION: "3",
    MODEL: `vector/${model}`,
    PROMPT: "Read notes.txt and answer without changing files.",
  }
  const beforeGithub = shareRequests().filter((request) => request.method === "POST").length
  await run("github-share-false", githubArgs, 0, { ...githubEnv, SHARE: "false", VECTOR_SHARE_CONSENT: "1" })
  assert.equal(shareRequests().filter((request) => request.method === "POST").length, beforeGithub)
  await run("github-inherited-share-true", githubArgs, 0, { ...githubEnv, SHARE: "true", VECTOR_SHARE_CONSENT: "" })
  assert.equal(shareRequests().filter((request) => request.method === "POST").length, beforeGithub)
  const githubShared = await run("github-explicit-share", githubArgs, 0, {
    ...githubEnv,
    SHARE: "true",
    VECTOR_SHARE_CONSENT: "1",
  })
  assert.equal(shareRequests().filter((request) => request.method === "POST").length, beforeGithub + 1)
  const githubShareID = githubShared.stdout.match(/Public session: https:\/\/vectordev\.ai\/s\/([a-f0-9]{32})/)?.[1]
  assert(githubShareID)
  const githubArchive = await (await fetch(`${origin.origin}/api/shares/${githubShareID}`)).json()
  assert.ok(JSON.stringify(githubArchive.archive).includes("Shared fixture answer."))
  assert.equal(githubArchive.archive.title, "Sharing acceptance conversation")
  assert.deepEqual(denied, [])
  assert.deepEqual(failures, [])
  progress.success = true
  progress.stage = "complete"
  console.log(
    JSON.stringify(
      {
        ...progress,
        binary: process.argv[3] ?? "source",
        ...(process.argv[3]
          ? {
              sha256: createHash("sha256")
                .update(new Uint8Array(await Bun.file(process.argv[3]).arrayBuffer()))
                .digest("hex"),
            }
          : {}),
        backend: "real handlers, disposable PostgreSQL and Valkey",
        shareURL: event.share.url,
        firstRevision: first.revision,
        continuedRevision: continued.revision,
        sessionID,
        importedSessionID: newID,
        requests,
        timings: logs.map(({ stage, durationMs, code }) => ({ stage, durationMs, code })),
        denied,
        failures,
      },
      null,
      2,
    ),
  )
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL")
  await Promise.all(children.map((child) => child.exited))
  proxy.closeAllConnections()
  proxy.close()
  await upstream.stop(true)
  if (process.env.VECTOR_SHARING_EVIDENCE) {
    await Bun.write(
      process.env.VECTOR_SHARING_EVIDENCE,
      JSON.stringify({ ...progress, logs, requests, denied, failures }, null, 2),
    )
  }
  await rm(home, { recursive: true, force: true })
}
