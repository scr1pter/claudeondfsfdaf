import { describe, expect, test } from "bun:test"
import { imageLinkAllowed, opsMerge, opsRoute } from "./ops-requests"

// WP A50: the only requests the production-check screens may make, checked by shape before anything is sent (the
// desktop's main process and the phone app both use opsRoute). vectordev.ai checks everything again and decides from
// the plan (S1); test/ops-screens.test.ts (repository root) sends each of these to the real routes.

const INCIDENT = `inc_${"a".repeat(22)}`
const CARD = `crd_${"b".repeat(22)}`
const MONITOR = "mon_cccccccccccccccc"

describe("opsRoute", () => {
  test("reads go to their routes with GET and no body", () => {
    expect(opsRoute({ kind: "incidents" })).toEqual({ path: "/api/ops/incidents", method: "GET" })
    expect(opsRoute({ kind: "releases" })).toEqual({ path: "/api/ops/releases", method: "GET" })
    expect(opsRoute({ kind: "cards" })).toEqual({ path: "/api/ops/cards", method: "GET" })
    expect(opsRoute({ kind: "card", id: CARD })).toEqual({ path: `/api/ops/cards?id=${CARD}`, method: "GET" })
    expect(opsRoute({ kind: "image", card: CARD, n: 2 })).toEqual({ path: `/api/ops/image/${CARD}/2`, method: "GET" })
    expect(opsRoute({ kind: "monitors" })).toEqual({ path: "/api/ops/monitors", method: "GET" })
    expect(opsRoute({ kind: "domains" })).toEqual({ path: "/api/ops/domains", method: "GET" })
    expect(opsRoute({ kind: "repos" })).toEqual({ path: "/api/ops/repos", method: "GET" })
  })

  test("actions carry exactly the body their route reads", () => {
    expect(opsRoute({ kind: "snooze", id: INCIDENT, hours: 4 })).toEqual({
      path: "/api/ops/incidents",
      method: "POST",
      body: { id: INCIDENT, action: "snooze", hours: 4 },
    })
    expect(opsRoute({ kind: "unsnooze", id: INCIDENT })?.body).toEqual({ id: INCIDENT, action: "unsnooze" })
    expect(opsRoute({ kind: "fix", id: INCIDENT })?.body).toEqual({ id: INCIDENT, action: "fix" })
    expect(opsRoute({ kind: "fix", id: INCIDENT, repositoryId: 42 })?.body).toEqual({
      id: INCIDENT,
      action: "fix",
      repositoryId: 42,
    })
    expect(opsRoute({ kind: "add-domain", domain: " shop.example.com " })).toEqual({
      path: "/api/ops/domains",
      method: "POST",
      body: { domain: "shop.example.com" },
    })
    expect(opsRoute({ kind: "verify-domain", domain: "shop.example.com" })?.body).toEqual({
      domain: "shop.example.com",
      verify: true,
    })
    expect(opsRoute({ kind: "remove-domain", domain: "shop.example.com" })).toEqual({
      path: "/api/ops/domains",
      method: "DELETE",
      body: { domain: "shop.example.com" },
    })
    expect(opsRoute({ kind: "add-monitor", url: "https://shop.example.com/health" })).toEqual({
      path: "/api/ops/monitors",
      method: "POST",
      body: { url: "https://shop.example.com/health" },
    })
    expect(opsRoute({ kind: "remove-monitor", id: MONITOR })).toEqual({
      path: "/api/ops/monitors",
      method: "DELETE",
      body: { id: MONITOR },
    })
  })

  test("anything else is refused before it is sent: other kinds, odd ids, paths smuggled in an id, bad numbers", () => {
    for (const input of [
      undefined,
      null,
      "incidents",
      [],
      { kind: "owner" },
      { kind: "card", id: "../owner/codium" },
      { kind: "card", id: `${CARD}&account=other` },
      { kind: "image", card: CARD, n: 0 },
      { kind: "image", card: CARD, n: 1.5 },
      { kind: "image", card: "crd_x", n: 1 },
      { kind: "snooze", id: INCIDENT, hours: 0 },
      { kind: "snooze", id: INCIDENT, hours: 25 },
      { kind: "snooze", id: INCIDENT, hours: "4" },
      { kind: "unsnooze", id: "inc_1" },
      { kind: "fix", id: INCIDENT, repositoryId: -1 },
      { kind: "fix", id: INCIDENT, repositoryId: "42" },
      { kind: "add-domain", domain: "" },
      { kind: "add-domain", domain: "x".repeat(261) },
      { kind: "add-monitor", url: "   " },
      { kind: "remove-monitor", id: "mon_short" },
    ])
      expect({ input, route: opsRoute(input) }).toEqual({ input, route: undefined })
  })
})

describe("opsMerge", () => {
  test("a repository's full name, a pull request number and an optional 40-hex head", () => {
    expect(opsMerge({ repository: "octo/shop", number: 7 })).toEqual({ repository: "octo/shop", number: 7 })
    expect(opsMerge({ repository: "octo/shop.web", number: 7, headSha: "a".repeat(40) })).toEqual({
      repository: "octo/shop.web",
      number: 7,
      headSha: "a".repeat(40),
    })
    for (const input of [
      { repository: "octo", number: 7 },
      { repository: "octo/shop/extra", number: 7 },
      { repository: "octo/..", number: 7 },
      { repository: "-octo/shop", number: 7 },
      { repository: "octo/shop", number: 0 },
      { repository: "octo/shop", number: 7, headSha: "main" },
      { repository: "octo/shop", number: 7, headSha: "A".repeat(40) },
      undefined,
    ])
      expect({ input, merge: opsMerge(input) }).toEqual({ input, merge: undefined })
  })
})

test("a signed image link may point only at Cloudflare R2's endpoint for an account, over https", () => {
  const account = "0123456789abcdef0123456789abcdef"
  expect(
    imageLinkAllowed(`https://${account}.r2.cloudflarestorage.com/vector-media/ship-desk/x.png?X-Amz-Signature=1`),
  ).toBe(true)
  for (const url of [
    `http://${account}.r2.cloudflarestorage.com/vector-media/x.png`,
    `https://${account}.r2.cloudflarestorage.com:8443/vector-media/x.png`,
    `https://user:pass@${account}.r2.cloudflarestorage.com/vector-media/x.png`,
    "https://evil.example.com/x.png",
    `https://${account}.r2.cloudflarestorage.com.evil.example.com/x.png`,
    "https://r2.cloudflarestorage.com/x.png",
    "data:image/png;base64,AAAA",
    "not a url",
  ])
    expect({ url, allowed: imageLinkAllowed(url) }).toEqual({ url, allowed: false })
})
