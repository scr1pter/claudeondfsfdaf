import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  blockedAddress,
  blockedHostname,
  nodeTransport,
  safeFetch,
  SafeFetchError,
  type SafeTransport,
  type SafeTransportRequest,
} from "../api/_lib/safe-fetch"

// WP A37, invariant S8: outbound fetches the server makes on someone's behalf (push endpoints, domain verification)
// refuse private, loopback, link-local and metadata addresses, connect only to the address they checked, and never
// follow a redirect. The resolver and the connection are fakes here, except one case that opens a local socket to
// prove the default connection goes to the checked address and not to a fresh lookup.

const PUBLIC_V4 = "93.184.215.14"
const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c"

function recorder(answer: Partial<Awaited<ReturnType<SafeTransport>>> = {}) {
  const calls: SafeTransportRequest[] = []
  const transport: SafeTransport = async (request) => {
    calls.push(request)
    return { status: 201, headers: {}, body: new TextEncoder().encode("ok"), ...answer }
  }
  return { calls, transport }
}

const resolveTo =
  (...addresses: string[]) =>
  async () =>
    addresses

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(SafeFetchError)
  return (error as SafeFetchError).reason
}

describe("the SSRF address list", () => {
  const blocked = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.100.100.200", // Alibaba Cloud metadata
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254", // AWS, GCP and Azure metadata
    "169.254.170.2", // ECS task metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.192", // Oracle Cloud metadata
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "168.63.129.16", // Azure host services
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe", // NAT64 of the metadata address
    "100::1",
    "fc00::1",
    "fd00:ec2::254", // AWS IPv6 metadata
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "2001::1", // Teredo
    "2001:db8::1",
    "2002:7f00:1::1", // 6to4 around 127.0.0.1
    "3fff::1",
    "not-an-address",
    "1.2.3",
  ]
  for (const address of blocked) test(`refuses ${address}`, () => expect(blockedAddress(address)).toBe(true))

  for (const address of [PUBLIC_V4, "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", PUBLIC_V6, "::ffff:8.8.8.8"])
    test(`allows ${address}`, () => expect(blockedAddress(address)).toBe(false))

  test("refuses host names for this machine, private zones, metadata and single labels", () => {
    for (const name of [
      "localhost",
      "LOCALHOST.",
      "app.localhost",
      "printer.local",
      "metadata.google.internal",
      "metadata.goog",
      "metadata",
      "intranet",
      "1.0.0.127.in-addr.arpa",
      "router.home",
      "nas.lan",
      "box.localdomain",
    ])
      expect(blockedHostname(name)).toBe(true)
    for (const name of ["fcm.googleapis.com", "web.push.apple.com", "example.com"])
      expect(blockedHostname(name)).toBe(false)
  })
})

describe("safeFetch", () => {
  test("connects to the checked public address and keeps the host for TLS and the Host header", async () => {
    const { calls, transport } = recorder()
    const answer = await safeFetch(
      "https://push.example.com/send/abc?x=1",
      { method: "POST", headers: { TTL: "60", Host: "evil.example", "Content-Length": "999" }, body: "hi" },
      { resolve: resolveTo(PUBLIC_V4, PUBLIC_V6), transport },
    )
    expect(answer.status).toBe(201)
    expect(await answer.text()).toBe("ok")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.address).toBe(PUBLIC_V4)
    expect(calls[0]!.url.host).toBe("push.example.com")
    expect(calls[0]!.method).toBe("POST")
    // The caller cannot redirect the connection or forge the framing.
    expect(calls[0]!.headers).toEqual({ ttl: "60" })
    expect(new TextDecoder().decode(calls[0]!.body)).toBe("hi")
    expect(calls[0]!.timeoutMs).toBe(10_000)
  })

  test("refuses private, loopback, link-local and metadata targets before any connection", async () => {
    const { calls, transport } = recorder()
    const urls = [
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[fd00:ec2::254]/",
      "https://2130706433/", // 127.0.0.1 written as one number
      "https://0x7f.0.0.1/", // and in hex
      "https://017700000001/", // and in octal
      "https://0/",
      "https://localhost/",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://printer.local/",
    ]
    for (const url of urls)
      expect(await refusal(safeFetch(url, {}, { resolve: resolveTo(PUBLIC_V4), transport }))).toBe("address")
    expect(calls).toHaveLength(0)
  })

  test("refuses a host name that resolves to a private address, even next to a public one (rebinding and mixed sets)", async () => {
    const { calls, transport } = recorder()
    for (const addresses of [
      ["10.0.0.5"],
      ["169.254.169.254"],
      [PUBLIC_V4, "127.0.0.1"],
      ["::1"],
      [PUBLIC_V6, "fe80::1"],
    ])
      expect(
        await refusal(safeFetch("https://push.example.com/", {}, { resolve: resolveTo(...addresses), transport })),
      ).toBe("address")
    expect(await refusal(safeFetch("https://push.example.com/", {}, { resolve: resolveTo(), transport }))).toBe(
      "network",
    )
    expect(
      await refusal(
        safeFetch(
          "https://push.example.com/",
          {},
          {
            resolve: async () => {
              throw new Error("ENOTFOUND")
            },
            transport,
          },
        ),
      ),
    ).toBe("network")
    expect(calls).toHaveLength(0)
  })

  test("refuses other schemes, other ports and credentials in the URL", async () => {
    const { calls, transport } = recorder()
    const options = { resolve: resolveTo(PUBLIC_V4), transport }
    for (const url of [
      "http://push.example.com/",
      "ftp://push.example.com/",
      "file:///etc/passwd",
      "https://push.example.com:8443/",
      "https://user:secret@push.example.com/",
      "not a url",
    ])
      expect(await refusal(safeFetch(url, {}, options))).toBe("url")
    expect(calls).toHaveLength(0)
    await safeFetch("https://push.example.com:8443/", {}, { ...options, ports: [443, 8443] })
    expect(calls).toHaveLength(1)
  })

  test("never follows a redirect: a 3xx answer is an error and nothing else is fetched", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { calls, transport } = recorder({ status, headers: { location: "https://169.254.169.254/" } })
      expect(
        await refusal(safeFetch("https://push.example.com/", {}, { resolve: resolveTo(PUBLIC_V4), transport })),
      ).toBe("redirect")
      expect(calls).toHaveLength(1)
    }
  })

  test("answers 404, 410 and 5xx as they are, and 204 with no body", async () => {
    for (const status of [404, 410, 429, 500, 503]) {
      const { transport } = recorder({ status })
      expect(
        (await safeFetch("https://push.example.com/", {}, { resolve: resolveTo(PUBLIC_V4), transport })).status,
      ).toBe(status)
    }
    const { transport } = recorder({ status: 204 })
    const empty = await safeFetch("https://push.example.com/", {}, { resolve: resolveTo(PUBLIC_V4), transport })
    expect(empty.status).toBe(204)
    expect(await empty.text()).toBe("")
  })

  test("passes its timeout and size cap to the connection, and IP literals skip the resolver", async () => {
    const { calls, transport } = recorder()
    let resolved = 0
    await safeFetch(
      `https://${PUBLIC_V4}/x`,
      {},
      {
        resolve: async () => {
          resolved++
          return [PUBLIC_V4]
        },
        transport,
        timeoutMs: 2_500,
        maxResponseBytes: 512,
      },
    )
    expect(resolved).toBe(0)
    expect(calls[0]).toMatchObject({ address: PUBLIC_V4, timeoutMs: 2_500, maxBytes: 512 })
  })
})

describe("the default connection", () => {
  test("opens its socket to the checked address, not to whatever the name resolves to now", async () => {
    // A plain TCP listener on loopback stands in for the checked address. The URL names a host that does not exist;
    // the connection still reaches the listener because it never looks the name up again. TLS then fails, as it
    // should against a listener with no certificate for that name.
    const connected: string[] = []
    const server = createServer((socket) => {
      connected.push(String(socket.remoteAddress))
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    try {
      const outcome = await nodeTransport({
        url: new URL(`https://pinned-host.invalid:${port}/send`),
        address: "127.0.0.1",
        method: "POST",
        headers: {},
        body: new TextEncoder().encode("x"),
        timeoutMs: 5_000,
        maxBytes: 1024,
      }).then(
        () => "answered",
        (error: unknown) => (error instanceof SafeFetchError ? error.reason : "other"),
      )
      expect(outcome).toBe("network")
      expect(connected).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("gives up after its timeout", async () => {
    const sockets: { destroy(): void }[] = []
    const server = createServer((socket) => {
      sockets.push(socket) // accepts and never answers
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    try {
      const started = Date.now()
      const outcome = await nodeTransport({
        url: new URL(`https://silent-host.invalid:${port}/`),
        address: "127.0.0.1",
        method: "GET",
        headers: {},
        timeoutMs: 300,
        maxBytes: 1024,
      }).then(
        () => "answered",
        (error: unknown) => (error instanceof SafeFetchError ? error.reason : "other"),
      )
      expect(outcome).toBe("timeout")
      expect(Date.now() - started).toBeLessThan(4_000)
    } finally {
      sockets.forEach((socket) => socket.destroy())
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
