import { afterEach, describe, expect, test } from "bun:test"
import { LocalDetect } from "../../src/local-mode/detect"
import { LocalPolicy } from "../../src/local-mode/policy"
import { LocalProbe } from "../../src/local-mode/probe"
import { LocalServers } from "../fixture/local-servers/serve"
import { NetworkGuard } from "../lib/network-guard"

// Find servers only ever asks this computer. The strict guard refuses and records any other host, so every test here
// ends by checking that it recorded none.
const guard = NetworkGuard.use()

const fakes: LocalServers.Fake[] = []
const others: { stop: (force?: boolean) => Promise<void> }[] = []
afterEach(async () => {
  await Promise.all([
    ...fakes.splice(0).map((fake) => fake.close()),
    ...others.splice(0).map((item) => item.stop(true)),
  ])
})

async function closedPort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = server.port ?? 0
  await server.stop(true)
  return port
}

describe("Find servers", () => {
  test("asks only 127.0.0.1 and ::1, on each kind's usual port", () => {
    expect(LocalDetect.HOSTS).toEqual(["127.0.0.1", "[::1]"])
    expect(LocalDetect.PORTS).toEqual([11434, 1234, 8000, 8080, 30000])
    const targets = LocalDetect.targets()
    expect(targets).toHaveLength(10)
    targets.forEach((url) => expect(LocalPolicy.loopback(new URL(url).hostname)).toBe(true))
  })

  test("finds each server answering on this computer, and nothing where nothing answers", async () => {
    const ollama = await LocalServers.serve("ollama")
    const llamacpp = await LocalServers.serve("llamacpp")
    fakes.push(ollama, llamacpp)
    const closed = await closedPort()
    const found = await LocalDetect.detect({ ports: [ollama.port, llamacpp.port, closed] })
    expect(found.map((server) => [server.kind, server.origin])).toEqual([
      ["ollama", ollama.origin],
      ["llamacpp", llamacpp.origin],
    ])
    // Each port was asked on both loopback addresses, and on no other host.
    const hosts = new Set(guard.attempts().map((attempt) => attempt.host.replace(/^\[|\]$/g, "")))
    expect([...hosts].every((host) => host === "127.0.0.1" || host === "::1")).toBe(true)
    expect(hosts.has("::1")).toBe(true)
    expect(guard.outside()).toEqual([])
  })

  test("gives a server 400 ms to answer before moving on", async () => {
    const silent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) })
    others.push(silent)
    const started = performance.now()
    expect(await LocalDetect.detect({ ports: [silent.port ?? 0] })).toEqual([])
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("keeps its short wait: an Ollama server slower than 400 ms to say its version is not found", async () => {
    const version = (await LocalServers.load("ollama")).interactions.find((item) =>
      item.request.url.endsWith("/api/version"),
    )!
    const slow = await LocalServers.serve("ollama", {
      routes: {
        "GET /api/version": async () => {
          await Bun.sleep(LocalProbe.IDENTIFY_TIMEOUT.loopback + 200)
          return new Response(version.response.body, {
            status: version.response.status,
            headers: version.response.headers,
          })
        },
      },
    })
    fakes.push(slow)
    // With the long wait for one address, this server would be found.
    expect(await LocalDetect.detect({ ports: [slow.port] })).toEqual([])
  })

  test("lists a server that answers on both loopback addresses once, at 127.0.0.1", async () => {
    const v4 = await LocalServers.serve("vllm")
    fakes.push(v4)
    const v6 = await LocalServers.serve("vllm", { hostname: "::1", port: v4.port }).catch(() => undefined)
    if (!v6) return
    fakes.push(v6)
    const found = await LocalDetect.detect({ ports: [v4.port] })
    expect(found.map((server) => server.origin)).toEqual([v4.origin])
    expect(v6.hits().length).toBeGreaterThan(0)
  })

  test("recorded no host outside this computer", () => {
    expect(guard.outside()).toEqual([])
  })
})
