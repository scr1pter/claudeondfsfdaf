import { describe, expect, test } from "bun:test"
import { blockedAddress, blockedHostname, DOH_ENDPOINT, probeTarget, resolvePublic, validHostname } from "../src/ssrf"

// WP A46, S8: probes go only to https on 443, to a host name the account verified (exactly), whose every address is on
// the public internet. The same address list as the API's safe-fetch.ts.

const VERIFIED = new Set(["status.vector-fixture.com", "vector-fixture.com"])

describe("probe targets", () => {
  test("https on 443 to a verified host passes, normalised and without its fragment", () => {
    expect(probeTarget("https://status.vector-fixture.com/health?full=1#top", VERIFIED)).toEqual({
      ok: true,
      url: "https://status.vector-fixture.com/health?full=1",
      host: "status.vector-fixture.com",
    })
    expect(probeTarget("https://STATUS.vector-fixture.com:443/", VERIFIED)).toEqual({
      ok: true,
      url: "https://status.vector-fixture.com/",
      host: "status.vector-fixture.com",
    })
    expect(probeTarget("https://vector-fixture.com./", VERIFIED)).toMatchObject({
      ok: true,
      host: "vector-fixture.com",
    })
    // The parser's own spelling is what is checked and fetched: an empty userinfo, a zero-padded port, upper case, and
    // a backslash, which the parser reads as a slash, so "@evil.example" is a path on the verified host.
    for (const [input, url] of [
      ["https://@status.vector-fixture.com/", "https://status.vector-fixture.com/"],
      ["https://status.vector-fixture.com:0443/", "https://status.vector-fixture.com/"],
      ["HTTPS://STATUS.VECTOR-FIXTURE.COM/", "https://status.vector-fixture.com/"],
      ["https://status.vector-fixture.com\\@evil.example/", "https://status.vector-fixture.com/@evil.example/"],
    ] as const)
      expect({ input, target: probeTarget(input, VERIFIED) }).toEqual({
        input,
        target: { ok: true, url, host: "status.vector-fixture.com" },
      })
  })

  test("only verified hosts, matched exactly: no subdomain and no parent", () => {
    expect(probeTarget("https://api.vector-fixture.com/", VERIFIED)).toEqual({ ok: false, reason: "not-verified" })
    expect(probeTarget("https://www.status.vector-fixture.com/", VERIFIED)).toEqual({
      ok: false,
      reason: "not-verified",
    })
    expect(probeTarget("https://other-site.com/", VERIFIED)).toEqual({ ok: false, reason: "not-verified" })
    expect(probeTarget("https://status.vector-fixture.com/", new Set())).toEqual({ ok: false, reason: "not-verified" })
  })

  test("the SSRF list: schemes, ports, credentials, IP literals in every spelling, private names", () => {
    const refused: Array<[string, string]> = [
      ["http://status.vector-fixture.com/", "scheme"],
      ["ftp://status.vector-fixture.com/", "scheme"],
      ["file:///etc/passwd", "scheme"],
      ["https://status.vector-fixture.com:8443/", "port"],
      ["https://status.vector-fixture.com:80/", "port"],
      ["https://user:pass@status.vector-fixture.com/", "credentials"],
      ["https://127.0.0.1/", "address"],
      ["https://2130706433/", "address"],
      ["https://0x7f.0.0.1/", "address"],
      ["https://0177.0.0.1/", "address"],
      ["https://127.1/", "address"],
      ["https://169.254.169.254/latest/meta-data/", "address"],
      ["https://10.0.0.8/", "address"],
      ["https://[::1]/", "address"],
      ["https://[::ffff:127.0.0.1]/", "address"],
      ["https://[fd00::1]/", "address"],
      ["https://[2606:4700::1111]/", "address"],
      ["https://8.8.8.8/", "address"],
      ["https://localhost/", "address"],
      ["https://app.localhost/", "address"],
      ["https://printer.local/", "address"],
      ["https://metadata.google.internal/", "address"],
      ["https://metadata.goog/", "address"],
      ["https://db.internal/", "address"],
      ["https://1.0.0.10.in-addr.arpa/", "address"],
      ["https://intranet/", "address"],
      ["https://router.lan/", "address"],
      ["https://site.test/", "address"],
      ["https://site.invalid/", "address"],
      ["https://0x7f000001/", "address"],
      ["https://127.0.0.1./", "address"],
      ["https://%31%32%37.0.0.1/", "address"],
      ["https://\uff11\uff12\uff17.0.0.1/", "address"],
      ["https://0.1.2.3/", "address"],
      ["https://100.127.255.254/", "address"],
      ["https://169.254.0.1/", "address"],
      ["https://[fe80::1]/", "address"],
      ["https://[fc00::1]/", "address"],
      ["https://[::ffff:7f00:1]/", "address"],
      ["https://[64:ff9b::a9fe:a9fe]/", "address"],
      ["https://LOCALHOST./", "address"],
      ["https://metadata.google.internal./", "address"],
      ["https://localhost../", "address"],
      ["https://\u24dbocalhost/", "address"],
      ["https://user@status.vector-fixture.com/", "credentials"],
      ["https://:secret@status.vector-fixture.com/", "credentials"],
      ["wss://status.vector-fixture.com/", "scheme"],
      ["javascript:alert(1)", "scheme"],
      ["data:text/plain,x", "scheme"],
      ["https://[fe80::1%25eth0]/", "url"],
      ["not a url", "url"],
      [`https://status.vector-fixture.com/${"a".repeat(2048)}`, "url"],
    ]
    for (const [url, reason] of refused)
      expect({ url, target: probeTarget(url, VERIFIED) as unknown }).toEqual({ url, target: { ok: false, reason } })
    expect(probeTarget(42)).toEqual({ ok: false, reason: "url" })
  })

  test("verified domains are lower-case host names of two or more labels, never addresses or private names", () => {
    for (const name of ["vector-fixture.com", "status.vector-fixture.com", "xn--bcher-kva.example-shop.de"])
      expect({ name, valid: validHostname(name) }).toEqual({ name, valid: true })
    for (const name of [
      "Vector-Fixture.com",
      "localhost",
      "com",
      "1.2.3.4",
      "a..b",
      "-a.com",
      "a-.com",
      "x.local",
      "",
      7,
    ])
      expect({ name, valid: validHostname(name) }).toEqual({ name, valid: false })
    expect(validHostname(`${"a".repeat(64)}.com`)).toBe(false)
    expect(blockedHostname("METADATA.GOOGLE.INTERNAL.")).toBe(true)
  })
})

describe("addresses", () => {
  test("private, loopback, link-local, metadata, documentation and reserved addresses are refused", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.192",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "255.255.255.255",
      "168.63.129.16",
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::a00:1",
      "2001::1",
      "2001:db8::1",
      "2002:a00:1::1",
      "3fff::1",
      "fe80::1%eth0",
      "0.1.2.3",
      "100.127.255.255",
      "169.254.0.1",
      "febf::1",
      "fdff:ffff::1",
      "::ffff:0:7f00:1",
      "64:ff9b:1::1",
      "::127.0.0.1",
      "::ffff:7f00:1",
      "2001:db8:ffff::1",
      "999.1.1.1",
      "not-an-address",
    ])
      expect({ address, blocked: blockedAddress(address) }).toEqual({ address, blocked: true })
  })

  test("public addresses pass", () => {
    for (const address of [
      "8.8.8.8",
      "104.16.132.229",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700::6810:84e5",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
    ])
      expect({ address, blocked: blockedAddress(address) }).toEqual({ address, blocked: false })
  })
})

describe("DNS-over-HTTPS lookups", () => {
  function doh(answers: Record<"A" | "AAAA", unknown>) {
    const asked: string[] = []
    const fetch = async (url: string, init: RequestInit) => {
      asked.push(url)
      expect(url.startsWith(`${DOH_ENDPOINT}?name=`)).toBe(true)
      expect(new Headers(init.headers).get("accept")).toBe("application/dns-json")
      expect(init.redirect).toBe("manual")
      const type = new URL(url).searchParams.get("type") as "A" | "AAAA"
      const answer = answers[type]
      if (answer instanceof Response) return answer
      if (answer instanceof Error) throw answer
      return Response.json(answer)
    }
    return { fetch, asked }
  }
  const record = (type: number, data: string, TTL = 300) => ({ name: "status.vector-fixture.com", type, TTL, data })

  test("every address public: probe, reusing the answer for its TTL within 60 s to 5 minutes", async () => {
    const { fetch, asked } = doh({
      A: { Status: 0, Answer: [record(5, "edge.cdn-fixture.net."), record(1, "104.16.132.229", 30)] },
      AAAA: { Status: 0, Answer: [record(28, "2606:4700::6810:84e5", 9_000)] },
    })
    expect(await resolvePublic("status.vector-fixture.com", fetch)).toEqual({ kind: "public", ttlMs: 60_000 })
    expect(asked.map((url) => new URL(url).searchParams.get("type")).sort()).toEqual(["A", "AAAA"])
    const long = doh({ A: { Status: 0, Answer: [record(1, "104.16.132.229", 9_000)] }, AAAA: { Status: 0 } })
    expect(await resolvePublic("status.vector-fixture.com", long.fetch)).toEqual({ kind: "public", ttlMs: 300_000 })
  })

  test("one private address among public ones blocks the host, whichever kind it is", async () => {
    const v4 = doh({
      A: { Status: 0, Answer: [record(1, "104.16.132.229"), record(1, "127.0.0.1")] },
      AAAA: { Status: 0 },
    })
    expect(await resolvePublic("status.vector-fixture.com", v4.fetch)).toEqual({ kind: "blocked" })
    const v6 = doh({
      A: { Status: 0, Answer: [record(1, "104.16.132.229")] },
      AAAA: { Status: 0, Answer: [record(28, "::1")] },
    })
    expect(await resolvePublic("status.vector-fixture.com", v6.fetch)).toEqual({ kind: "blocked" })
    const metadata = doh({ A: { Status: 0, Answer: [record(1, "169.254.169.254")] }, AAAA: { Status: 0 } })
    expect(await resolvePublic("status.vector-fixture.com", metadata.fetch)).toEqual({ kind: "blocked" })
  })

  test("a name with no address is missing (the site's outage); a failed lookup is an error (ours)", async () => {
    expect(
      await resolvePublic("gone.vector-fixture.com", doh({ A: { Status: 3 }, AAAA: { Status: 3 } }).fetch),
    ).toEqual({
      kind: "missing",
    })
    expect(
      await resolvePublic("bare.vector-fixture.com", doh({ A: { Status: 0 }, AAAA: { Status: 0 } }).fetch),
    ).toEqual({
      kind: "missing",
    })
    expect(await resolvePublic("x.vector-fixture.com", doh({ A: { Status: 2 }, AAAA: { Status: 2 } }).fetch)).toEqual({
      kind: "error",
    })
    expect(
      await resolvePublic(
        "x.vector-fixture.com",
        doh({ A: new Response("no", { status: 502 }), AAAA: { Status: 3 } }).fetch,
      ),
    ).toEqual({ kind: "error" })
    expect(
      await resolvePublic("x.vector-fixture.com", doh({ A: new TypeError("down"), AAAA: new TypeError("down") }).fetch),
    ).toEqual({
      kind: "error",
    })
    expect(
      await resolvePublic("x.vector-fixture.com", doh({ A: new Response("not json"), AAAA: { Status: 0 } }).fetch),
    ).toEqual({ kind: "error" })
  })

  test("a lookup that failed for either kind leaves the host unknown; a private address still refuses it", async () => {
    const v4 = { Status: 0, Answer: [record(1, "104.16.132.229")] }
    const v6 = { Status: 0, Answer: [record(28, "2606:4700::6810:84e5")] }
    for (const [name, answers, kind] of [
      ["A public, AAAA SERVFAIL", { A: v4, AAAA: { Status: 2 } }, "error"],
      ["A 502, AAAA public", { A: new Response("no", { status: 502 }), AAAA: v6 }, "error"],
      ["A SERVFAIL, AAAA public", { A: { Status: 2 }, AAAA: v6 }, "error"],
      [
        "A private, AAAA SERVFAIL",
        { A: { Status: 0, Answer: [record(1, "127.0.0.1")] }, AAAA: { Status: 2 } },
        "blocked",
      ],
    ] as const)
      expect({ name, resolution: await resolvePublic("status.vector-fixture.com", doh(answers).fetch) }).toEqual({
        name,
        resolution: { kind },
      })
  })

  test("an answer cut short (TC) is a failed lookup", async () => {
    const { fetch } = doh({ A: { Status: 0, TC: true, Answer: [record(1, "104.16.132.229")] }, AAAA: { Status: 0 } })
    expect(await resolvePublic("status.vector-fixture.com", fetch)).toEqual({ kind: "error" })
  })

  test("an answer is read only to 64 KiB as it arrives, counted in bytes, and must be UTF-8", async () => {
    const answer = { Status: 0, Answer: [record(1, "104.16.132.229")] }
    // 40,000 two-byte characters: 80 KB on the wire, though under 64 Ki characters.
    const padded = doh({ A: { ...answer, pad: "\u00e9".repeat(40_000) }, AAAA: { Status: 0 } })
    expect(await resolvePublic("status.vector-fixture.com", padded.fetch)).toEqual({ kind: "error" })

    // An answer of exactly 64 KiB is read to its end and used; one byte more is a failed lookup.
    const exactly = (bytes: number) => {
      const body = JSON.stringify({ ...answer, pad: "" })
      return doh({ A: { ...answer, pad: " ".repeat(bytes - body.length) }, AAAA: { Status: 0 } })
    }
    expect(await resolvePublic("status.vector-fixture.com", exactly(64 * 1024).fetch)).toMatchObject({ kind: "public" })
    expect(await resolvePublic("status.vector-fixture.com", exactly(64 * 1024 + 1).fetch)).toEqual({ kind: "error" })

    // 1 MiB in 1 KiB chunks. A stream with no buffer ahead (highWaterMark 0) is pulled once per read, so 65 pulls
    // pass 64 KiB and the rest is cancelled unread.
    const stream = { pulled: 0, cancelled: 0 }
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          stream.pulled++
          if (stream.pulled > 1024) return controller.close()
          controller.enqueue(new Uint8Array(1024).fill(0x20))
        },
        cancel() {
          stream.cancelled++
        },
      },
      { highWaterMark: 0 },
    )
    const large = doh({ A: new Response(endless), AAAA: { Status: 0 } })
    expect(await resolvePublic("status.vector-fixture.com", large.fetch)).toEqual({ kind: "error" })
    expect(stream).toEqual({ pulled: 65, cancelled: 1 })

    // One 0xff byte, which UTF-8 never has, in place of the note's "~".
    const json = new TextEncoder().encode(JSON.stringify({ ...answer, note: "~" }))
    const bad = json.map((byte) => (byte === 0x7e ? 0xff : byte))
    const invalid = doh({ A: new Response(bad), AAAA: { Status: 0 } })
    expect(await resolvePublic("status.vector-fixture.com", invalid.fetch)).toEqual({ kind: "error" })
    // The same answer in valid UTF-8 is public.
    const valid = doh({ A: new Response(json), AAAA: { Status: 0 } })
    expect(await resolvePublic("status.vector-fixture.com", valid.fetch)).toMatchObject({ kind: "public" })
  })
})
