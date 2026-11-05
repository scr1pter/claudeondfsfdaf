import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import {
  canFix,
  checksLine,
  decodeCardAnswer,
  decodeCards,
  decodeDomains,
  decodeIncidents,
  decodeMonitors,
  decodeReleases,
  domainStatusLine,
  healthLines,
  imagePairs,
  incidentDetail,
  incidentTitle,
  intervalLine,
  manualReason,
  opsErrorText,
  opsParts,
  opsSections,
  opsTab,
  PART_LINES,
  releaseLine,
  rollbackLabel,
  sliderClip,
  verdictLine,
} from "./ops-model"

// WP A50: what the production-check screens show, shared by the phone's Production page and the desktop's
// Settings → Production. Each part only when listed (H1); answers read field by field so a malformed entry is dropped;
// no availability promise (H3), no amount (P1); Undo and Approve never claim Vector merges (S9). The decoders are run
// against the API's own answers in test/ops-screens.test.ts (repository root).

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 5, 12)
const ops = { onCall: {}, releaseGuard: {}, shipDesk: {} }

describe("what shows", () => {
  test("a part shows only when listed and while the plan's public entitlements carry ops", () => {
    expect(opsParts({ listed: ["on-call", "ship-desk", "remote"], entitlements: { ops } })).toEqual([
      "on-call",
      "ship-desk",
    ])
    expect(opsParts({ listed: new Set(["release-guard"]), entitlements: { ops } })).toEqual(["release-guard"])
    // Pro carries no ops; a listed perk alone is not enough.
    expect(opsParts({ listed: ["on-call", "release-guard", "ship-desk"], entitlements: { ops: null } })).toEqual([])
    expect(opsParts({ listed: ["on-call"], entitlements: {} })).toEqual([])
    expect(opsParts(undefined)).toEqual([])
  })

  test("Settings → Production shows for a signed-in account with a listed part, never on a failed read", () => {
    const status = { signedIn: true, listed: ["on-call"], entitlements: { ops } }
    expect(opsTab(status)).toBe(true)
    expect(opsTab({ ...status, signedIn: false })).toBe(false)
    expect(opsTab({ ...status, error: "network" })).toBe(false)
    expect(opsTab({ ...status, listed: [] })).toBe(false)
    expect(opsTab(undefined)).toBe(false)
  })

  test("sections follow the parts: domains with either check, releases with Release Guard, cards with Ship Desk", () => {
    expect(opsSections(["on-call"])).toEqual({
      incidents: true,
      releases: false,
      cards: false,
      monitors: true,
      domains: true,
    })
    expect(opsSections(["release-guard"])).toEqual({
      incidents: true,
      releases: true,
      cards: false,
      monitors: false,
      domains: true,
    })
    expect(opsSections(["ship-desk"])).toEqual({
      incidents: false,
      releases: false,
      cards: true,
      monitors: false,
      domains: false,
    })
  })
})

const incident = {
  id: `inc_${"a".repeat(22)}`,
  kind: "monitor",
  state: "open",
  openedAt: NOW - 10 * 60_000,
  updatedAt: NOW,
  monitor: { id: "mon_aaaaaaaaaaaaaaaa", url: "https://shop.example.com/health", reason: "status", status: 502 },
}
const release = {
  id: `inc_${"b".repeat(22)}`,
  kind: "release",
  state: "open",
  openedAt: NOW - 3 * 3_600_000,
  updatedAt: NOW,
  snoozedUntil: NOW + 3_600_000,
  release: {
    repositoryId: 42,
    repository: "octo/shop",
    environment: "Production",
    sha: "c".repeat(40),
    goodSha: "d".repeat(40),
    failing: [{ url: "https://shop.example.com/checkout", reason: "status", status: 500 }],
    commits: [{ sha: "c".repeat(40), title: "Change checkout", author: "octo" }],
    totalCommits: 1,
    migrations: ["db/migrations/0042_orders.sql"],
    workflows: false,
    undo: { kind: "pull-request", method: "revert-pr", number: 7, url: "https://github.com/octo/shop/pull/7" },
  },
  fix: { at: NOW - 60_000, url: "https://github.com/octo/shop/actions/runs/1" },
}

describe("incidents", () => {
  test("decodes monitor and release incidents and drops malformed ones", () => {
    const decoded = decodeIncidents({
      incidents: [
        incident,
        release,
        { ...incident, id: "inc_short" },
        { ...release, release: undefined },
        { ...incident, monitor: { ...incident.monitor, url: "http://plain.example.com/" } },
        "junk",
      ],
    })
    expect(decoded).toHaveLength(3)
    expect(decoded[0]).toMatchObject({ kind: "monitor", monitor: { url: incident.monitor.url, status: 502 } })
    expect(decoded[1]).toMatchObject({
      kind: "release",
      snoozedUntil: NOW + 3_600_000,
      release: { repository: "octo/shop", undo: { kind: "pull-request", number: 7 }, totalCommits: 1 },
      fix: { url: "https://github.com/octo/shop/actions/runs/1" },
    })
    // A link that is not https is not shown.
    expect(decoded[2]!.monitor?.url).toBeUndefined()
    expect(decodeIncidents(undefined)).toEqual([])
  })

  test("titles and details say what failed in plain words", () => {
    const [monitor, regressed] = decodeIncidents({ incidents: [incident, release] })
    expect(incidentTitle(monitor!)).toBe("shop.example.com failed two checks in a row")
    expect(incidentTitle({ ...monitor!, state: "resolved" })).toBe("shop.example.com passed its checks again")
    expect(incidentDetail(monitor!)).toBe("https://shop.example.com/health: HTTP 502")
    expect(incidentDetail({ ...monitor!, monitor: { reason: "timeout" } })).toBe("no answer within 8 seconds")
    expect(incidentTitle(regressed!)).toBe("A release of octo/shop broke checks that passed before")
    expect(incidentDetail(regressed!)).toBe("Production, ccccccc: /checkout (HTTP 500)")
  })

  test("Undo: the revert pull request, or why there is none with the host's rollback link", () => {
    const manual = decodeIncidents({
      incidents: [
        {
          ...release,
          release: {
            ...release.release,
            undo: {
              kind: "manual",
              reason: "workflows",
              openUrl: "https://github.com/octo/shop/compare/d...c",
              rollback: { host: "vercel", url: "https://vercel.com/octo/shop/deployments/1" },
            },
          },
        },
      ],
    })[0]!
    expect(manual.release!.undo).toEqual({
      kind: "manual",
      reason: "workflows",
      openUrl: "https://github.com/octo/shop/compare/d...c",
      rollback: { host: "vercel", url: "https://vercel.com/octo/shop/deployments/1" },
    })
    expect(rollbackLabel("vercel")).toBe("Roll back in Vercel")
    expect(rollbackLabel("netlify")).toBe("Roll back on Netlify")
    expect(rollbackLabel("host")).toBe("Roll back at your host")
    expect(manualReason("workflows")).toContain("workflow files")
    expect(manualReason("snoozed")).toContain("snoozed")
    expect(manualReason("something-new")).toBe("Vector did not open a revert pull request for this release.")
    // An undo the screens cannot read waits for the server.
    expect(
      decodeIncidents({ incidents: [{ ...release, release: { ...release.release, undo: 3 } }] })[0]!.release!.undo,
    ).toEqual({
      kind: "pending",
    })
  })

  test("Fix it is offered once, on an open incident of a listed part; the server decides the rest", () => {
    const [monitor, regressed] = decodeIncidents({ incidents: [incident, { ...release, fix: undefined }] })
    expect(canFix(monitor!, ["on-call"])).toBe(true)
    expect(canFix(monitor!, ["release-guard"])).toBe(false)
    expect(canFix({ ...monitor!, state: "resolved" }, ["on-call"])).toBe(false)
    expect(canFix({ ...monitor!, fix: { at: NOW } }, ["on-call"])).toBe(false)
    expect(canFix(regressed!, ["release-guard"])).toBe(true)
  })
})

describe("releases and cards", () => {
  test("releases read as one line each, with the plan's daily cap named without a number", () => {
    const releases = decodeReleases({
      releases: [
        { repository: "octo/shop", environment: "Production", sha: "c".repeat(40), at: NOW, state: "passed" },
        {
          repository: "octo/shop",
          environment: "Production",
          sha: "e".repeat(40),
          at: NOW,
          state: "skipped",
          reason: "daily-limit",
        },
        { environment: "Production", sha: "f".repeat(40), at: NOW, state: "ended" },
        { sha: 1, at: NOW, state: "passed" },
      ],
    })
    expect(releases.map(releaseLine)).toEqual([
      "octo/shop · Production · ccccccc: Passed",
      "octo/shop · Production · eeeeeee: Not watched (the plan's releases a day were used)",
      "Repository · Production · fffffff: Watch ended without a verdict",
    ])
  })

  const card = {
    id: `crd_${"c".repeat(22)}`,
    repository: "octo/shop",
    number: 12,
    url: "https://github.com/octo/shop/pull/12",
    title: "Add a cart badge",
    state: "open",
    draft: false,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 30 * DAY,
    verdict: { value: "pass", final: true },
    run: { url: "https://github.com/octo/shop/actions/runs/9" },
    checks: {
      at: NOW,
      total: 3,
      passed: 1,
      failed: 1,
      pending: 1,
      items: [{ name: "test", status: "completed", conclusion: "success" }],
    },
    images: [
      { n: 3, slot: "before", route: "/cart", type: "image/png", width: 1280, height: 800 },
      { n: 1, slot: "before", route: "/", type: "image/png", width: 1280, height: 800 },
      { n: 2, slot: "after", route: "/", type: "image/webp", width: 1280, height: 800 },
    ],
    approve: {
      url: "https://github.com/octo/shop/pull/12",
      repository: "octo/shop",
      number: 12,
      headSha: "a".repeat(40),
    },
  }

  test("cards decode with checks, the judge's verdict, before and after pairs and what Approve merges", () => {
    const { cards, hidden } = decodeCards({
      cards: [card, { ...card, id: "crd_bad" }, { ...card, approve: undefined }],
      hidden: false,
    })
    expect(hidden).toBe(false)
    expect(cards).toHaveLength(1)
    const decoded = cards[0]!
    expect(decoded.run).toBe("https://github.com/octo/shop/actions/runs/9")
    expect(decoded.approve).toEqual({ url: card.url, repository: "octo/shop", number: 12, headSha: "a".repeat(40) })
    expect(checksLine(decoded)).toBe("Checks: 1 passed, 1 failed, 1 running of 3.")
    expect(verdictLine(decoded)).toBe("The judge passed.")
    expect(verdictLine({ ...decoded, verdict: { value: "fail", final: false } })).toBe(
      "The judge failed (the run is still going).",
    )
    expect(verdictLine({ ...decoded, verdict: undefined })).toBe("No verdict from the run yet.")
    expect(imagePairs(decoded).map((pair) => [pair.route, pair.before?.n, pair.after?.n])).toEqual([
      ["/", 1, 2],
      ["/cart", 3, undefined],
    ])
    expect(decodeCardAnswer({ card })?.id).toBe(card.id)
    expect(decodeCardAnswer({ card: { ...card, url: "javascript:alert(1)" } })).toBeUndefined()
    expect(decodeCards({ cards: [], hidden: true })).toEqual({ cards: [], hidden: true })
  })

  test("the slider uncovers the after shot from the left, clamped to 0..100", () => {
    expect(sliderClip(50)).toBe("inset(0 50% 0 0)")
    expect(sliderClip(100)).toBe("inset(0 0% 0 0)")
    expect(sliderClip(0)).toBe("inset(0 100% 0 0)")
    expect(sliderClip(-5)).toBe("inset(0 100% 0 0)")
    expect(sliderClip(Number.NaN)).toBe("inset(0 50% 0 0)")
    expect(sliderClip(33.333)).toBe("inset(0 66.67% 0 0)")
  })
})

describe("domains and URLs", () => {
  test("domains decode with their record and health; lines warn when a date is near", () => {
    const { domains, limit } = decodeDomains({
      domains: [
        {
          domain: "shop.example.com",
          status: "verified",
          overLimit: false,
          nextCheckAt: NOW + DAY,
          record: {
            txt: { name: "_vector-verify.shop.example.com", value: "vector-verify=t" },
            file: { url: "https://shop.example.com/.well-known/vector-verify.txt", body: "vector-verify=t" },
          },
          health: {
            checkedAt: NOW,
            certificate: { expiresAt: NOW + 10 * DAY },
            registration: { expiresAt: NOW + 200 * DAY },
            dnsChangedAt: NOW - DAY,
          },
        },
        { domain: "other.example.com", status: "pending", overLimit: false },
        { domain: "bad.example.com", status: "weird" },
      ],
      limits: { domains: 3 },
    })
    expect(limit).toBe(3)
    expect(domains.map((domain) => domain.domain)).toEqual(["shop.example.com", "other.example.com"])
    expect(domains[0]!.record?.txt.name).toBe("_vector-verify.shop.example.com")
    const lines = healthLines(domains[0]!.health, NOW, () => "the date")
    expect(lines).toEqual([
      { text: "Certificate expires in 10 days.", warn: true },
      { text: "Registration ends the date.", warn: false },
      { text: "Its DNS changed on the date.", warn: true },
    ])
    expect(healthLines({ checkedAt: NOW, certificate: { problem: "expired" } }, NOW, String)[0]).toEqual({
      text: "The certificate has expired.",
      warn: true,
    })
    expect(healthLines(undefined, NOW, String)).toEqual([])
    expect(domainStatusLine(domains[0]!)).toBe("Verified")
    expect(domainStatusLine({ ...domains[0]!, overLimit: true })).toBe(
      "Verified, past your plan's domains: not checked",
    )
    expect(domainStatusLine(domains[1]!)).toBe("Waiting for verification")
  })

  test("URLs decode with the plan's count and interval in words", () => {
    const { monitors, limits } = decodeMonitors({
      monitors: [
        { id: "mon_aaaaaaaaaaaaaaaa", url: "https://shop.example.com/health", domainVerified: true, checked: true },
        { id: "mon_bbbbbbbbbbbbbbbb", url: "ftp://shop.example.com/", domainVerified: true, checked: true },
      ],
      limits: { urls: 5, intervalSec: 300 },
    })
    expect(monitors).toHaveLength(1)
    expect(limits).toEqual({ urls: 5, intervalSec: 300 })
    expect(intervalLine(300)).toBe("every 5 minutes")
    expect(intervalLine(60)).toBe("every minute")
    expect(decodeMonitors({ monitors: [], limits: null }).limits).toBeUndefined()
  })
})

test("refusals read in plain words, the server's own message otherwise", () => {
  expect(opsErrorText({ code: "OPS_PAUSED" })).toBe("Production checks are paused for now. Try again later.")
  expect(opsErrorText({ code: "OPS_FIX_UNAVAILABLE" })).toBe("Fix runs are not available yet.")
  expect(opsErrorText({ status: 401 })).toBe("Sign in to Vector again.")
  expect(opsErrorText({ status: 429, message: "Too many requests." })).toBe("Too many requests.")
  expect(opsErrorText(undefined)).toBe("Vector could not do that. Try again.")
})

test("the screens' copy keeps the honesty rules (H2, H3, P1, S9)", async () => {
  const dir = import.meta.dir
  const phone = path.resolve(dir, "../../../phone/routes/ops.tsx")
  const files = [
    ...(await readdir(dir))
      .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
      .map((name) => path.join(dir, name)),
    phone,
  ]
  for (const file of files) {
    // The copy people read: comment lines (which name the rules themselves) are left out.
    const text = (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
    for (const banned of [
      /\buptime\b/i,
      /24\/7/,
      /\bSLA\b/,
      /guarantee/i,
      /exclusive/i,
      /every (PR|pull request)/i,
      /response time/i,
      /\bsoon\b/i,
      /\$\d/,
      /\b(credits?|top-?ups?)\b/i,
      /Vector (will )?merges?\b/,
    ])
      expect({ file: path.basename(file), banned: banned.source, found: banned.test(text) }).toMatchObject({
        found: false,
      })
  }
  expect(PART_LINES["on-call"]).toContain("Vector's agent is on call, not a person.")
  const settings = (await readFile(path.join(dir, "ops-settings.tsx"), "utf8")).replace(/\s+/g, " ")
  expect(settings).toContain("Vector never merges for you.")
  // The before and after slider writes no style attribute, so the phone's CSP (style-src 'self') holds.
  expect(/\sstyle=/.test(await readFile(path.join(dir, "before-after.tsx"), "utf8"))).toBe(false)
})
