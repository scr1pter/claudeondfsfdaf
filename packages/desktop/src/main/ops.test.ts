import { afterEach, describe, expect, test } from "bun:test"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { GithubRequestError, type GithubAccess } from "./github-api"
import { createDesktopOps } from "./ops"

// WP A50 on the desktop: Settings → Production asks the main process, which holds the account token and sends only the
// requests the screens may make to vectordev.ai, through Vector Local's `production-checks` source. Screenshots come
// through the signed R2 link as checked data URLs; merges use the person's own GitHub sign-in at the card's commit
// (Vector's server never merges, S9). Requests go to fakes; any other connection off this computer throws.
NetworkGuard.use()

const SITE = "https://vectordev.ai"
const TOKEN = "vct_fixture-account-token"
const CARD = `crd_${"c".repeat(22)}`
const R2 =
  "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/vector-media/ship-desk/x.png?X-Amz-Signature=1"
// A PNG's signature and IHDR header for a 1×1 picture: enough for the signature check.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
])
const ACCESS = { token: "gho_fixture", source: "vector" } as GithubAccess

afterEach(() => Egress.configure(LocalPolicy.OFF))

type Call = { url: string; method: string; authorization?: string; body?: unknown; redirect?: string }

function world(answer: (call: Call) => Response | Promise<Response>, token: string | null = TOKEN) {
  const calls: Call[] = []
  const merges: { repo: unknown; number: number; merge: unknown }[] = []
  let refuse: number[] = []
  const ops = createDesktopOps({
    token: async () => token ?? undefined,
    site: SITE,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      const call: Call = {
        url,
        method: init.method ?? "GET",
        ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}),
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
        ...(init.redirect ? { redirect: init.redirect } : {}),
      }
      calls.push(call)
      return answer(call)
    },
    github: async () => ACCESS,
    merge: async (_access, repo, number, merge) => {
      merges.push({ repo, number, merge })
      const status = refuse.shift()
      if (status) throw new GithubRequestError("refused", status)
    },
  })
  return {
    ops,
    calls,
    merges,
    refuseNext: (...statuses: number[]) => {
      refuse = statuses
    },
  }
}

describe("requests", () => {
  test("only the screens' requests are sent, with the account token, no redirect followed", async () => {
    const fixture = world(() => Response.json({ incidents: [] }))
    expect(await fixture.ops.request({ kind: "incidents" })).toEqual({ ok: true, body: { incidents: [] } })
    expect(await fixture.ops.request({ kind: "snooze", id: `inc_${"a".repeat(22)}`, hours: 4 })).toMatchObject({
      ok: true,
    })
    expect(fixture.calls).toEqual([
      { url: `${SITE}/api/ops/incidents`, method: "GET", authorization: `Bearer ${TOKEN}`, redirect: "error" },
      {
        url: `${SITE}/api/ops/incidents`,
        method: "POST",
        authorization: `Bearer ${TOKEN}`,
        body: { id: `inc_${"a".repeat(22)}`, action: "snooze", hours: 4 },
        redirect: "error",
      },
    ])
    // Anything else never leaves the computer.
    for (const input of [{ kind: "owner" }, { kind: "card", id: "../x" }, "incidents", undefined])
      expect(await fixture.ops.request(input)).toEqual({
        ok: false,
        message: "Vector could not send that to production checks.",
      })
    expect(fixture.calls).toHaveLength(2)
  })

  test("signed out: nothing is sent", async () => {
    const fixture = world(() => Response.json({}), null)
    expect(await fixture.ops.request({ kind: "cards" })).toMatchObject({ ok: false, status: 401, code: "SIGN_IN" })
    expect(fixture.calls).toEqual([])
  })

  test("refusals carry vectordev.ai's code and message; odd answers and outages read plainly", async () => {
    const refusing = world(() =>
      Response.json({ error: { code: "OPS_PAUSED", message: "Production checks are paused." } }, { status: 503 }),
    )
    expect(await refusing.ops.request({ kind: "domains" })).toEqual({
      ok: false,
      status: 503,
      code: "OPS_PAUSED",
      message: "Production checks are paused.",
    })
    const odd = world(() => new Response("[1,2]", { status: 200 }))
    expect(await odd.ops.request({ kind: "domains" })).toEqual({
      ok: false,
      message: "Vector could not read production checks. Try again shortly.",
    })
    const down = world(() => {
      throw new TypeError("fetch failed")
    })
    expect(await down.ops.request({ kind: "domains" })).toEqual({
      ok: false,
      message: "Vector could not reach vectordev.ai. Check your connection and try again.",
    })
  })

  test("Vector Local keeps production checks off: nothing is sent, and the screen says why", async () => {
    const fixture = world(() => Response.json({}))
    Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
    expect(await fixture.ops.request({ kind: "incidents" })).toMatchObject({ ok: false, code: "LOCAL_OFF" })
    expect(fixture.calls).toEqual([])
    expect(Egress.events({ blocked: true }).map((event) => `${event.source} ${event.origin}`)).toContain(
      `production-checks ${SITE}`,
    )
  })
})

describe("screenshots", () => {
  test("a PNG from R2's signed link becomes a data URL; the link is fetched with no redirect and no token", async () => {
    const fixture = world((call) =>
      call.url.startsWith(SITE) ? Response.json({ url: R2, type: "image/png" }) : new Response(PNG),
    )
    const shot = await fixture.ops.image({ card: CARD, n: 1 })
    expect(shot).toEqual({ ok: true, src: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` })
    expect(fixture.calls.map((call) => [call.url, call.authorization, call.redirect])).toEqual([
      [`${SITE}/api/ops/image/${CARD}/1`, `Bearer ${TOKEN}`, "error"],
      [R2, undefined, "error"],
    ])
  })

  test("a link elsewhere, a failed read or bytes that are not PNG or WebP are refused", async () => {
    const elsewhere = world(() => Response.json({ url: "https://evil.example.com/x.png" }))
    expect(await elsewhere.ops.image({ card: CARD, n: 1 })).toEqual({
      ok: false,
      message: "Vector could not load this screenshot.",
    })
    expect(elsewhere.calls).toHaveLength(1)
    const svg = world((call) =>
      call.url.startsWith(SITE)
        ? Response.json({ url: R2 })
        : new Response("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    )
    expect(await svg.ops.image({ card: CARD, n: 1 })).toEqual({
      ok: false,
      message: "This screenshot is not a picture Vector shows.",
    })
    const missing = world((call) =>
      call.url.startsWith(SITE) ? Response.json({ url: R2 }) : new Response(null, { status: 403 }),
    )
    expect(await missing.ops.image({ card: CARD, n: 1 })).toMatchObject({ ok: false })
    const bad = world(() => Response.json({}))
    expect(await bad.ops.image({ card: "crd_x", n: 1 })).toMatchObject({ ok: false })
    expect(bad.calls).toEqual([])
  })
})

describe("merges with the person's own GitHub sign-in", () => {
  test("Approve merges at the card's commit; the repository's allowed method is found by trying", async () => {
    const fixture = world(() => Response.json({}))
    fixture.refuseNext(405)
    const head = "a".repeat(40)
    expect(await fixture.ops.merge({ repository: "octo/shop", number: 12, headSha: head })).toEqual({
      ok: true,
      message: "Merged #12 in octo/shop.",
    })
    expect(fixture.merges).toEqual([
      { repo: { owner: "octo", name: "shop" }, number: 12, merge: { strategy: "squash", head } },
      { repo: { owner: "octo", name: "shop" }, number: 12, merge: { strategy: "merge", head } },
    ])
    // Nothing went to vectordev.ai: the merge is between this computer and GitHub.
    expect(fixture.calls).toEqual([])
  })

  test("refusals point to GitHub; no sign-in merges nothing; odd input is refused", async () => {
    const refused = world(() => Response.json({}))
    refused.refuseNext(403)
    expect(await refused.ops.merge({ repository: "octo/shop", number: 12 })).toMatchObject({
      ok: false,
      code: "GITHUB_REFUSED",
    })
    const blocked = world(() => Response.json({}))
    blocked.refuseNext(405, 405, 405)
    expect(await blocked.ops.merge({ repository: "octo/shop", number: 12 })).toMatchObject({
      ok: false,
      code: "GITHUB_REFUSED",
    })
    expect(blocked.merges).toHaveLength(3)
    // The branch moved past the commit the card showed (an Undo's revert branch someone pushed to): nothing merged.
    const moved = world(() => Response.json({}))
    moved.refuseNext(409)
    expect(await moved.ops.merge({ repository: "octo/shop", number: 12, headSha: "a".repeat(40) })).toMatchObject({
      ok: false,
      code: "GITHUB_REFUSED",
      message: expect.stringContaining("Open it in GitHub"),
    })
    expect(moved.merges).toHaveLength(1)
    const signedOut = createDesktopOps({
      token: async () => TOKEN,
      github: async () => undefined,
      merge: async () => {
        throw new Error("never")
      },
    })
    expect(await signedOut.merge({ repository: "octo/shop", number: 12 })).toMatchObject({
      ok: false,
      code: "GITHUB_SIGN_IN",
    })
    const odd = world(() => Response.json({}))
    expect(await odd.ops.merge({ repository: "octo/shop/x", number: 12 })).toMatchObject({ ok: false })
    expect(odd.merges).toEqual([])
  })
})
