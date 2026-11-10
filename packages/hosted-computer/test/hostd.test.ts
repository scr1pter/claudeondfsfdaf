import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { agentCommand, agentEnv, browserCommand, cpuReader, createAgentApi, parseArgs, parseEgressCounter, type ApiDeps } from "../src/hostd"
import { GitError } from "../src/git"
import { HeartbeatError, RunApi, type Transport } from "../src/run-api"
import { Hosted } from "@vectordevai/schema/hosted"

// WP A54: hostd takes boot.sh's two arguments and nothing else; starts the agent as uid 10001 with no privilege and no
// secret in its environment; starts the browser with its sandbox on and the debugging pipe for hostd alone; reports
// through the run-API host with no browser-shaped header and no credential (S7); and answers the agent on its socket.

const SESSION = `hs_${"f".repeat(26)}`
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("boot arguments", () => {
  test("exactly --run-host <host> --session <id>", () => {
    expect(parseArgs(["--run-host", "hosted-run.vectordev.ai", "--session", SESSION])).toEqual({ runHost: "hosted-run.vectordev.ai", session: SESSION })
    for (const argv of [
      ["--session", SESSION, "--run-host", "hosted-run.vectordev.ai"],
      ["--run-host", "hosted-run.vectordev.ai", "--session", SESSION, "--token", "x"],
      ["--run-host", "http://evil.example", "--session", SESSION],
      ["--run-host", "hosted-run.vectordev.ai", "--session", "hs_short"],
      ["--run-host", "localhost", "--session", SESSION],
    ])
      expect(() => parseArgs(argv)).toThrow()
  })
})

describe("the agent and the browser", () => {
  test("the agent runs as 10001 with no new privileges, no capabilities and only the share group", () => {
    const command = agentCommand({ prompt: "--help; rm -rf /", title: "Fix" })
    expect(command.slice(0, 9)).toEqual([
      "/usr/bin/setpriv",
      "--reuid=10001",
      "--regid=10001",
      "--groups=10010",
      "--no-new-privs",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "--",
    ])
    // The prompt comes after "--", so it is always the message and never read as an option.
    expect(command.slice(-2)).toEqual(["--", "--help; rm -rf /"])
    expect(command).toContain("/usr/local/bin/vector")
    expect(command.join(" ")).not.toMatch(/sudo|doas/)
  })

  test("the agent's environment says where things are and holds no secret", () => {
    const env = agentEnv({ runHost: "hosted-run.vectordev.ai", session: SESSION })
    expect(env).toMatchObject({ HOME: "/data/home", VECTOR_HOSTED_SESSION: SESSION, VECTOR_COMPUTER_SOCKET: "/run/vector/hostd/actions.sock" })
    for (const [name, value] of Object.entries(env)) {
      expect(name).not.toMatch(/TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL/i)
      expect(value).not.toMatch(/^(vht_|vrt_|vct_|ghs_|gho_|sk_)/)
    }
  })

  test("the browser keeps its own sandbox, runs as 10004, and is driven over a pipe, never a port", () => {
    const command = browserCommand()
    expect(command).toContain("--reuid=10004")
    expect(command).toContain("--remote-debugging-pipe")
    expect(command).toContain("--user-data-dir=/run/vector/browser/profile")
    expect(command.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false)
    expect(command).not.toContain("--no-sandbox")
    expect(command).not.toContain("--disable-web-security")
  })
})

describe("reports to Vector (S7)", () => {
  function capture(status = 200, body: unknown = { state: "running", control: "agent", deadline: 1, browser: true, viewerKey: "k".repeat(43) }) {
    const sent: Parameters<Transport>[0][] = []
    const transport: Transport = async (input) => {
      sent.push(input)
      return { status, body: Buffer.from(JSON.stringify(body)) }
    }
    return { sent, transport }
  }

  test("a heartbeat goes to the session's own path on the run-API host with no browser header and no credential", async () => {
    const t = capture()
    const key = Buffer.alloc(32, 7)
    const api = new RunApi("hosted-run.vectordev.ai", SESSION, t.transport, "vector-hostd", key)
    expect(await api.heartbeat({ booted: true, generation: 2 })).toMatchObject({ state: "running" })
    const sent = t.sent[0]!
    expect(sent).toMatchObject({ method: "POST", host: "hosted-run.vectordev.ai", path: `/api/hosted/sessions/${SESSION}/heartbeat` })
    expect(Object.keys(sent.headers).sort()).toEqual(["accept", "content-length", "content-type", "user-agent"])
    const { mac, ...signed } = JSON.parse((sent.body as Buffer).toString())
    expect(signed).toEqual({ booted: true, generation: 2, hostdKey: key.toString("base64url") })
    expect(mac).toBe(createHmac("sha256", key).update(Hosted.hostdMacInput(SESSION, signed)).digest("base64url"))
  })

  test("every heartbeat is signed with hostd's own key, which it sends only until a beat is answered (P8 review)", async () => {
    let status = 503
    const sent: Record<string, unknown>[] = []
    const transport: Transport = async (input) => {
      sent.push(JSON.parse((input.body as Buffer).toString()))
      const body = status === 200 ? { state: "running", control: "agent", deadline: 1, browser: true, viewerKey: "k".repeat(43) } : {}
      return { status, body: Buffer.from(JSON.stringify(body)) }
    }
    const api = new RunApi("hosted-run.vectordev.ai", SESSION, transport)
    await expect(api.heartbeat({ cpu: 1 })).rejects.toBeInstanceOf(HeartbeatError)
    status = 200
    await api.heartbeat({ cpu: 2 })
    await api.heartbeat({ cpu: 3, hostdKey: "x".repeat(43), mac: "y".repeat(43) })
    // The key went out until the server answered once, the same key each time, and never again after.
    expect(sent.map((body) => typeof body.hostdKey)).toEqual(["string", "string", "undefined"])
    expect(sent[0]!.hostdKey).toBe(sent[1]!.hostdKey)
    expect(Hosted.HOSTD_KEY.test(String(sent[0]!.hostdKey))).toBe(true)
    const key = Buffer.from(String(sent[0]!.hostdKey), "base64url")
    for (const body of sent) {
      const { mac, ...signed } = body
      expect(Hosted.HOSTD_MAC.test(String(mac))).toBe(true)
      expect(mac).toBe(createHmac("sha256", key).update(Hosted.hostdMacInput(SESSION, signed)).digest("base64url"))
    }
    // A report can never carry a key or signature of its own.
    expect(sent[2]).toMatchObject({ cpu: 3 })
    expect(sent[2]!.mac).not.toBe("y".repeat(43))
    // Each RunApi makes a key of its own.
    const other = new RunApi("hosted-run.vectordev.ai", SESSION, transport)
    await other.heartbeat({})
    expect(sent[3]!.hostdKey).not.toBe(sent[0]!.hostdKey)
  })

  test("a refusal carries its status and code", async () => {
    const api = new RunApi("hosted-run.vectordev.ai", SESSION, capture(409, { error: { code: "HOSTED_SESSION_ENDED" } }).transport)
    const error = await api.heartbeat({}).catch((caught) => caught)
    expect(error).toBeInstanceOf(HeartbeatError)
    expect(error).toMatchObject({ status: 409, code: "HOSTED_SESSION_ENDED" })
  })

  test("an upload goes only to an https link, with the link's headers minus any credential header", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vector-upload-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = path.join(dir, "files.tar.gz")
    writeFileSync(file, Buffer.alloc(100))
    const t = capture()
    const api = new RunApi("hosted-run.vectordev.ai", SESSION, t.transport)
    await api.upload({ url: "https://bucket.r2.example.test/hosted/x?X-Amz-Signature=1", headers: { "content-type": "application/gzip", Cookie: "a=b" }, expiresAt: 1 }, file)
    expect(t.sent[0]).toMatchObject({ method: "PUT", host: "bucket.r2.example.test", path: "/hosted/x?X-Amz-Signature=1" })
    expect(t.sent[0]!.headers).toEqual({ "content-type": "application/gzip", "content-length": "100" })
    for (const url of ["http://bucket.example.test/x", "https://127.0.0.1/x", "https://bucket.example.test:8443/x"])
      await expect(api.upload({ url, headers: {}, expiresAt: 1 }, file)).rejects.toThrow()
  })

  test("the run-API host must be a host name", () => {
    expect(() => new RunApi("http://hosted-run.vectordev.ai", SESSION)).toThrow()
    expect(() => new RunApi("10.0.0.1", SESSION)).toThrow()
  })
})

describe("meters", () => {
  test("egress comes from the firewall's counter", () => {
    const json = JSON.stringify({ nftables: [{ metainfo: {} }, { counter: { family: "inet", name: "egress", table: "vector", packets: 9, bytes: 123456 } }] })
    expect(parseEgressCounter(json)).toBe(123456)
    expect(parseEgressCounter("{}")).toBeUndefined()
    expect(parseEgressCounter("nope")).toBeUndefined()
  })

  test("the processor's busy share comes from /proc/stat between readings", () => {
    const lines = ["cpu  100 0 100 800 0 0 0 0 0 0", "cpu  150 0 150 900 0 0 0 0 0 0"]
    const read = cpuReader(() => lines.shift() ?? "")
    expect(read()).toBeUndefined()
    expect(read()).toBe(50)
  })
})

describe("the agent's socket", () => {
  async function serve(deps: Partial<ApiDeps> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "vector-hostd-"))
    const socketPath = path.join(dir, "actions.sock")
    const seen: string[] = []
    const server = createAgentApi({
      computer: { execute: async (input) => ({ ok: true, action: input.action }) },
      tools: {
        begin: async (id, pgid) => {
          seen.push(`begin ${id} ${pgid ?? ""}`.trim())
        },
        end: async (id) => {
          seen.push(`end ${id}`)
          return 2
        },
      },
      git: {
        clone: async () => "/data/work/app",
        fetch: async () => {},
        push: async () => {
          throw new GitError("Vector pushes only to branches named vector/…")
        },
      },
      daemon: { acting: () => true, status: () => ({ booted: true, done: false, control: "agent", wrapping: false, browser: true }), touch: () => seen.push("touch") },
      ...deps,
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    cleanups.push(() => {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const call = (method: string, pathname: string, body?: unknown) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = request({ socketPath, method, path: pathname, headers: { "content-type": "application/json" } }, (response) => {
          let text = ""
          response.on("data", (chunk) => (text += chunk))
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }))
        })
        req.on("error", reject)
        req.end(body === undefined ? undefined : JSON.stringify(body))
      })
    return { call, seen }
  }

  test("computer actions in the local format, checked before they run", async () => {
    const s = await serve()
    expect(await s.call("POST", "/v1/computer", { v: 1, input: { action: "screenshot" } })).toEqual({ status: 200, body: { ok: true, action: "screenshot" } })
    expect((await s.call("POST", "/v1/computer", { v: 2, input: { action: "screenshot" } })).status).toBe(400)
    expect((await s.call("POST", "/v1/computer", { v: 1, input: { action: "screenshot", sneaky: 1 } })).status).toBe(400)
    expect(s.seen).toContain("touch")
  })

  test("tool-call bounds; the end reports how many leftover processes were killed", async () => {
    const s = await serve()
    expect((await s.call("POST", "/v1/tool", { phase: "begin", id: "call-1", pgid: 4242 })).body).toEqual({ ok: true })
    expect((await s.call("POST", "/v1/tool", { phase: "end", id: "call-1" })).body).toEqual({ ok: true, killed: 2 })
    expect(s.seen).toEqual(expect.arrayContaining(["begin call-1 4242", "end call-1"]))
    expect((await s.call("POST", "/v1/tool", { phase: "begin", id: "../x y" })).status).toBe(400)
  })

  test("git steps answer plainly, and are refused while the agent is not working", async () => {
    const s = await serve()
    expect((await s.call("POST", "/v1/git", { op: "clone", repository: { owner: "o", name: "app" }, directory: "app" })).body).toEqual({ ok: true, path: "/data/work/app" })
    expect((await s.call("POST", "/v1/git", { op: "push", repository: { owner: "o", name: "app" }, directory: "app", branch: "main" })).body).toEqual({
      ok: false,
      message: "Vector pushes only to branches named vector/…",
    })
    const paused = await serve({ daemon: { acting: () => false, status: () => ({ booted: true, done: false, control: "person", wrapping: false, browser: true }), touch: () => {} } })
    expect((await paused.call("POST", "/v1/git", { op: "fetch", repository: { owner: "o", name: "app" }, directory: "app" })).status).toBe(409)
  })

  test("status, and nothing else", async () => {
    const s = await serve()
    expect((await s.call("GET", "/v1/status")).body).toMatchObject({ booted: true, control: "agent" })
    expect((await s.call("POST", "/v1/shell", {})).status).toBe(404)
    expect((await s.call("GET", "/v1/computer")).status).toBe(405)
  })
})
