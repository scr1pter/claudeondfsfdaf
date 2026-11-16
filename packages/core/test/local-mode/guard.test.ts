import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import http from "node:http"
import https from "node:https"
import { createRequire } from "node:module"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import workerThreads from "node:worker_threads"
import { EgressAttribution } from "../../src/local-mode/attribution"
import { EgressGuard } from "../../src/local-mode/guard"
import { LocalPolicy } from "../../src/local-mode/policy"

// A documentation address (TEST-NET-2): never routed, so a guard that failed to block would hang, not reach anyone.
const OUTSIDE = "198.51.100.7"
// Taken before the guard is installed, as a module that kept its own reference would.
const capturedFetch = globalThis.fetch

const seen: {
  path: string
  method: string
  authorization: string | null
  body: string
  cookie: string | null
  proxyAuthorization: string | null
  /** The x-test-mark header, so a test reads only the requests it made, whatever an earlier one left on its way. */
  mark: string | null
}[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    seen.push({
      path: url.pathname,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
      cookie: request.headers.get("cookie"),
      proxyAuthorization: request.headers.get("proxy-authorization"),
      mark: request.headers.get("x-test-mark"),
    })
    if (url.pathname === "/out") return Response.redirect(`http://${OUTSIDE}/collect`, 302)
    if (url.pathname === "/hop") return Response.redirect("/landed", 302)
    if (url.pathname === "/see-other") return new Response(null, { status: 303, headers: { location: "/landed" } })
    if (url.pathname === "/keep") return new Response(null, { status: 307, headers: { location: "/landed" } })
    if (url.pathname === "/elsewhere") return Response.redirect(`http://localhost:${url.port}/landed`, 302)
    return new Response("here")
  },
})
afterAll(() => server.stop(true))
const at = (route = "/") => `http://127.0.0.1:${server.port}${route}`

describe("EgressGuard.local", () => {
  test("counts loopback in every spelling as this computer", () => {
    for (const host of [
      "localhost",
      "LOCALHOST.",
      "127.0.0.1",
      "127.1",
      "0x7f.1",
      "2130706433",
      "0177.0.0.1",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "[::ffff:7f00:1]",
      "0.0.0.0",
    ])
      expect({ host, local: EgressGuard.local(host) }).toEqual({ host, local: true })
  })

  test("counts the network and the internet as outside", () => {
    // A name under localhost may be answered by an upstream resolver, so its name alone does not keep it here.
    for (const host of [
      OUTSIDE,
      "10.0.0.5",
      "192.168.1.2",
      "100.64.0.1",
      "example.com",
      "127.0.0.1.example.com",
      "app.localhost",
      "",
    ])
      expect({ host, local: EgressGuard.local(host) }).toEqual({ host, local: false })
  })

  test("judges a whole name, never the part before a %", () => {
    // Only an IPv6 address has a zone; anywhere else the resolver would be asked for the whole name.
    for (const host of ["localhost%.evil.example", "127.0.0.1%evil.example", "localhost%25", "::1%lo0%x"])
      expect({ host, local: EgressGuard.local(host) }).toEqual({ host, local: false })
    expect(EgressGuard.local("::1%lo0")).toBe(true)
  })

  test("counts names the caller pins to this computer", () => {
    expect(EgressGuard.local("article.web.test", ["web.test"])).toBe(true)
    expect(EgressGuard.local("web.test.example.com", ["web.test"])).toBe(false)
  })
})

describe("EgressGuard.installStrict", () => {
  const state: { handle?: EgressGuard.Handle } = {}
  const original = {
    fetch: globalThis.fetch,
    connect: net.Socket.prototype.connect,
    connect_: Bun.connect,
    WebSocket: globalThis.WebSocket,
    Worker: globalThis.Worker,
    ThreadWorker: workerThreads.Worker,
    env: Object.fromEntries(
      ["HTTP_PROXY", "https_proxy", "NO_PROXY", "VECTOR_TEST_EGRESS"].map((key) => [key, process.env[key]]),
    ),
  }
  beforeAll(() => {
    state.handle = EgressGuard.installStrict()
  })
  afterAll(() => {
    state.handle?.uninstall()
    state.handle = undefined
  })

  test("blocks fetch to an outside address before it connects", async () => {
    await expect(fetch(`http://${OUTSIDE}/`)).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    await expect(fetch(new Request(`https://${OUTSIDE}/x`))).rejects.toThrow(`connection to ${OUTSIDE}`)
    expect(state.handle!.attempts().filter((attempt) => attempt.kind === "fetch" && !attempt.allowed)).toHaveLength(2)
  })

  test("blocks net.connect, a socket's own connect and tls", () => {
    expect(() => net.connect(443, OUTSIDE)).toThrow(EgressGuard.EgressBlocked)
    expect(() => net.connect({ host: OUTSIDE, port: 80 })).toThrow(EgressGuard.EgressBlocked)
    expect(() => new net.Socket().connect(80, OUTSIDE)).toThrow(EgressGuard.EgressBlocked)
    expect(() => tls.connect(443, OUTSIDE)).toThrow(EgressGuard.EgressBlocked)
  })

  test("blocks node:https and node:http requests", () => {
    expect(() => https.get(`https://${OUTSIDE}/`)).toThrow(EgressGuard.EgressBlocked)
    expect(() => https.request({ host: OUTSIDE, port: 8443, path: "/" }).end()).toThrow(EgressGuard.EgressBlocked)
    expect(() => http.get(`http://${OUTSIDE}/`)).toThrow(EgressGuard.EgressBlocked)
    expect(state.handle!.attempts().filter((attempt) => attempt.host === OUTSIDE && attempt.allowed)).toEqual([])
  })

  test("blocks a WebSocket to an outside address", () => {
    expect(() => new WebSocket(`wss://${OUTSIDE}/`)).toThrow(EgressGuard.EgressBlocked)
  })

  test("refuses a fetch scheme that is not on this computer, such as Bun's s3:", async () => {
    await expect(fetch("s3://bucket/key")).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(await (await fetch("data:,inline")).text()).toBe("inline")
  })

  test("lets loopback through every path and lists each attempt", async () => {
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("here")
    expect(await (await fetch(`http://localhost:${server.port}/`)).text()).toBe("here")
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${server.port}/`, (response) => {
          const chunks: Buffer[] = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () => resolve(Buffer.concat(chunks).toString()))
        })
        .on("error", reject)
    })
    expect(body).toBe("here")
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(server.port!, "127.0.0.1", () => {
        socket.destroy()
        resolve()
      })
      socket.on("error", reject)
    })
    const kinds = state
      .handle!.attempts()
      .filter((attempt) => attempt.allowed)
      .map((attempt) => attempt.kind)
    // Loopback goes around the guard's own proxy, so a fetch here is seen as a fetch and never as a proxied request.
    expect(new Set(kinds)).toEqual(new Set(["fetch", "http", "socket"]))
  })

  test("refuses Bun.fetch and a fetch taken before install through its own proxy", async () => {
    for (const [client, url] of [
      [Bun.fetch, `http://${OUTSIDE}/a`],
      [capturedFetch, `http://${OUTSIDE}/b`],
      [Bun.fetch, `https://${OUTSIDE}/c`],
    ] as const) {
      const response = await client(url)
      expect({ url, status: response.status }).toEqual({ url, status: 403 })
    }
    const refused = await (await capturedFetch(`http://${OUTSIDE}/d`)).text()
    expect(refused).toBe(`Vector blocked a connection to ${OUTSIDE}: only this computer is reachable here.`)
    expect(state.handle!.attempts().filter((attempt) => attempt.kind === "proxied" && !attempt.allowed)).toHaveLength(4)
    // This computer still answers through it.
    expect(await (await Bun.fetch(at())).text()).toBe("here")
    expect(await (await capturedFetch(at())).text()).toBe("here")
  })

  test("sends the body of a Request that carries Bun's own timeout option, as the SDK's requests do", async () => {
    // The SDK's client sets the option on the Request itself (createVectorClient). Bun then sent such a Request's body
    // empty once the guard had read the body before it kept a copy for redirects.
    const request = Object.assign(
      new Request(at("/sdk"), { method: "POST", body: '{"parts":["hi"]}', headers: { "x-test-mark": "sdk" } }),
      { timeout: false },
    )
    expect(await (await fetch(request)).text()).toBe("here")
    const redirected = Object.assign(
      new Request(at("/keep"), { method: "PUT", body: "kept", headers: { "x-test-mark": "sdk-redirect" } }),
      { timeout: false },
    )
    expect(await (await fetch(redirected)).text()).toBe("here")
    expect(
      seen.filter((item) => item.mark?.startsWith("sdk")).map((item) => [item.path, item.method, item.body]),
    ).toEqual([
      ["/sdk", "POST", '{"parts":["hi"]}'],
      ["/keep", "PUT", "kept"],
      ["/landed", "PUT", "kept"],
    ])
  })

  test("decides each request on a kept-alive connection to its proxy on its own", async () => {
    seen.length = 0
    const proxy = new URL(process.env[EgressGuard.ENVIRONMENT.proxy]!)
    const raw = (text: string) =>
      new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        const socket = net.connect(Number(proxy.port), proxy.hostname, () => socket.write(text))
        socket.on("data", (chunk: Buffer) => chunks.push(chunk))
        socket.on("end", () => resolve(Buffer.concat(chunks).toString()))
        socket.on("error", reject)
        setTimeout(() => {
          socket.destroy()
          resolve(Buffer.concat(chunks).toString())
        }, 1_000)
      })
    const here = `127.0.0.1:${server.port}`
    const first = `POST http://${here}/first HTTP/1.1\r\nHost: ${here}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n`
    // The body is passed on by its chunks, and the server answers.
    expect(await raw(first)).toContain("here")
    expect(seen.map((item) => [item.path, item.body])).toEqual([["/first", "hello world"]])
    // What follows a body on the same connection is a request of its own, and an outside one is refused.
    const replies = await raw(`${first}GET http://${OUTSIDE}/second HTTP/1.1\r\nHost: ${OUTSIDE}\r\n\r\n`)
    expect(replies).toContain("HTTP/1.1 403 Forbidden")
    expect(replies).toContain(`Vector blocked a connection to ${OUTSIDE}`)
    expect(seen.map((item) => item.path)).not.toContain("/second")
  })

  test("decides every redirect hop before it is made", async () => {
    await expect(fetch(at("/out"))).rejects.toThrow(`connection to ${OUTSIDE}`)
    expect(
      state
        .handle!.attempts()
        .filter((attempt) => attempt.host === OUTSIDE && attempt.kind === "fetch")
        .at(-1),
    ).toMatchObject({ allowed: false })
    const followed = await fetch(at("/hop"))
    expect({ status: followed.status, url: followed.url, redirected: followed.redirected }).toEqual({
      status: 200,
      url: at("/landed"),
      redirected: true,
    })
    expect(await followed.text()).toBe("here")
    // A caller that follows redirects itself still gets the redirect.
    const manual = await fetch(at("/out"), { redirect: "manual" })
    expect({ status: manual.status, location: manual.headers.get("location") }).toEqual({
      status: 302,
      location: `http://${OUTSIDE}/collect`,
    })
  })

  test("follows redirects the way fetch does: method, body and credentials", async () => {
    const mark = { "x-test-mark": "follows" }
    await fetch(at("/see-other"), { method: "POST", body: "form", headers: mark })
    await fetch(at("/keep"), { method: "PUT", body: "kept", headers: mark })
    await fetch(at("/hop"), { headers: { ...mark, authorization: "Bearer same-site" } })
    await fetch(at("/elsewhere"), { headers: { ...mark, authorization: "Bearer other-site" } })
    const own = seen.filter((item) => item.mark === mark["x-test-mark"])
    expect(own.map((item) => [item.path, item.method, item.body, item.authorization])).toEqual([
      ["/see-other", "POST", "form", null],
      ["/landed", "GET", "", null],
      ["/keep", "PUT", "kept", null],
      ["/landed", "PUT", "kept", null],
      ["/hop", "GET", "", "Bearer same-site"],
      ["/landed", "GET", "", "Bearer same-site"],
      ["/elsewhere", "GET", "", "Bearer other-site"],
      ["/landed", "GET", "", null],
    ])
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("streamed"))
        controller.close()
      },
    })
    await expect(fetch(at("/keep"), { method: "PUT", body: stream })).rejects.toThrow("streamed request body")
  })

  test("resends a Request object's body on a 307, as fetch does", async () => {
    const response = await fetch(
      new Request(at("/keep"), { method: "POST", body: "payload", headers: { "x-test-mark": "resend" } }),
    )
    expect({ status: response.status, redirected: response.redirected }).toEqual({ status: 200, redirected: true })
    const own = seen.filter((item) => item.mark === "resend")
    expect(own.map((item) => [item.path, item.method, item.body])).toEqual([
      ["/keep", "POST", "payload"],
      ["/landed", "POST", "payload"],
    ])
  })

  test("treats any proxy but its own as a way off this computer", async () => {
    await expect(fetch(at(), { proxy: `http://${OUTSIDE}:3128` } as RequestInit)).rejects.toThrow(
      `connection to ${OUTSIDE}`,
    )
    // A proxy on this computer still forwards to wherever it is asked.
    await expect(fetch(at(), { proxy: "http://127.0.0.1:9" } as RequestInit)).rejects.toBeInstanceOf(
      EgressGuard.EgressBlocked,
    )
    // Whichever spelling a client prefers, a proxy off this computer in any of them is refused. The guard sends
    // loopback around its own proxy (NO_PROXY), so that is emptied here for the proxy to carry this request at all.
    const bypass = ["NO_PROXY", "no_proxy"].map((key) => [key, process.env[key]] as const)
    for (const key of ["HTTP_PROXY", "http_proxy", "ALL_PROXY"]) {
      const before = process.env[key]
      process.env[key] = `http://${OUTSIDE}:8080`
      bypass.forEach(([name]) => (process.env[name] = ""))
      try {
        await expect(fetch(at())).rejects.toThrow(`connection to ${OUTSIDE}`)
      } finally {
        process.env[key] = before ?? ""
        bypass.forEach(([name, value]) => (process.env[name] = value ?? ""))
      }
    }
    expect(await (await fetch(at())).text()).toBe("here")
  })

  test("reads a socket's port the way Node does, so a numeric string is a port and not a pipe", () => {
    for (const port of [" 80", "0x50", "80.0", "8e1", "+80", ""])
      expect(() => new net.Socket().connect(port as never, OUTSIDE)).toThrow(EgressGuard.EgressBlocked)
  })

  test("blocks a WebSocket's own proxy when it is not the guard's", () => {
    expect(() => new WebSocket("ws://127.0.0.1:9/", { proxy: `http://${OUTSIDE}:3128` } as never)).toThrow(
      `connection to ${OUTSIDE}`,
    )
  })

  test("decides fetch.preconnect, which does nothing for an outside address", () => {
    const before = state.handle!.attempts().length
    expect(fetch.preconnect(`https://${OUTSIDE}/`)).toBeUndefined()
    expect(state.handle!.attempts().slice(before)).toEqual([
      { kind: "fetch", host: OUTSIDE, port: 443, url: `https://${OUTSIDE}`, method: "CONNECT", allowed: false },
    ])
  })

  test("blocks Bun.connect to an outside address", async () => {
    await expect(
      Bun.connect({ hostname: OUTSIDE, port: 443, socket: { data: () => undefined } }),
    ).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    // Bun reads `host` too when `hostname` is not given.
    await expect(
      Bun.connect({ host: OUTSIDE, port: 443, socket: { data: () => undefined } } as never),
    ).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port!,
      socket: { data: () => undefined },
    })
    socket.end()
  })

  test("installs the same wraps in a Worker, from the global class or node:worker_threads", async () => {
    const file = path.join(os.tmpdir(), `vector-guard-worker-${process.pid}.ts`)
    await Bun.write(
      file,
      `const outcome = (promise) => promise.then(() => "reached", (error) => error?.name ?? String(error))
const results = {
  fetch: await outcome(fetch("http://${OUTSIDE}/w")),
  connect: await outcome(Bun.connect({ hostname: "${OUTSIDE}", port: 80, socket: { data() {} } })),
  native: await Bun.fetch("http://${OUTSIDE}/n").then((response) => response.status),
  here: await fetch("${at()}").then((response) => response.text()),
}
const { parentPort } = await import("node:worker_threads")
if (parentPort) parentPort.postMessage(results)
else postMessage(results)
`,
    )
    const expected = { fetch: "EgressBlocked", connect: "EgressBlocked", native: 403, here: "here" }
    const web = new Worker(file)
    expect(await new Promise<unknown>((resolve) => (web.onmessage = (event) => resolve(event.data)))).toEqual(expected)
    web.terminate()
    const thread = new workerThreads.Worker(file)
    expect(await new Promise<unknown>((resolve) => thread.once("message", resolve))).toEqual(expected)
    await thread.terminate()
  })

  test("guards a worker whose entry imports backstop-worker first, however it was started", async () => {
    const file = path.join(os.tmpdir(), `vector-guard-sealed-${process.pid}.ts`)
    await Bun.write(
      file,
      `import ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/backstop-worker.ts"))}
const outcome = (promise) => promise.then(() => "reached", (error) => error?.name ?? String(error))
const { parentPort } = await import("node:worker_threads")
parentPort.postMessage({ connect: await outcome(Bun.connect({ hostname: "${OUTSIDE}", port: 80, socket: { data() {} } })) })
`,
    )
    // The class as a module that imported it by name before the guard kept it: no preload reaches this worker.
    const thread = new original.ThreadWorker(file)
    expect(await new Promise<unknown>((resolve) => thread.once("message", resolve))).toEqual({
      connect: "EgressBlocked",
    })
    await thread.terminate()
  })

  test("refuses a second install and restores every original on uninstall", () => {
    expect(() => EgressGuard.installStrict()).toThrow("already installed")
    expect([EgressGuard.installed(), EgressGuard.strictInstalled()]).toEqual([true, true])
    state.handle!.uninstall()
    state.handle = undefined
    expect([EgressGuard.installed(), EgressGuard.strictInstalled()]).toEqual([false, false])
    expect(globalThis.fetch).toBe(original.fetch)
    expect(net.Socket.prototype.connect).toBe(original.connect)
    expect(globalThis.WebSocket).toBe(original.WebSocket)
    expect(globalThis.Worker).toBe(original.Worker)
    expect(workerThreads.Worker).toBe(original.ThreadWorker)
    expect(Bun.connect).toBe(original.connect_)
    expect(Object.hasOwn(http.ClientRequest.prototype, "end")).toBe(false)
    // NO_PROXY is left empty rather than removed: Bun's fetch never sees a variable that was deleted set again.
    expect(Object.fromEntries(Object.keys(original.env).map((key) => [key, process.env[key]]))).toEqual({
      ...original.env,
      NO_PROXY: original.env.NO_PROXY ?? "",
    })
  })
})

describe("EgressGuard.install with Vector Local on", () => {
  const recorded: EgressGuard.Recorded[] = []
  const listed = LocalPolicy.resolve({ global: { enabled: true, endpoints: ["http://nas.local:8000"] } })
  const current = { policy: LocalPolicy.OFF }
  const state: { handle?: EgressGuard.Handle } = {}
  const errorOf = (socket: { on: (event: string, listener: (...input: unknown[]) => void) => unknown }) =>
    new Promise<unknown>((resolve) => {
      socket.on("error", resolve)
      socket.on("connect", () => resolve("connected"))
      socket.on("response", () => resolve("answered"))
    })
  // What a resolver would answer for any name, without asking DNS.
  const answer =
    (address: string) => (_hostname: string, options: { all?: boolean }, callback: (...input: unknown[]) => void) =>
      options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)
  beforeAll(() => {
    state.handle = EgressGuard.install({ policy: () => current.policy, record: (item) => recorded.push(item) })
  })
  afterAll(() => {
    state.handle?.uninstall()
    state.handle = undefined
  })

  test("passes everything and records nothing while Vector Local is off", async () => {
    current.policy = LocalPolicy.OFF
    expect(await (await fetch(at())).text()).toBe("here")
    expect(state.handle!.attempts()).toEqual([])
    expect(recorded).toEqual([])
    // Installed, but not the strict guard: an eval that needs every attempt logged tells the two apart.
    expect([EgressGuard.installed(), EgressGuard.strictInstalled()]).toEqual([true, false])
  })

  test("blocks an unlabelled connection off this computer before it is made, in every client", async () => {
    current.policy = listed
    await expect(fetch(`http://${OUTSIDE}/`)).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(await errorOf(net.connect(443, OUTSIDE))).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(await errorOf(tls.connect(443, OUTSIDE))).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(await errorOf(https.get(`https://${OUTSIDE}/`))).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(() => new WebSocket(`wss://${OUTSIDE}/`)).toThrow(EgressGuard.EgressBlocked)
    await expect(
      Bun.connect({ host: OUTSIDE, port: 443, socket: { data: () => undefined } } as never),
    ).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(fetch.preconnect(`https://${OUTSIDE}/`)).toBeUndefined()
    const blocked = recorded.filter((item) => !item.attempt.allowed)
    expect(blocked.map((item) => item.attempt.kind)).toEqual([
      "fetch",
      "socket",
      "socket",
      "http",
      "websocket",
      "socket",
      "fetch",
    ])
    expect(new Set(blocked.map((item) => item.verdict.rule))).toEqual(new Set(["unlabelled"]))
    // The log names the code that made each one.
    expect(blocked.every((item) => item.frame?.includes("guard.test.ts"))).toBe(true)
    expect(state.handle!.attempts().filter((item) => item.host === OUTSIDE && item.allowed)).toEqual([])
  })

  test("lets this computer and the listed servers through, logging only what leaves this computer", async () => {
    current.policy = listed
    recorded.length = 0
    expect(await (await fetch(at())).text()).toBe("here")
    expect(await errorOf(net.connect(server.port!, "127.0.0.1"))).toBe("connected")
    expect(recorded).toEqual([])
    // nas.local is listed; its connection is decided, logged and checked after lookup.
    const listener = net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    const port = (listener.address() as net.AddressInfo).port
    const policy = LocalPolicy.resolve({ global: { enabled: true, endpoints: [`http://nas.local:${port}`] } })
    current.policy = policy
    expect(await errorOf(net.connect({ host: "nas.local", port, lookup: answer("127.0.0.1") as never }))).toBe(
      "connected",
    )
    expect(recorded.map((item) => [item.attempt.host, item.verdict.rule])).toEqual([["nas.local", "listed"]])
    listener.close()
  })

  test("sends a Request's body as it is, also one the SDK made, which carries a timeout of its own", async () => {
    current.policy = listed
    const request = new Request(at("/sdk"), { method: "POST", body: '{"a":1}', headers: { "x-test-mark": "sdk" } })
    // The SDK's client turns Bun's fetch timeout off this way on every request it sends.
    Object.assign(request, { timeout: false })
    expect(await (await fetch(request)).text()).toBe("here")
    const kept = new Request(at("/keep"), { method: "POST", body: "again", headers: { "x-test-mark": "sdk" } })
    Object.assign(kept, { timeout: false })
    expect((await fetch(kept)).redirected).toBe(true)
    expect(seen.filter((item) => item.mark === "sdk").map((item) => [item.path, item.body])).toEqual([
      ["/sdk", '{"a":1}'],
      ["/keep", "again"],
      ["/landed", "again"],
    ])
  })

  test("refuses a name that says it is here or on your network but resolves outside, before connecting", async () => {
    current.policy = listed
    recorded.length = 0
    // What the socket's lookup answered. The socket is destroyed there, so nothing connects whatever the answer; the
    // answer comes on a later tick, so the listener is in place before it.
    const later =
      (address: string) => (hostname: string, options: { all?: boolean }, callback: (...input: unknown[]) => void) =>
        setTimeout(() => answer(address)(hostname, options, callback), 0)
    const lookedUp = (socket: net.Socket) =>
      new Promise<{ error?: unknown; address?: unknown }>((resolve) => {
        socket.on("lookup", (error: unknown, address: unknown) => {
          socket.destroy()
          resolve(error ? { error } : { address })
        })
        socket.on("error", (error: unknown) => resolve({ error }))
      })
    const local = await lookedUp(net.connect({ host: "localhost", port: 8000, lookup: later(OUTSIDE) as never }))
    expect(local.error).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect((local.error as EgressGuard.EgressBlocked).rule).toBe("resolved-outside")
    // A name a labelled request may reach because of where its name says it is keeps the check.
    const printer = await EgressAttribution.granted(
      { source: "webfetch", purpose: "web-page", grants: [{ host: "printer.local", port: 80, within: "private" }] },
      () => lookedUp(net.connect({ host: "printer.local", port: 80, lookup: later(OUTSIDE) as never })),
    )
    expect((printer.error as EgressGuard.EgressBlocked).rule).toBe("resolved-outside")
    // A listed model server is decided on the list: a company's internal name may sit on its own public range.
    expect(await lookedUp(net.connect({ host: "nas.local", port: 8000, lookup: later(OUTSIDE) as never }))).toEqual({
      address: OUTSIDE,
    })
    // A listed loopback name must still stay on loopback.
    current.policy = LocalPolicy.resolve({ global: { enabled: true, endpoints: ["http://localhost:8000"] } })
    const listedLocal = await lookedUp(net.connect({ host: "localhost", port: 8000, lookup: later(OUTSIDE) as never }))
    expect((listedLocal.error as EgressGuard.EgressBlocked).rule).toBe("resolved-outside")
    expect(recorded.map((item) => [item.attempt.host, item.verdict.rule])).toEqual([
      ["localhost", "resolved-outside"],
      ["printer.local", "resolved-outside"],
      ["nas.local", "listed"],
      ["localhost", "listed"],
      ["localhost", "resolved-outside"],
    ])
  })

  test("checks where a name the user listed resolves once a company lock limits the user to their network", async () => {
    const later =
      (address: string) => (hostname: string, options: { all?: boolean }, callback: (...input: unknown[]) => void) =>
        setTimeout(() => answer(address)(hostname, options, callback), 0)
    const lookedUp = (socket: net.Socket) =>
      new Promise<{ error?: unknown; address?: unknown }>((resolve) => {
        socket.on("lookup", (error: unknown, address: unknown) => {
          socket.destroy()
          resolve(error ? { error } : { address })
        })
        socket.on("error", (error: unknown) => resolve({ error }))
      })
    const locked = LocalPolicy.resolve({
      managed: { lock: true, user_may: ["endpoints"], endpoints: ["http://gpu.internal:8000"] },
      global: { endpoints: ["http://nas.local:8000"] },
    })
    expect(locked.endpoints).toEqual([
      { origin: "http://gpu.internal:8000", from: "managed" },
      { origin: "http://nas.local:8000", from: "user" },
    ])
    current.policy = locked
    // A name on the user's network that answers with an internet address is refused, listed or not, under a lock.
    const nas = await lookedUp(net.connect({ host: "nas.local", port: 8000, lookup: later(OUTSIDE) as never }))
    expect((nas.error as EgressGuard.EgressBlocked).rule).toBe("resolved-outside")
    // The company's own endpoint is reached wherever its name resolves.
    expect(await lookedUp(net.connect({ host: "gpu.internal", port: 8000, lookup: later(OUTSIDE) as never }))).toEqual({
      address: OUTSIDE,
    })
    // A labelled request's grant is checked the same way.
    expect([
      LocalPolicy.exempt(locked, "http://nas.local:8000/v1"),
      LocalPolicy.exempt(locked, "http://gpu.internal:8000/v1"),
    ]).toEqual([false, true])
    expect(LocalPolicy.exempt(listed, "http://nas.local:8000/v1")).toBe(true)
  })

  test("grants a labelled request's checks the same way: listed names on the list, loopback names on loopback", () => {
    const at = (url: string, exempt?: boolean) => EgressGuard.destinations(new URL(url), { exempt })[0]!.within
    expect([at("http://gpu.internal:8000/"), at("http://gpu.internal:8000/", true)]).toEqual(["private", undefined])
    expect([at("http://localhost:11434/", true), at("http://box.tail1.ts.net/", true)]).toEqual(["loopback", undefined])
  })

  test("lets only the destinations a labelled scope granted through, never an unrelated host", async () => {
    current.policy = listed
    const granted = await EgressAttribution.granted(
      { source: "model-catalog", purpose: "catalog", grants: [{ host: "catalog.web.test", port: server.port }] },
      async () => {
        // The resolver here is the caller's own, so no DNS is asked.
        const reached = await errorOf(
          http.get({ host: "catalog.web.test", port: server.port, path: "/", lookup: answer("127.0.0.1") as never }),
        )
        const other = await errorOf(
          http.get({ host: "other.web.test", port: server.port, path: "/", lookup: answer("127.0.0.1") as never }),
        )
        return { reached, other }
      },
    )
    expect(granted.reached).toBe("answered")
    expect(granted.other).toBeInstanceOf(EgressGuard.EgressBlocked)
    // The same host without the scope is unlabelled.
    expect(
      await errorOf(
        http.get({ host: "catalog.web.test", port: server.port, path: "/", lookup: answer("127.0.0.1") as never }),
      ),
    ).toBeInstanceOf(EgressGuard.EgressBlocked)
  })

  test("follows a redirect to another origin without its cookies or credentials, as fetch does", async () => {
    current.policy = listed
    seen.length = 0
    const credentials = { authorization: "Bearer x", cookie: "sid=secret", "proxy-authorization": "Basic eQ==" }
    await fetch(at("/hop"), { headers: credentials })
    await fetch(at("/elsewhere"), { headers: credentials })
    // Only these routes: a request an earlier test left open may still land on "/".
    const routes = () => seen.filter((item) => item.path !== "/")
    expect(routes().map((item) => [item.path, item.authorization, item.cookie, item.proxyAuthorization])).toEqual([
      ["/hop", "Bearer x", "sid=secret", "Basic eQ=="],
      ["/landed", "Bearer x", "sid=secret", "Basic eQ=="],
      ["/elsewhere", "Bearer x", "sid=secret", "Basic eQ=="],
      ["/landed", null, null, null],
    ])
    // A Request object's body is resent on a 307 too.
    seen.length = 0
    expect(await (await fetch(new Request(at("/keep"), { method: "POST", body: "payload" }))).text()).toBe("here")
    expect(routes().map((item) => [item.path, item.body])).toEqual([
      ["/keep", "payload"],
      ["/landed", "payload"],
    ])
  })

  test("stops an unlabelled redirect at the hop that leaves this computer", async () => {
    current.policy = listed
    await expect(fetch(at("/out"))).rejects.toThrow(`connection to ${OUTSIDE}`)
    const followed = await fetch(at("/hop"))
    expect({ url: followed.url, redirected: followed.redirected }).toEqual({ url: at("/landed"), redirected: true })
  })

  test("treats a proxy on this computer as the internet: an unlabelled request cannot use it", async () => {
    current.policy = listed
    const seenByProxy: string[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seenByProxy.push(request.url)
        return new Response("proxied")
      },
    })
    const saved = ["HTTPS_PROXY", "HTTP_PROXY"].map((key) => [key, process.env[key]] as const)
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    try {
      await expect(fetch("https://models.web.test/v1/models")).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
      expect(await errorOf(net.connect(proxy.port!, "127.0.0.1"))).toBeInstanceOf(EgressGuard.EgressBlocked)
      await expect(fetch(at(), { proxy: `http://127.0.0.1:${proxy.port}` } as RequestInit)).rejects.toBeInstanceOf(
        EgressGuard.EgressBlocked,
      )
      expect(seenByProxy).toEqual([])
    } finally {
      for (const [key, value] of saved) {
        process.env[key] = value ?? ""
        if (value === undefined) delete process.env[key]
      }
      proxy.stop(true)
    }
  })

  test("sends what it allows to this computer around the proxy environment, so a proxy never sees it", async () => {
    current.policy = listed
    const seenByProxy: string[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seenByProxy.push(request.url)
        return new Response("proxied")
      },
    })
    const saved = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "no_proxy"].map((key) => [key, process.env[key]] as const)
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    // Windows aliases these names, so clear the lowercase spelling before setting the user's list.
    process.env.no_proxy = ""
    process.env.NO_PROXY = "intranet.example"
    const body = (request: http.ClientRequest) =>
      new Promise<string>((resolve, reject) => {
        request.on("response", (response: http.IncomingMessage) => {
          const chunks: Buffer[] = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () => resolve(Buffer.concat(chunks).toString()))
        })
        request.on("error", reject)
      })
    try {
      expect(await (await fetch(at("/v1"))).text()).toBe("here")
      expect(await (await fetch(`http://localhost:${server.port}/v1`)).text()).toBe("here")
      expect(await body(http.get(at("/v1")))).toBe("here")
      expect(seenByProxy).toEqual([])
      // Both spellings hold one list, the user's own entries kept.
      expect(process.env.NO_PROXY).toBe("intranet.example,127.0.0.1,localhost")
      expect(process.env.no_proxy).toBe(process.env.NO_PROXY)
      // The proxy environment is granted only to a request for the internet.
      expect(EgressGuard.destinations(new URL("https://models.example/v1")).map((item) => item.host)).toEqual([
        "models.example",
        "127.0.0.1",
      ])
      expect(EgressGuard.destinations(new URL("http://gpu-box:8000/v1")).map((item) => item.host)).toEqual(["gpu-box"])
    } finally {
      // Emptied, not deleted: Bun's fetch never sees a variable that was deleted set again.
      saved.forEach(([key, value]) => {
        process.env[key] = value ?? ""
      })
      proxy.stop(true)
    }
  })

  test("sends a request for this computer around a proxy that NO_PROXY covers only for other clients", async () => {
    // The desktop writes `::1`, and companies write `*.internal`: Bun's fetch honours neither.
    const seenByProxy: string[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        seenByProxy.push(`${request.url} ${await request.text()}`)
        return new Response("proxied")
      },
    })
    const ipv6 = Object.values(os.networkInterfaces())
      .flat()
      .some((item) => item?.address === "::1")
    const six = ipv6
      ? Bun.serve({ hostname: "::1", port: 0, fetch: async (request) => new Response(`six ${await request.text()}`) })
      : undefined
    const saved = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"].map((key) => [key, process.env[key]] as const)
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
    try {
      if (six) {
        current.policy = LocalPolicy.resolve({ global: { enabled: true, endpoints: [`http://[::1]:${six.port}`] } })
        process.env.NO_PROXY = "localhost,127.0.0.1,::1"
        process.env.no_proxy = "localhost,127.0.0.1,::1"
        const reply = await fetch(`http://[::1]:${six.port}/v1/chat/completions`, { method: "POST", body: "prompt" })
        expect(await reply.text()).toBe("six prompt")
        expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]")
        expect(process.env.no_proxy).toBe(process.env.NO_PROXY)
      }
      // A listed server on the company's network, by a name only a wildcard covered.
      current.policy = LocalPolicy.resolve({ global: { enabled: true, endpoints: ["http://gpu.internal:8000"] } })
      process.env.no_proxy = ""
      process.env.NO_PROXY = "*.internal"
      const gpu = new URL("http://gpu.internal:8000/v1/chat/completions")
      expect(EgressGuard.carried(gpu)).toBe(true)
      EgressGuard.direct(gpu.hostname)
      expect([process.env.NO_PROXY, process.env.no_proxy]).toEqual([
        "*.internal,gpu.internal",
        "*.internal,gpu.internal",
      ])
      expect(EgressGuard.carried(gpu)).toBe(false)
      // A request for the internet may use the proxy, and so may one the caller gave a proxy of its own.
      expect(EgressGuard.carried(new URL("https://models.example/v1"))).toBe(false)
      process.env.NO_PROXY = ""
      process.env.no_proxy = ""
      expect(EgressGuard.carried(gpu, `http://127.0.0.1:${proxy.port}`)).toBe(false)
      expect(seenByProxy).toEqual([])
    } finally {
      // Emptied, not deleted: Bun's fetch never sees a variable that was deleted set again.
      saved.forEach(([key, value]) => {
        process.env[key] = value ?? ""
      })
      proxy.stop(true)
      six?.stop(true)
    }
  })

  test("refuses a fetch scheme that is not on this computer, such as Bun's s3:, and logs it", async () => {
    current.policy = listed
    recorded.length = 0
    await expect(fetch("s3://bucket/key")).rejects.toThrow("no http or https address")
    expect(recorded.map((item) => [item.attempt.host, item.verdict.rule])).toEqual([["s3://bucket", "unlabelled"]])
    expect(recorded[0]!.frame).toContain("guard.test.ts")
    expect(await (await fetch("data:,inline")).text()).toBe("inline")
    expect(await (await fetch(Bun.pathToFileURL(path.join(import.meta.dir, "guard.test.ts")))).text()).toContain(
      "EgressGuard",
    )
  })

  test("does not see the ws package under Bun, which replaces it with a client that reads no global", async () => {
    current.policy = listed
    // Bun serves `ws` itself, whatever node_modules holds; its call sites are decided by their labelled gate instead.
    const Client = createRequire(import.meta.url)("ws") as new (url: string) => {
      on: (event: string, listener: () => void) => void
      terminate: () => void
    }
    const target = `ws://127.0.0.1:${server.port}/socket`
    const before = state.handle!.attempts().length
    const client = new Client(target)
    client.on("error", () => undefined)
    const seenBy = state.handle!.attempts().slice(before)
    const global = new WebSocket(target)
    global.onerror = () => undefined
    expect(seenBy).toEqual([])
    expect(
      state
        .handle!.attempts()
        .slice(before)
        .map((item) => [item.kind, item.allowed]),
    ).toEqual([["websocket", true]])
    client.terminate()
    global.close()
  })
})

describe("EgressGuard.install's own originals", () => {
  test("restores the Worker classes it wraps to follow its policy", () => {
    const original = { Worker: globalThis.Worker, ThreadWorker: workerThreads.Worker }
    const handle = EgressGuard.install({ policy: () => LocalPolicy.OFF })
    expect(globalThis.Worker).not.toBe(original.Worker)
    expect(workerThreads.Worker).not.toBe(original.ThreadWorker)
    handle.uninstall()
    expect(globalThis.Worker).toBe(original.Worker)
    expect(workerThreads.Worker).toBe(original.ThreadWorker)
  })
})

describe("EgressGuard.carried", () => {
  const KEYS = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ]

  test("reads NO_PROXY the way Bun's fetch does", async () => {
    // In a process of its own: Bun's fetch never sees a proxy variable set again once it was deleted, as this file's
    // other tests do.
    const file = path.join(os.tmpdir(), `vector-guard-carried-${process.pid}.ts`)
    await Bun.write(
      file,
      `import { EgressGuard } from ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/guard.ts"))}
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("proxied") })
const four = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("direct") })
const six = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("direct") })
const urls = {
  four: \`http://127.0.0.1:\${four.port}/\`,
  six: \`http://[::1]:\${six.port}/\`,
  name: \`http://localhost:\${four.port}/\`,
}
for (const key of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "http_proxy"]) process.env[key] = ""
process.env.HTTP_PROXY = \`http://127.0.0.1:\${proxy.port}\`
const rows = []
for (const [list, which] of JSON.parse(process.argv[2])) {
  const entry = list.replaceAll("FOUR", String(four.port)).replaceAll("SIX", String(six.port))
  process.env.NO_PROXY = entry
  process.env.no_proxy = entry
  const bun = await (await fetch(urls[which])).text()
  rows.push({ list, which, bun: bun === "proxied", guard: EgressGuard.carried(new URL(urls[which])) })
}
console.log(JSON.stringify(rows))
proxy.stop(true)
four.stop(true)
six.stop(true)
`,
    )
    const rows = [
      ["", "four"],
      ["127.0.0.1", "four"],
      ["0.0.1", "four"],
      [".0.0.1", "four"],
      ["*.0.0.1", "four"],
      ["*", "four"],
      ["other.example, *", "four"],
      ["127.0.0.1:FOUR", "four"],
      ["127.0.0.1:9", "four"],
      ["127.0.0.0/8", "four"],
      ["other.example 127.0.0.1", "four"],
      ["127.0.0.1.", "four"],
      ["localhost", "name"],
      [".localhost", "name"],
      ["*.localhost", "name"],
      ["LOCALHOST", "name"],
      ["::1", "six"],
      ["[::1]", "six"],
      ["[::1]:SIX", "six"],
      ["[::1]:9", "six"],
      ["127.0.0.1,localhost,::1", "six"],
    ]
    const child = Bun.spawn([process.execPath, file, JSON.stringify(rows)], {
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
    })
    const results = JSON.parse(await new Response(child.stdout).text()) as {
      list: string
      which: string
      bun: boolean
      guard: boolean
    }[]
    expect(results).toHaveLength(rows.length)
    expect(results.filter((row) => row.bun !== row.guard)).toEqual([])
    // Bun honours neither a `*.name` wildcard nor a bare IPv6 address.
    expect(results.filter((row) => row.bun).map((row) => row.list)).toEqual([
      "",
      "*.0.0.1",
      "127.0.0.1:9",
      "127.0.0.0/8",
      "other.example 127.0.0.1",
      "127.0.0.1.",
      "*.localhost",
      "::1",
      "[::1]:9",
      "127.0.0.1,localhost,::1",
    ])
  })

  test("reads no_proxy first as Bun does, and every proxy variable some client reads", () => {
    const local = new URL("http://127.0.0.1:8000/")
    const env = { HTTP_PROXY: "http://proxy.example:3128", NO_PROXY: "127.0.0.1", no_proxy: "" }
    // An empty no_proxy counts as unset, so NO_PROXY applies; one that is set wins over NO_PROXY.
    expect(EgressGuard.carried(local, undefined, env)).toBe(false)
    expect(EgressGuard.carried(local, undefined, { ...env, no_proxy: "other.example" })).toBe(true)
    expect(EgressGuard.carried(local, undefined, { ...env, NO_PROXY: "", no_proxy: "127.0.0.1" })).toBe(false)
    // Bun 1.3 reads only the variable for the request's scheme; other clients fall back to HTTP_PROXY and ALL_PROXY,
    // so a refusal here may be wider than Bun's own reading, never narrower.
    const https = new URL("https://127.0.0.1:8000/")
    expect(EgressGuard.carried(https, undefined, { HTTP_PROXY: "http://proxy.example:3128" })).toBe(true)
    expect(EgressGuard.carried(local, undefined, { ALL_PROXY: "http://proxy.example:3128" })).toBe(true)
  })

  test("puts a local host on NO_PROXY in the forms Bun and Node match, whatever pattern already covers it", () => {
    const saved = [...KEYS, "VECTOR_TEST_EGRESS_PROXY"].map((key) => [key, process.env[key]] as const)
    try {
      KEYS.forEach((key) => {
        process.env[key] = ""
      })
      process.env.HTTP_PROXY = "http://127.0.0.1:3128"
      // A company's wildcard and the desktop's bare ::1: other clients honour them, Bun does not.
      process.env.NO_PROXY = "*.internal,::1"
      EgressGuard.direct("gpu.internal")
      EgressGuard.direct("[::1]")
      expect(process.env.NO_PROXY).toBe("*.internal,::1,gpu.internal,[::1]")
      expect(process.env.no_proxy).toBe(process.env.NO_PROXY)
      expect(EgressGuard.carried(new URL("http://gpu.internal:8000/v1"))).toBe(false)
      expect(EgressGuard.carried(new URL("http://[::1]:8000/v1"))).toBe(false)
      // A request for the internet is the proxy's.
      EgressGuard.direct("models.example")
      expect(process.env.NO_PROXY).not.toContain("models.example")
      // Outside strict mode no proxy is the guard's own, whatever the test variables say.
      process.env.VECTOR_TEST_EGRESS_PROXY = process.env.HTTP_PROXY
      EgressGuard.direct("nas.local")
      expect(process.env.NO_PROXY).toEndWith(",nas.local")
    } finally {
      saved.forEach(([key, value]) => {
        process.env[key] = value ?? ""
      })
    }
  })
})

describe("EgressGuard.handed", () => {
  test("never reads a handed policy on the main thread, and leaves none for the programs it starts", () => {
    const env: Record<string, string | undefined> = {
      [EgressGuard.WORKER_POLICY]: JSON.stringify({ policy: LocalPolicy.OFF }),
    }
    expect(EgressGuard.handed(env)).toBeUndefined()
    expect(env).toEqual({})
  })
})

describe("EgressGuard.environmentProxies", () => {
  const target = (url: string) => new URL(url)
  test("lists every proxy for the scheme and ALL_PROXY, and none for NO_PROXY's hosts", () => {
    const env = { HTTP_PROXY: "http://web-proxy:1", http_proxy: "http://lower:4", ALL_PROXY: "http://all:3" }
    expect(EgressGuard.environmentProxies(target("http://a.example/"), env)).toEqual([
      "http://web-proxy:1",
      "http://lower:4",
      "http://all:3",
    ])
    expect(
      EgressGuard.environmentProxies(target("https://a.example/"), {
        https_proxy: "http://tls:2",
        ALL_PROXY: "http://all:3",
      }),
    ).toEqual(["http://tls:2", "http://all:3"])
    expect(EgressGuard.environmentProxies(target("http://a.example/"), {})).toEqual([])
    // Node's fetch falls back to HTTP_PROXY for https, so it is listed too; Bun does not, and over-listing is safe.
    expect(EgressGuard.environmentProxies(target("https://a.example/"), { HTTP_PROXY: "http://web-proxy:1" })).toEqual([
      "http://web-proxy:1",
    ])
    // NO_PROXY as Bun reads it, checked against Bun 1.3's fetch: the narrowest reading of the clients Vector runs.
    for (const [list, url, bypassed] of [
      ["*", "http://a.example/", true],
      ["a, *", "http://a.example/", true],
      ["xample", "http://a.example/", false],
      ["a.example", "http://a.example/", true],
      ["A.EXAMPLE", "http://a.example/", true],
      ["example", "http://a.example/", true],
      [".example", "http://deep.a.example/", true],
      // Bun honours neither a `*.` wildcard nor a bare IPv6 address, nor a list split by spaces.
      ["*.example", "http://a.example/", false],
      ["::1", "http://[::1]:3000/", false],
      ["[::1]", "http://[::1]:3000/", true],
      ["[::1]:3000", "http://[::1]:3000/", true],
      ["b.example a.example", "http://a.example/", false],
      ["127.0.0.0/8", "http://127.0.0.2/", false],
      ["a.example:8080", "http://a.example/", false],
      ["a.example:8080", "http://a.example:8080/", true],
      ["a.example.", "http://a.example/", false],
    ] as const)
      expect({
        list,
        url,
        proxies: EgressGuard.environmentProxies(target(url), { HTTP_PROXY: "http://web-proxy:1", NO_PROXY: list }),
      }).toEqual({ list, url, proxies: bypassed ? [] : ["http://web-proxy:1"] })
    // Bun reads no_proxy first, and an empty one as unset.
    const both = (lower: string) =>
      EgressGuard.environmentProxies(target("http://a.example/"), {
        HTTP_PROXY: "http://web-proxy:1",
        NO_PROXY: "a.example",
        no_proxy: lower,
      })
    expect([both(""), both("b.example")]).toEqual([[], ["http://web-proxy:1"]])
  })
})

describe("EgressGuard.strictFromEnvironment", () => {
  test("reads strict mode from a test's environment in a source checkout only", () => {
    const env = { VECTOR_TEST_EGRESS: "strict", VECTOR_TEST_EGRESS_NAMES: "web.test,198.51.100.7" }
    expect(EgressGuard.strictFromEnvironment(env, true)).toEqual({
      names: ["web.test", "198.51.100.7"],
      proxy: undefined,
    })
    expect(
      EgressGuard.strictFromEnvironment({ ...env, VECTOR_TEST_EGRESS_PROXY: "http://127.0.0.1:1" }, true)?.proxy,
    ).toBe("http://127.0.0.1:1")
    // A release build and the desktop app never read it.
    expect(EgressGuard.strictFromEnvironment(env, false)).toBeUndefined()
    // Nor does a process the environment turns Vector Local on for: the names would loosen it.
    expect(EgressGuard.strictFromEnvironment({ ...env, VECTOR_LOCAL: "1" }, true)).toBeUndefined()
    expect(
      EgressGuard.strictFromEnvironment({ ...env, VECTOR_LOCAL_POLICY: JSON.stringify({ enabled: true }) }, true),
    ).toBeUndefined()
    expect(EgressGuard.strictFromEnvironment({ VECTOR_TEST_EGRESS: "on" }, true)).toBeUndefined()
    // Nor once the backstop started pending because the user's config or the company's policy may turn it on.
    expect(EgressGuard.strictFromEnvironment(env, true, true)).toBeUndefined()
  })
})

describe("Vector's own code", () => {
  // Bun makes Bun.fetch read-only, so no guard can wrap it: Vector's code reaches the network through fetch instead.
  test("never calls Bun.fetch, which the guard cannot see", async () => {
    const root = path.join(import.meta.dir, "../../..")
    const files = await Array.fromAsync(new Bun.Glob("*/src/**/*.{ts,tsx}").scan({ cwd: root }))
    const calls = await Promise.all(
      files.map(async (file) => {
        const text = await Bun.file(path.join(root, file)).text()
        return /\bBun\.fetch\s*\(|import\s*\{[^}]*\bfetch\b[^}]*\}\s*from\s*["']bun["']/.test(text) ? [file] : []
      }),
    )
    expect(calls.flat()).toEqual([])
  })
})
