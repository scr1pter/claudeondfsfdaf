import { afterAll, describe, expect, test } from "bun:test"
import {
  PLATFORM_HOSTS,
  PLATFORM_TIMEOUT_MS,
  platformFetch,
  platformUrl,
  readPlatformJson,
} from "../../../api/_lib/everywhere/fetch"
import { ApiError } from "../../../api/_lib/http"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

const guard = installFetchGuard()

/*
 * VE-03: `platformFetch` calls only the platform's own API hosts and paths, over https, with redirects as errors.
 * A tiny fake platform on 127.0.0.1 stands in for the real host; nothing here reaches a real platform.
 */

type Call = { url: string; init: RequestInit }

function recorder() {
  const calls: Call[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return Response.json({ ok: true })
  }) as typeof fetch
  return { calls, fetcher }
}

async function refusedCode(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    return error instanceof ApiError ? error.code : "other"
  }
  return "allowed"
}

const ALLOWED = {
  github: ["https://api.github.com/repos/owner/name/issues/1/comments", "https://api.github.com/repositories/42"],
  slack: ["https://slack.com/api/chat.postMessage", "https://slack.com/api/oauth.v2.access", "https://SLACK.com/api/users.info?user=U1"],
  linear: ["https://api.linear.app/graphql", "https://api.linear.app/oauth/token", "https://api.linear.app/oauth/revoke"],
  jira: [
    "https://api.atlassian.com/ex/jira/0b6e2f2a-1111-4c3e-9a2b-1234567890ab/rest/api/3/issue/PROJ-1",
    "https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json",
  ],
} as const

describe("platformFetch", () => {
  test("each platform's own API URLs are fetched, with redirects as errors and a timeout", async () => {
    for (const [platform, urls] of Object.entries(ALLOWED) as [keyof typeof ALLOWED, readonly string[]][]) {
      for (const url of urls) {
        const { calls, fetcher } = recorder()
        const response = await platformFetch(platform, url, { method: "POST", headers: { authorization: "Bearer test" } }, fetcher)
        expect(response.ok).toBe(true)
        expect(calls).toHaveLength(1)
        expect(new URL(calls[0]!.url).hostname).toBe(new URL(url).hostname.toLowerCase())
        expect(calls[0]!.init.redirect).toBe("error")
        expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
        expect(calls[0]!.init.method).toBe("POST")
      }
    }
  })

  test("any host outside the platform's list is refused before a request is made", async () => {
    const refused: [keyof typeof ALLOWED, string][] = [
      ["slack", "https://evil.example/api/chat.postMessage"],
      ["slack", "https://slack.com.evil.example/api/chat.postMessage"],
      ["slack", "https://evilslack.com/api/chat.postMessage"],
      ["slack", "https://hooks.slack.com/api/chat.postMessage"],
      ["slack", "https://slack.com./api/chat.postMessage"],
      ["slack", "https://api.linear.app/graphql"],
      ["linear", "https://slack.com/api/chat.postMessage"],
      ["linear", "https://linear.app/graphql"],
      ["github", "https://github.com/owner/name"],
      ["github", "https://uploads.github.com/repos/owner/name/releases"],
      ["github", "https://api.github.com.evil.example/repos"],
      ["jira", "https://evil.atlassian.net/rest/api/3/issue/PROJ-1"],
      ["jira", "https://auth.atlassian.com/oauth/token"],
      ["jira", "https://api.github.com/repos"],
      ["github", "https://127.0.0.1/repos"],
      ["github", "https://[::1]/repos"],
      ["github", "https://localhost/repos"],
      ["slack", "https://xn--slck-5qa.com/api/chat.postMessage"],
    ]
    for (const [platform, url] of refused) {
      const { calls, fetcher } = recorder()
      expect(platformUrl(platform, url)).toBeUndefined()
      expect(await refusedCode(() => platformFetch(platform, url, {}, fetcher))).toBe("EVERYWHERE_HOST_REFUSED")
      expect(calls).toHaveLength(0)
    }
  })

  test("http, another port, credentials in the URL and odd schemes are refused", async () => {
    for (const url of [
      "http://slack.com/api/chat.postMessage",
      "https://slack.com:8443/api/chat.postMessage",
      "https://slack.com:443x/api/chat.postMessage",
      "https://user:pass@slack.com/api/chat.postMessage",
      "https://user@slack.com/api/chat.postMessage",
      "ftp://slack.com/api/chat.postMessage",
      "javascript:alert(1)",
      "data:text/plain,hello",
      "//slack.com/api/chat.postMessage",
      "slack.com/api/chat.postMessage",
      "",
    ]) {
      const { calls, fetcher } = recorder()
      expect(await refusedCode(() => platformFetch("slack", url, {}, fetcher))).toBe("EVERYWHERE_HOST_REFUSED")
      expect(calls).toHaveLength(0)
    }
  })

  test("paths outside the platform's API are refused, including through dot segments and encoded slashes", async () => {
    for (const [platform, url] of [
      ["slack", "https://slack.com/oauth/v2/authorize"],
      ["slack", "https://slack.com/api/../oauth"],
      ["slack", "https://slack.com/api/%2e%2e/oauth"],
      ["slack", "https://slack.com/api%2F..%2Foauth"],
      ["slack", "https://slack.com\\@evil.example/api"],
      ["linear", "https://api.linear.app/graphqlx"],
      ["linear", "https://api.linear.app/graphql/../admin"],
      ["linear", "https://api.linear.app/"],
      ["jira", "https://api.atlassian.com/admin/v1/orgs"],
      ["jira", "https://forge.cdn.prod.atlassian-dev.net/other.json"],
    ] as const) {
      const { calls, fetcher } = recorder()
      expect(await refusedCode(() => platformFetch(platform, url, {}, fetcher))).toBe("EVERYWHERE_HOST_REFUSED")
      expect(calls).toHaveLength(0)
    }
  })

  test("an unknown platform name is refused", async () => {
    for (const name of ["teams", "constructor", "__proto__", "toString"]) {
      const { calls, fetcher } = recorder()
      const run = () => platformFetch(name as never, "https://api.github.com/repos", {}, fetcher)
      expect(await refusedCode(run)).toBe("EVERYWHERE_HOST_REFUSED")
      expect(calls).toHaveLength(0)
    }
  })

  test("a caller cannot turn redirects back on; its own signal is kept", async () => {
    const { calls, fetcher } = recorder()
    const controller = new AbortController()
    await platformFetch("slack", "https://slack.com/api/chat.update", { redirect: "follow", signal: controller.signal }, fetcher)
    expect(calls[0]!.init.redirect).toBe("error")
    expect(calls[0]!.init.signal).toBe(controller.signal)
    expect(PLATFORM_TIMEOUT_MS).toBe(10_000)
  })

  test("URL objects are checked the same way", async () => {
    const { calls, fetcher } = recorder()
    await platformFetch("github", new URL("https://api.github.com/repositories/1"), {}, fetcher)
    expect(calls).toHaveLength(1)
    expect(await refusedCode(() => platformFetch("github", new URL("https://evil.example/"), {}, fetcher))).toBe(
      "EVERYWHERE_HOST_REFUSED",
    )
  })

  test("every listed host is a bare https API host", () => {
    for (const hosts of Object.values(PLATFORM_HOSTS))
      for (const entry of hosts) {
        expect(entry.host).toMatch(/^[a-z0-9.-]+$/)
        expect(entry.paths.length).toBeGreaterThan(0)
        for (const path of entry.paths) expect(path.startsWith("/")).toBe(true)
      }
  })
})

describe("against a fake platform on 127.0.0.1", () => {
  const seen: { path: string; auth: string | null }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      seen.push({ path: url.pathname, auth: request.headers.get("authorization") })
      if (url.pathname === "/api/redirect") return new Response(null, { status: 302, headers: { location: "https://evil.example/" } })
      if (url.pathname === "/api/huge") return new Response("x".repeat(2_000))
      if (url.pathname === "/api/streamed") {
        // 16 KiB in 512-byte chunks with no declared length, so only counting while reading can catch it.
        let sent = 0
        const stream = new ReadableStream({
          pull(controller) {
            if (sent++ >= 32) return controller.close()
            controller.enqueue(new TextEncoder().encode("y".repeat(512)))
          },
        })
        return new Response(stream)
      }
      if (url.pathname === "/api/broken") return new Response("{not json")
      return Response.json({ ok: true, path: url.pathname })
    },
  })
  afterAll(() => server.stop(true))

  /** Sends an allowed Slack URL to the fake, keeping its path, as the platform tests route their fakes. */
  const toFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    return fetch(new URL(`${url.pathname}${url.search}`, server.url), init)
  }) as typeof fetch

  test("an allowed call reaches the fake with its path and headers", async () => {
    const response = await platformFetch("slack", "https://slack.com/api/chat.postMessage", { headers: { authorization: "Bearer fake-token" } }, toFake)
    expect(await readPlatformJson(response)).toEqual({ ok: true, path: "/api/chat.postMessage" })
    expect(seen.at(-1)).toEqual({ path: "/api/chat.postMessage", auth: "Bearer fake-token" })
  })

  test("a redirect from the platform is an error, never followed", async () => {
    let failed = false
    try {
      await platformFetch("slack", "https://slack.com/api/redirect", {}, toFake)
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })

  test("readPlatformJson refuses answers over the limit, declared or streamed, and answers that are not JSON", async () => {
    const huge = await platformFetch("slack", "https://slack.com/api/huge", {}, toFake)
    expect(await refusedCode(() => readPlatformJson(huge, 1_000))).toBe("EVERYWHERE_PLATFORM_ANSWER")
    const streamed = await platformFetch("slack", "https://slack.com/api/streamed", {}, toFake)
    expect(await refusedCode(() => readPlatformJson(streamed, 4_096))).toBe("EVERYWHERE_PLATFORM_ANSWER")
    const broken = await platformFetch("slack", "https://slack.com/api/broken", {}, toFake)
    expect(await refusedCode(() => readPlatformJson(broken))).toBe("EVERYWHERE_PLATFORM_ANSWER")
  })

  test("without an injected fetcher the real fetch is used, and the guard stops it leaving this computer", async () => {
    let failed = false
    try {
      await platformFetch("slack", "https://slack.com/api/chat.postMessage")
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    // The guard recorded the attempt by host only; this one was deliberate, so it is cleared here.
    expect(guard.violations.splice(0)).toEqual(["slack.com"])
  })
})
