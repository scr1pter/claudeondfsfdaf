// Actual CLI + Git HTTP transport acceptance. All identities, accounts, credentials and repositories are synthetic.
// bun script/verify-github-app.ts [compiled-binary]
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { connect } from "node:net"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.homedir(), ".cache/vector-github-app-fixture-"))
const project = path.join(home, "project")
const repositories = path.join(home, "repositories")
const bare = path.join(repositories, "fixture/project.git")
const appToken = "ghs_vector_synthetic_app_fixture"
const accountToken = "vct_vector_synthetic_github_fixture"
const fallbackToken = "ghp_vector_synthetic_fallback_fixture"
const model = "qwen/qwen3.8-27b:free"
const certificate = path.join(home, "certificate.pem")
const key = path.join(home, "key.pem")
const baseEnv = { HOME: home, PATH: process.env.PATH!, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
async function command(args: string[], cwd = project, env: Record<string, string> = baseEnv) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  assert.equal(code, 0, `${args[0]} failed: ${stderr}`)
  return stdout.trim()
}
await mkdir(project)
await mkdir(path.dirname(bare), { recursive: true })
await command(["git", "init", "--bare", "--quiet", bare])
await command(["git", "--git-dir", bare, "config", "http.receivepack", "true"])
await command(["git", "init", "--quiet", "--initial-branch=main"])
await command(["git", "config", "user.name", "Original Fixture"])
await command(["git", "config", "user.email", "original@example.invalid"])
await Bun.write(path.join(project, "notes.txt"), "Before the fixture.\n")
await command(["git", "add", "."])
await command(["git", "commit", "--quiet", "-m", "Initial fixture"])
await command(["git", "remote", "add", "origin", bare])
await command(["git", "push", "--quiet", "origin", "main"])
await command(["git", "remote", "set-url", "origin", "https://github.com/fixture/project.git"])
const hook = path.join(project, ".git/hooks/pre-push")
const hookMarker = path.join(home, "hook-leaked-credential")
await Bun.write(hook, `#!/bin/sh\nenv > '${hookMarker}'\nexit 97\n`)
await chmod(hook, 0o755)
await command([
  "openssl",
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
  "/CN=Vector isolated GitHub fixture",
  "-addext",
  "subjectAltName=DNS:vectordev.ai,DNS:api.github.com,DNS:github.com",
])

const state = {
  mode: "success",
  issued: 0,
  revoked: 0,
  pushes: 0,
  heldGit: 0,
  models: 0,
  prs: 0,
  dispatches: 0,
  wrote: false,
}
const errors: string[] = []
const denied: string[] = []
const requests: { host: string; path: string; method: string }[] = []
const evidence: Record<string, unknown> = {}
const stream = (text: string, tool?: { name: string; arguments: Record<string, unknown> }) =>
  new Response(
    [
      {
        id: "fixture",
        choices: [
          {
            delta: tool
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "fixture-write",
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
        id: "fixture",
        choices: [{ delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 5 },
      },
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  async fetch(request) {
    const url = new URL(request.url)
    requests.push({ host: url.hostname, path: url.pathname, method: request.method })
    if (url.hostname === "github.com") {
      assert.equal(
        request.headers.get("authorization"),
        `basic ${Buffer.from(`x-access-token:${appToken}`).toString("base64")}`,
      )
      assert(url.pathname.startsWith("/fixture/project.git/"))
      if (state.mode === "cancel-push") {
        state.heldGit++
        return new Promise<Response>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })), { once: true }),
        )
      }
      if (url.pathname.endsWith("/git-receive-pack")) state.pushes++
      const child = Bun.spawn(["git", "http-backend"], {
        cwd: project,
        env: {
          ...baseEnv,
          GIT_PROJECT_ROOT: repositories,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: request.headers.get("content-length") ?? "",
          REMOTE_USER: "fixture-vector[bot]",
          GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
        },
        stdin: request.method === "GET" ? "ignore" : new Blob([await request.arrayBuffer()]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, data, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
      ])
      assert.equal(code, 0, stderr)
      const bytes = Buffer.from(data)
      const end = bytes.indexOf("\r\n\r\n")
      assert(end > 0)
      const headers = new Headers()
      let status = 200
      for (const line of bytes.subarray(0, end).toString().split("\r\n")) {
        const split = line.indexOf(":")
        if (line.slice(0, split).toLowerCase() === "status") {
          status = Number(
            line
              .slice(split + 1)
              .trim()
              .split(" ")[0],
          )
          continue
        }
        headers.append(line.slice(0, split), line.slice(split + 1).trim())
      }
      return new Response(bytes.subarray(end + 4), { status, headers })
    }
    if (url.hostname === "api.github.com") {
      if (url.pathname === "/installation/token" && request.method === "DELETE") {
        assert.equal(request.headers.get("authorization"), `Bearer ${appToken}`)
        state.revoked++
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/repos/fixture/project/pulls/7") {
        assert.equal(request.headers.get("authorization"), `token ${fallbackToken}`)
        return Response.json({
          base: { repo: { id: 12, full_name: "fixture/project" } },
          head: { repo: { id: 13, full_name: "fork/project" } },
        })
      }
      assert.equal(request.headers.get("authorization"), `token ${appToken}`)
      if (url.pathname === "/repos/fixture/project") {
        if (state.mode === "failure")
          return Response.json({ message: "Synthetic repository unavailable" }, { status: 403 })
        return Response.json({ id: 12, full_name: "fixture/project", default_branch: "main" })
      }
      if (url.pathname === "/repos/fixture/project/pulls") {
        if (request.method === "GET") return Response.json([])
        state.prs++
        return Response.json({ number: 17 })
      }
      if (url.pathname.includes("/dispatches")) {
        state.dispatches++
        return new Response(null, { status: 204 })
      }
    }
    if (url.hostname === "vectordev.ai") {
      if (url.pathname === "/api/github/token") {
        assert.equal(request.headers.get("authorization"), "Bearer synthetic-oidc")
        assert.deepEqual(await request.json(), { purpose: "task" })
        state.issued++
        return Response.json({
          token: appToken,
          repository: "fixture/project",
          repositoryId: "12",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          permissions: {
            contents: "write",
            pull_requests: "write",
            issues: "write",
            actions: "write",
            checks: "read",
            metadata: "read",
          },
          bot: { login: "fixture-vector[bot]", id: 123 },
        })
      }
      if (url.pathname === "/api/account/cli-verify")
        return Response.json({ ok: true, user: { id: "synthetic-owner", email: "fixture@example.invalid" } })
      if (url.pathname === "/api/free-models/models")
        return Response.json({
          enabled: true,
          updatedAt: Date.now(),
          models: [
            {
              id: model,
              name: "Fixture",
              contextLength: 131072,
              maxOutputTokens: 4096,
              providers: [{ id: "modelrun", name: "Fixture", retention: "Synthetic local fixture" }],
            },
          ],
        })
      if (url.pathname === "/api/free-models/chat") {
        const body = (await request.json()) as { messages: unknown }
        const text = JSON.stringify(body.messages)
        if (text.includes("Generate a title for this conversation:")) return stream("GitHub App fixture")
        state.models++
        if (state.mode === "cancel")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(": waiting\n\n"))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        if (text.includes("Summarize the following in less than 40 characters:")) return stream("Update fixture notes")
        if (state.wrote) return stream("Updated notes for the isolated fixture.")
        state.wrote = true
        return stream("", {
          name: "write",
          arguments: {
            filePath: path.join(project, state.mode === "cancel-push" ? "generated-cancel.txt" : "generated.txt"),
            content: "Updated by the isolated GitHub App fixture.\n",
          },
        })
      }
    }
    denied.push(url.href)
    return new Response("Unexpected fixture endpoint", { status: 403 })
  },
  error(error) {
    errors.push(error.message)
    return new Response("Fixture failed", { status: 500 })
  },
})
const proxy = createServer((request, response) => {
  if (request.url?.startsWith("/oidc?")) {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ value: "synthetic-oidc" }))
    return
  }
  response.writeHead(403).end()
})
proxy.on("connect", (request, client, head) => {
  if (!["vectordev.ai:443", "api.github.com:443", "github.com:443"].includes(request.url ?? "")) {
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
const invocation = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : [process.execPath, "run", "--conditions=browser", path.resolve(import.meta.dir, "../src/index.ts")]
const env = {
  ...baseEnv,
  VECTOR_TEST_HOME: home,
  VECTOR_CLI: "1",
  VECTOR_CLI_TOKEN: accountToken,
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  XDG_STATE_HOME: path.join(home, "state"),
  VECTOR_DISABLE_AUTOUPDATE: "1",
  VECTOR_DISABLE_CHANNEL_DB: "1",
  VECTOR_DISABLE_LSP_DOWNLOAD: "1",
  VECTOR_DISABLE_AUTOCOMPACT: "1",
  VECTOR_MODELS_PATH: path.resolve(import.meta.dir, "../test/tool/fixtures/models-api.json"),
  VECTOR_CONFIG_CONTENT: JSON.stringify({
    lsp: false,
    formatter: false,
    snapshot: false,
    permission: { "*": "allow" },
  }),
  GITHUB_ACTIONS: "true",
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_NUMBER: "1",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "vector_app",
  GITHUB_WORKFLOW: "vector",
  GITHUB_WORKSPACE: project,
  GITHUB_ACTOR: "fixture-owner",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "fixture/project",
  GITHUB_REPOSITORY_ID: "12",
  GITHUB_TOKEN: fallbackToken,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  VECTOR_GITHUB_AUTH: "app",
  VECTOR_WORKFLOW_VERSION: "3",
  VECTOR_REVIEW_AUTO: "1",
  ACTIONS_ID_TOKEN_REQUEST_URL: `${proxyURL}/oidc?fixture=1`,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request",
  MODEL: `vector/${model}`,
  PROMPT: "Update notes.txt with the isolated fixture result.",
  HTTPS_PROXY: proxyURL,
  https_proxy: proxyURL,
  HTTP_PROXY: proxyURL,
  http_proxy: proxyURL,
  ALL_PROXY: proxyURL,
  all_proxy: proxyURL,
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
  NODE_EXTRA_CA_CERTS: certificate,
  GIT_SSL_CAINFO: certificate,
}
const event = {
  eventName: "workflow_dispatch",
  repo: { owner: "fixture", repo: "project" },
  actor: "fixture-owner",
  runId: 1,
  payload: {},
}
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = []
const logs: { mode: string; code: number; stdout: string; stderr: string }[] = []
async function run(mode: string, eventValue = event) {
  state.mode = mode
  if (mode === "cancel-push") state.wrote = false
  const before = { ...state }
  const child = Bun.spawn([...invocation, "github", "run", "--event", JSON.stringify(eventValue)], {
    cwd: project,
    env: { ...env, GITHUB_EVENT_NAME: eventValue.eventName },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
  const output = new Response(child.stdout).text()
  const error = new Response(child.stderr).text()
  if (mode === "cancel" || mode === "cancel-push") {
    const deadline = Date.now() + 30_000
    const ready = () => (mode === "cancel" ? state.models > before.models : state.heldGit > before.heldGit)
    while (!ready() && Date.now() < deadline) await Bun.sleep(20)
    assert(ready(), "cancel fixture must reach the active model stream or Git request")
    child.kill("SIGTERM")
  }
  const [code, stdout, stderr] = await Promise.all([child.exited, output, error]).finally(() => clearTimeout(timer))
  const visible = `${stdout}\n${stderr}`
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n")
  assert(
    !visible.includes(appToken) && !visible.includes(accountToken),
    "A synthetic credential escaped masking commands",
  )
  logs.push({ mode, code, stdout: visible, stderr: "" })
  if (mode === "success") assert.equal(code, 0, visible)
  else assert.notEqual(code, 0, visible)
  assert.equal(await command(["git", "config", "--local", "user.name"]), "Original Fixture")
  assert.equal(await command(["git", "config", "--local", "user.email"]), "original@example.invalid")
  assert.equal(
    await Bun.file(hookMarker).exists(),
    false,
    "The repository pre-push hook must never receive credentials",
  )
  return { before, code }
}
try {
  await run("success")
  assert.equal(state.issued, 1)
  assert.equal(state.revoked, 1)
  assert.equal(state.pushes, 1)
  assert.equal(state.prs, 1)
  assert.equal(state.dispatches, 0)
  const branch = await command(["git", "branch", "--show-current"])
  assert.equal(
    await command(["git", "--git-dir", bare, "log", "-1", "--format=%an|%ae", `refs/heads/${branch}`]),
    "fixture-vector[bot]|123+fixture-vector[bot]@users.noreply.github.com",
  )
  evidence.success = {
    scopedPush: true,
    brandedCommit: true,
    hookDisabled: true,
    identityRestored: true,
    revoked: true,
    duplicateDispatches: state.dispatches,
  }
  const failure = await run("failure")
  assert.equal(state.revoked, failure.before.revoked + 1)
  evidence.failureCleanup = true
  const cancellation = await run("cancel")
  assert.equal(state.revoked, cancellation.before.revoked + 1)
  evidence.cancellationCleanup = true
  const cancelledPush = await run("cancel-push")
  assert.equal(cancelledPush.code, 143)
  assert.equal(state.revoked, cancelledPush.before.revoked + 1)
  assert.equal(state.pushes, cancelledPush.before.pushes)
  evidence.gitCancellationCleanup = true
  const fork = await run("fork", {
    ...event,
    eventName: "issue_comment",
    payload: {
      issue: { number: 7, pull_request: {} },
      comment: { id: 3, body: "/vector fix fixture", user: { login: "fixture-owner", type: "User" } },
    },
  })
  assert.equal(state.issued, fork.before.issued)
  assert.equal(state.models, fork.before.models)
  evidence.forkRejectedBeforeOidc = true
  assert.deepEqual(errors, [])
  assert.deepEqual(denied, [])
  evidence.successful = true
} finally {
  for (const child of children) child.kill("SIGKILL")
  upstream.stop(true)
  proxy.closeAllConnections()
  proxy.close()
  await Bun.write(path.join(home, "result.json"), JSON.stringify({ evidence, errors, denied, requests, logs }, null, 2))
  console.log(`GitHub App acceptance evidence: ${path.join(home, "result.json")}`)
  if (evidence.successful && process.env.VECTOR_KEEP_FIXTURE !== "1") await rm(home, { recursive: true, force: true })
}
