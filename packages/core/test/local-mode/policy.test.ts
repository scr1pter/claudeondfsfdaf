import { describe, expect, test } from "bun:test"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { providerUnavailable } from "@vectordevai/schema/provider-unavailable"
import { LocalPolicy } from "../../src/local-mode/policy"
import type { ConfigLocalV1 } from "../../src/v1/config/local"

const LISTED = "http://127.0.0.1:11434"
const LAN_LISTED = "http://10.0.0.5:8000"

// Destinations the matrix decides for every purpose. `listed` is on the list; `loopback` and `lan` are not.
const PLACES = {
  listed: `${LISTED}/v1/chat/completions`,
  lanListed: `${LAN_LISTED}/v1/chat/completions`,
  loopback: "http://127.0.0.1:3000/",
  lan: "http://192.168.1.20/",
  internet: "https://example.com/page",
  vector: "https://vectordev.ai/api/free-models/chat",
} as const
type Place = keyof typeof PLACES

const policyFor = (mode: "off" | LocalMode.Web | "locked") =>
  LocalPolicy.resolve({
    ...(mode === "locked"
      ? { managed: { lock: true, endpoints: [LISTED, LAN_LISTED] } }
      : {
          global: { enabled: mode !== "off", web: mode === "off" ? undefined : mode, endpoints: [LISTED, LAN_LISTED] },
        }),
  })

const decisions = (policy: LocalMode.Policy, purpose: LocalMode.Purpose, extra: Partial<LocalPolicy.Request> = {}) =>
  Object.fromEntries(
    (Object.keys(PLACES) as Place[]).map((place) => [
      place,
      LocalPolicy.decide(policy, { purpose, url: PLACES[place], ...extra }).decision,
    ]),
  ) as Record<Place, LocalMode.Decision>

const all = (decision: LocalMode.Decision) =>
  Object.fromEntries(Object.keys(PLACES).map((place) => [place, decision])) as Record<Place, LocalMode.Decision>

describe("LocalPolicy.decide matrix", () => {
  test("Local off allows every purpose to every destination", () => {
    const policy = policyFor("off")
    for (const purpose of LocalMode.Purpose.literals)
      expect({ purpose, ...decisions(policy, purpose) }).toEqual({ purpose, ...all("allow") })
  })

  for (const mode of ["ask", "network", "none", "locked"] as const) {
    describe(`Local on, Web access ${mode}`, () => {
      const policy = policyFor(mode)
      const web = mode === "locked" ? "ask" : mode

      test("model calls go only to listed origins, never to vectordev.ai", () => {
        expect(decisions(policy, "inference")).toEqual({
          listed: "allow",
          lanListed: "allow",
          loopback: "block",
          lan: "block",
          internet: "block",
          vector: "block",
        })
      })

      test("web pages, the browser and the research reader follow Web access, with loopback always open", () => {
        const expected = (
          {
            ask: {
              listed: "allow",
              lanListed: "allow",
              loopback: "allow",
              lan: "allow",
              internet: "allow",
              vector: "allow",
            },
            network: {
              listed: "allow",
              lanListed: "allow",
              loopback: "allow",
              lan: "allow",
              internet: "block",
              vector: "block",
            },
            none: {
              listed: "allow",
              lanListed: "block",
              loopback: "allow",
              lan: "block",
              internet: "block",
              vector: "block",
            },
          } as const
        )[web]
        for (const purpose of ["web-page", "browser", "research-reader"] as const)
          expect({ purpose, ...decisions(policy, purpose) }).toEqual({ purpose, ...expected })
      })

      test("web search obeys Web access everywhere and reaches only listed servers", () => {
        expect(decisions(policy, "web-search")).toEqual(
          web === "none"
            ? all("block")
            : {
                listed: "allow",
                lanListed: "allow",
                loopback: "block",
                lan: "block",
                internet: "block",
                vector: "block",
              },
        )
      })

      test("Vector's own services are blocked off this computer", () => {
        for (const purpose of [
          "catalog",
          "policy",
          "account",
          "usage",
          "crash",
          "telemetry",
          "support",
          "release-notes",
          "asset",
          "help",
          "share",
        ] as const)
          expect({ purpose, ...decisions(policy, purpose) }).toEqual({
            purpose,
            listed: "allow",
            lanListed: "block",
            loopback: "allow",
            lan: "block",
            internet: "block",
            vector: "block",
          })
      })

      test("automatic update checks are blocked, a manual check asks, and None checks nothing", () => {
        expect(decisions(policy, "updates").internet).toBe("block")
        expect(decisions(policy, "updates", { manual: true }).internet).toBe(web === "none" ? "block" : "ask")
      })

      test("downloads ask once unless they come from the list, and None downloads nothing", () => {
        for (const purpose of ["model-download", "tool-download", "plugin", "lsp-install"] as const) {
          expect({ purpose, ...decisions(policy, purpose) }).toEqual({
            purpose,
            listed: "allow",
            lanListed: "allow",
            loopback: "allow",
            lan: "ask",
            internet: web === "none" ? "block" : "ask",
            vector: web === "none" ? "block" : "ask",
          })
          expect(decisions(policy, purpose, { granted: true }).internet).toBe(web === "none" ? "block" : "allow")
        }
      })

      test("Vector's git requests reach private servers only, unless a server is allowed", () => {
        expect(decisions(policy, "git-remote")).toEqual({
          listed: "allow",
          lanListed: "allow",
          loopback: "allow",
          lan: "allow",
          internet: "block",
          vector: "block",
        })
      })

      test("integrations, MCP and remote config need this computer, the list or an allowed source", () => {
        for (const purpose of ["integration", "mcp", "config-remote"] as const)
          expect({ purpose, ...decisions(policy, purpose) }).toEqual({
            purpose,
            listed: "allow",
            lanListed: "allow",
            loopback: "allow",
            lan: "block",
            internet: "block",
            vector: "block",
          })
      })

      test("an unlabelled request reaches only this computer and the list", () => {
        expect(decisions(policy, "unknown")).toEqual({
          listed: "allow",
          lanListed: "allow",
          loopback: "allow",
          lan: "block",
          internet: "block",
          vector: "block",
        })
      })
    })
  }

  test("an allow entry opens its own source, narrowed to its hosts, except in None", () => {
    const allow = [
      { source: "github", hosts: ["github.com"], reason: "Pull requests", added_at: 1, added_by: "app" as const },
    ]
    const ask = LocalPolicy.resolve({ global: { enabled: true, allow } })
    expect(
      LocalPolicy.decide(ask, { purpose: "integration", url: "https://api.github.com/repos", source: "github" }),
    ).toMatchObject({
      decision: "allow",
      rule: "allowed-source",
    })
    expect(
      LocalPolicy.decide(ask, { purpose: "integration", url: "https://gitlab.com/", source: "github" }).decision,
    ).toBe("block")
    expect(
      LocalPolicy.decide(ask, { purpose: "integration", url: "https://github.com/", source: "gitlab" }).decision,
    ).toBe("block")
    const none = LocalPolicy.resolve({ global: { enabled: true, web: "none", allow } })
    expect(
      LocalPolicy.decide(none, { purpose: "integration", url: "https://github.com/", source: "github" }).decision,
    ).toBe("block")
  })

  // Lead ruling R1-0 (cl-vector-local): the registry's hosts are the ones a source usually reaches, not a limit, so an
  // entry with no hosts covers a host the registry does not list, such as a GitHub Enterprise server. The app and the
  // CLI say so (allowHosts).
  test("an allow entry without hosts opens its source for any host it reaches", () => {
    const allow = [{ source: "github", reason: "Pull requests", added_at: 1, added_by: "app" as const }]
    const policy = LocalPolicy.resolve({ global: { enabled: true, allow } })
    const url = "https://github.example.com/api/v3"
    expect(LocalPolicy.decide(policy, { purpose: "integration", url, source: "github" })).toMatchObject({
      decision: "allow",
      rule: "allowed-source",
    })
    expect(LocalPolicy.decide(policy, { purpose: "integration", url, source: "gitlab" }).decision).toBe("block")
  })

  test("a source the registry marks not allowable stays blocked whatever is allowed, unless the company lists its model server", () => {
    const allow = [{ source: "vector-free-models", reason: "Try it", added_at: 1, added_by: "app" as const }]
    const user = LocalPolicy.resolve({ global: { enabled: true, allow, endpoints: ["https://openrouter.ai"] } })
    expect(
      LocalPolicy.decide(user, {
        purpose: "inference",
        url: "https://openrouter.ai/api/v1",
        source: "vector-free-models",
      }),
    ).toMatchObject({ decision: "block", rule: "not-allowable", allowable: false })
    const company = LocalPolicy.resolve({ managed: { enabled: true, endpoints: ["https://acme.openai.azure.com"] } })
    expect(
      LocalPolicy.decide(company, {
        purpose: "inference",
        url: "https://acme.openai.azure.com/openai",
        source: "cloud-inference",
      }),
    ).toMatchObject({ decision: "allow", rule: "listed" })
    // The company listed the server, not where these go: an Ollama server's cloud models and free models stay off.
    const servers = LocalPolicy.resolve({
      managed: { enabled: true, endpoints: ["http://gpu-box.internal:11434", "https://openrouter.ai"] },
    })
    expect(
      LocalPolicy.decide(servers, {
        purpose: "inference",
        url: "http://gpu-box.internal:11434/v1/chat/completions",
        source: "ollama-cloud-models",
      }),
    ).toMatchObject({ decision: "block", rule: "not-allowable" })
    expect(
      LocalPolicy.decide(servers, {
        purpose: "inference",
        url: "https://openrouter.ai/api/v1",
        source: "vector-free-models",
      }),
    ).toMatchObject({ decision: "block", rule: "not-allowable" })
  })

  test("a deny entry blocks a site in every mode, and a company list opens it in your-network mode", () => {
    const policy = LocalPolicy.resolve({
      managed: { web_domains: { allow: ["docs.example.com"] } },
      global: { enabled: true, web: "network", web_domains: { deny: ["bad.example.org"] } },
    })
    expect(LocalPolicy.decide(policy, { purpose: "web-page", url: "https://docs.example.com/a" }).decision).toBe(
      "allow",
    )
    expect(LocalPolicy.decide(policy, { purpose: "web-page", url: "https://bad.example.org/" }).rule).toBe("web-deny")
    expect(LocalPolicy.decide(policy, { purpose: "web-page", url: "https://other.example.com/" }).decision).toBe(
      "block",
    )
  })

  test("a company update mirror is allowed even in None", () => {
    const policy = LocalPolicy.resolve({
      managed: { enabled: true, web: "none", updates: { url: "https://mirror.corp.example.com/vector/" } },
    })
    expect(
      LocalPolicy.decide(policy, { purpose: "updates", url: "https://mirror.corp.example.com/vector/latest.yml" }),
    ).toMatchObject({
      decision: "allow",
      rule: "mirror",
    })
  })

  test("until the policy is read, only this computer is reachable", () => {
    for (const purpose of LocalMode.Purpose.literals) {
      expect(LocalPolicy.decide(LocalPolicy.PENDING, { purpose, url: "http://127.0.0.1:9/" }).decision).toBe("allow")
      expect(LocalPolicy.decide(LocalPolicy.PENDING, { purpose, url: "http://10.0.0.5/" }).decision).toBe("block")
    }
  })

  test("a request with no http address is blocked", () => {
    expect(LocalPolicy.decide(policyFor("ask"), { purpose: "web-page", url: "file:///etc/passwd" }).decision).toBe(
      "block",
    )
    expect(LocalPolicy.decide(policyFor("ask"), { purpose: "web-page", url: "not a url" }).decision).toBe("block")
  })
})

describe("LocalPolicy.hostClass", () => {
  test("reads every spelling of this computer", () => {
    for (const host of [
      "localhost",
      "localhost.",
      "LOCALHOST",
      "127.0.0.1",
      "127.0.0.1.",
      "127.1",
      "0x7f.0.0.1",
      "0x7f000001",
      "2130706433",
      "017700000001",
      "0177.0.0.1",
      "0.0.0.0",
      "0",
      "::1",
      "[::1]",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "[::FFFF:127.0.0.9]",
    ])
      expect({ host, class: LocalPolicy.hostClass(host) }).toEqual({ host, class: "this-computer" })
  })

  test("reads private addresses, local names and Tailscale names as your network", () => {
    for (const host of [
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.10",
      "169.254.1.1",
      "::ffff:10.0.0.1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%en0",
      "gpu-box",
      "gpu-box.",
      "printer.local",
      "nas.lan",
      "build.internal",
      "router.home.arpa",
      "box.tail1234.ts.net",
    ])
      expect({ host, class: LocalPolicy.hostClass(host) }).toEqual({ host, class: "your-network" })
  })

  test("keeps shared ISP space, public addresses and look-alike names on the internet", () => {
    for (const host of [
      "100.64.0.1",
      "100.127.255.254",
      "172.32.0.1",
      "8.8.8.8",
      "198.51.100.7",
      "::ffff:8.8.8.8",
      "2001:4860:4860::8888",
      "64:ff9b::7f00:1",
      "::127.0.0.1",
      "example.com",
      "127.0.0.1.nip.io",
      "localhost.example.com",
      // A name under localhost is answered by whatever resolver is in use, which may ask upstream DNS.
      "dev.localhost",
      "ts.net.example.com",
      "1.2.3.256",
      "evil.com/@127.0.0.1",
      "",
    ])
      expect({ host, class: LocalPolicy.hostClass(host) }).toEqual({ host, class: "internet" })
  })

  test("judges a whole name: a % is a zone on an IPv6 address and nowhere else", () => {
    for (const host of ["localhost%.evil.example", "127.0.0.1%evil.example", "localhost%25", "fe80::1%en0%x", "::1%"])
      expect({ host, name: LocalPolicy.host(host) }).toEqual({ host, name: undefined })
    for (const host of ["localhost%.evil.example", "127.0.0.1%evil.example"])
      expect({ host, class: LocalPolicy.hostClass(host) }).toEqual({ host, class: "internet" })
    expect(LocalPolicy.host("fe80::1%en0")).toBe("fe80::1")
    expect(LocalPolicy.hostClass("[::1%lo0]")).toBe("this-computer")
  })

  test("normalises punycode and case, so a look-alike name is not this computer", () => {
    expect(LocalPolicy.host("Bücher.Example")).toBe("xn--bcher-kva.example")
    // "localhost" with a Cyrillic o (U+043E): a single-label name on the network, never this computer.
    expect(LocalPolicy.hostClass(`l${String.fromCodePoint(0x43e)}calhost`)).not.toBe("this-computer")
  })

  test("lists an origin only when scheme, host and port match, after normalising", () => {
    const policy = LocalPolicy.resolve({
      global: { enabled: true, endpoints: ["http://LOCALHOST.:11434/", "http://[::1]:8080"] },
    })
    expect(LocalPolicy.classify(policy, "http://localhost:11434/api/chat")).toBe("listed")
    expect(LocalPolicy.classify(policy, "http://[0:0:0:0:0:0:0:1]:8080/v1")).toBe("listed")
    expect(LocalPolicy.classify(policy, "https://localhost:11434/")).toBe("this-computer")
    expect(LocalPolicy.classify(policy, "http://localhost:11435/")).toBe("this-computer")
  })

  test("reads wildcards and address ranges from managed config only", () => {
    const policy = LocalPolicy.resolve({
      managed: { endpoints: ["https://*.ml.corp.example.com", "10.20.0.0/16", "fd00::/8"] },
      global: { enabled: true, endpoints: ["https://*.example.net", "192.168.0.0/16"] },
    })
    expect(LocalPolicy.listed(policy, "https://gpu1.ml.corp.example.com/v1")).toBe(true)
    expect(LocalPolicy.listed(policy, "https://ml.corp.example.com/v1")).toBe(false)
    expect(LocalPolicy.listed(policy, "http://gpu1.ml.corp.example.com/v1")).toBe(false)
    expect(LocalPolicy.listed(policy, "http://10.20.3.4:8000/v1")).toBe(true)
    expect(LocalPolicy.listed(policy, "http://10.21.3.4:8000/v1")).toBe(false)
    expect(LocalPolicy.listed(policy, "http://[fd12::5]:8000/v1")).toBe(true)
    expect(LocalPolicy.listed(policy, "https://a.example.net/")).toBe(false)
    expect(LocalPolicy.listed(policy, "http://192.168.1.1/")).toBe(false)
    expect(policy.warnings.filter((warning) => warning.includes("company's policy only"))).toHaveLength(2)
  })

  test("names an origin the company's endpoint patterns match, or whose host web pages may reach", () => {
    const policy = LocalPolicy.resolve({
      managed: {
        lock: true,
        user_may: ["endpoints"],
        endpoint_domains: ["https://*.ml.corp.example.com", "*.corp.example"],
        web_domains: { allow: ["docs.example.com"] },
      },
    })
    expect(LocalPolicy.named(policy, "https://gpu1.ml.corp.example.com/v1")).toBe(true)
    expect(LocalPolicy.named(policy, "https://llm.corp.example")).toBe(true)
    expect(LocalPolicy.named(policy, "https://docs.example.com:8443/")).toBe(true)
    expect(LocalPolicy.named(policy, "http://gpu1.ml.corp.example.com/v1")).toBe(false)
    expect(LocalPolicy.named(policy, "https://exfil.example.com/")).toBe(false)
    expect(LocalPolicy.named(policy, "not an address")).toBe(false)
  })
})

describe("LocalPolicy.resolve", () => {
  const managed: ConfigLocalV1.Info = { web: "network", endpoints: ["http://10.0.0.5:8000"] }

  test("Web access defaults to Ask and Local to off", () => {
    expect(LocalPolicy.resolve({})).toMatchObject({
      enabled: false,
      web: "ask",
      lock: false,
      endpoints: [],
      warnings: [],
    })
  })

  test("ignores a repository's local block and says so", () => {
    const policy = LocalPolicy.resolve({
      repository: { enabled: false, web: "ask", endpoints: ["https://attacker.example"] },
    })
    expect(policy.endpoints).toEqual([])
    expect(policy.warnings).toEqual([LocalPolicy.REPOSITORY_IGNORED])
  })

  test("ignores managed-only keys in the user's own config", () => {
    const policy = LocalPolicy.resolve({
      global: { enabled: true, lock: true, updates: { url: "https://evil.example/" } },
    })
    expect(policy).toMatchObject({ lock: false })
    expect(policy.updates).toBeUndefined()
    expect(policy.warnings[0]).toBe(
      "Ignored lock, updates in your user config: only your company's policy can set them.",
    )
  })

  test("refuses cloud AI services as a user's own model server, but not from the company", () => {
    const user = LocalPolicy.resolve({
      global: { enabled: true, endpoints: ["https://api.openai.com", "https://my-server.example.com"] },
    })
    expect(user.endpoints).toEqual([{ origin: "https://my-server.example.com", from: "user" }])
    expect(user.warnings[0]).toContain("cloud AI service")
    const company = LocalPolicy.resolve({ managed: { endpoints: ["https://api.openai.com"] } })
    expect(company.endpoints).toEqual([{ origin: "https://api.openai.com", from: "managed" }])
  })

  test("never loosens from the environment", () => {
    const bases: LocalPolicy.Sources[] = [
      {},
      { global: { enabled: true, web: "none" } },
      { global: { enabled: true, web: "network", endpoints: ["http://127.0.0.1:11434"] } },
      { managed: { lock: true, web: "none" } },
      { managed, global: { enabled: true } },
    ]
    const envs = [
      { VECTOR_LOCAL: "0" },
      { VECTOR_LOCAL: "false" },
      { VECTOR_LOCAL_WEB: "ask" },
      { VECTOR_LOCAL_WEB: "network" },
      { VECTOR_LOCAL_WEB: "none" },
      { VECTOR_LOCAL_POLICY: JSON.stringify({ enabled: false, web: "ask", lock: false }) },
      {
        VECTOR_LOCAL_POLICY: JSON.stringify({
          allow: [{ source: "github", reason: "x", added_at: 1, added_by: "app" }],
        }),
      },
      { VECTOR_LOCAL_POLICY: JSON.stringify({ web_domains: { allow: ["example.com"] }, lock: true }) },
      { VECTOR_LOCAL_POLICY: "not json" },
      { VECTOR_CONFIG_CONTENT: JSON.stringify({ local: { enabled: false } }) },
    ]
    const order = { ask: 0, network: 1, none: 2 }
    for (const base of bases)
      for (const env of envs) {
        const before = LocalPolicy.resolve(base)
        const after = LocalPolicy.resolve({ ...base, env })
        const label = JSON.stringify({ base, env })
        expect(after.enabled || !before.enabled, label).toBe(true)
        expect(order[after.web] >= order[before.web], label).toBe(true)
        expect(after.lock, label).toBe(before.lock)
        expect(after.allow, label).toEqual(before.allow)
        expect(after.web_domains, label).toEqual(before.web_domains)
      }
  })

  test("the environment can turn Local on, tighten Web access and add endpoints, never a lock", () => {
    const policy = LocalPolicy.resolve({
      global: { web: "ask" },
      env: {
        VECTOR_LOCAL_WEB: "network",
        VECTOR_LOCAL_POLICY: JSON.stringify({
          enabled: true,
          web: "none",
          endpoints: ["http://127.0.0.1:1234"],
          lock: true,
        }),
      },
    })
    expect(policy).toMatchObject({ enabled: true, web: "none", lock: false })
    expect(policy.endpoints).toEqual([{ origin: "http://127.0.0.1:1234", from: "environment" }])
    expect(policy.warnings).toContain(
      "Ignored lock in VECTOR_LOCAL_POLICY: it can only add enabled, web and endpoints.",
    )
    expect(LocalPolicy.resolve({ env: { VECTOR_LOCAL: "1" } }).enabled).toBe(true)
    expect(LocalPolicy.resolve({ env: { VECTOR_LOCAL_WEB: "open" } }).warnings).toEqual([
      "Ignored VECTOR_LOCAL_WEB=open: it can only be none or network.",
    ])
  })

  test("a user may tighten their company's unlocked setting but not loosen it", () => {
    expect(LocalPolicy.resolve({ managed, global: { web: "none" } }).web).toBe("none")
    expect(LocalPolicy.resolve({ managed, global: { web: "ask" } }).web).toBe("network")
    expect(LocalPolicy.resolve({ managed: { enabled: true }, global: { enabled: false } }).enabled).toBe(true)
    expect(LocalPolicy.resolve({ managed: { enabled: false }, global: { enabled: true } }).enabled).toBe(true)
  })

  test("a lock forces Local on and keeps the user's own values out, except the keys it lets them change", () => {
    const user: ConfigLocalV1.Info = {
      enabled: false,
      web: "none",
      endpoints: ["http://127.0.0.1:11434", "https://cloud-box.example.com"],
      allow: [{ source: "github", reason: "PRs", added_at: 1, added_by: "app" }],
      web_domains: { allow: ["example.com"], deny: ["bad.example.org"] },
    }
    const strict = LocalPolicy.resolve({
      managed: { lock: true, web: "ask", endpoints: ["http://10.0.0.5:8000"] },
      global: user,
    })
    expect(strict).toMatchObject({ enabled: true, lock: true, web: "ask", allow: [], user_may: [] })
    expect(strict.endpoints).toEqual([{ origin: "http://10.0.0.5:8000", from: "managed" }])
    expect(strict.web_domains).toEqual({ allow: [], deny: ["bad.example.org"] })
    expect(strict.warnings).toEqual([
      "Your company set Vector Local, so endpoints, allow, web_domains.allow, web in your user config do not apply.",
    ])

    const open = LocalPolicy.resolve({
      managed: { lock: true, web: "ask", user_may: ["endpoints", "web"], endpoint_domains: ["*.corp.example.com"] },
      global: { ...user, endpoints: [...user.endpoints!, "https://gpu.corp.example.com"] },
    })
    expect(open.web).toBe("none")
    expect(open.endpoints).toEqual([
      { origin: "http://127.0.0.1:11434", from: "user" },
      { origin: "https://gpu.corp.example.com", from: "user" },
    ])
    expect(open.warnings).toContain(
      "Ignored https://cloud-box.example.com: your company allows only servers on your network or the ones it names.",
    )
  })

  test("Web access only ever gets stricter", () => {
    expect(LocalPolicy.stricter("ask", "none")).toBe("none")
    expect(LocalPolicy.stricter("none", "ask")).toBe("none")
    expect(LocalPolicy.stricter("network", undefined)).toBe("network")
  })
})

describe("Off in Vector Local", () => {
  test("a blocked provider says why and how to use it, without the logout advice", () => {
    const notice = providerUnavailable("anthropic", "off-in-local")
    expect(notice.reason).toBe("off-in-local")
    expect(notice.message).toContain("off in Vector Local")
    expect(notice.message).not.toContain("logout")
    expect(providerUnavailable("anthropic", "disabled").message).toContain("vector providers logout anthropic")
  })
})
