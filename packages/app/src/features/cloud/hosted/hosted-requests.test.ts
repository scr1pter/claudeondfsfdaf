import { describe, expect, test } from "bun:test"
import {
  cleanCriteria,
  downloadLinkAllowed,
  hostedRoute,
  pullRequestLinkAllowed,
  recordingLinkAllowed,
  viewerLinkAllowed,
  viewerOrigin,
} from "./hosted-requests"

// WP A56: the only requests the cloud computer's screens may make, and the only links they may open. vectordev.ai
// checks everything again and decides from the plan (S1); these checks keep a confused renderer from sending anything
// else with the account token, and keep the live view window on the computer's own page.

const SESSION = `hs_${"a".repeat(26)}`
const JOB = `jb_${"b".repeat(26)}`
const RECURRING = `jr_${"c".repeat(26)}`
const TOKEN = "vvt1.eyJhdWQiOiJ2ZWN0b3Itdmlld2VyIn0.c2lnbmF0dXJl"

describe("hostedRoute", () => {
  test("maps each request to its route, method and body", () => {
    expect(hostedRoute({ kind: "status" })).toEqual({ path: "/api/hosted/status", method: "GET" })
    expect(hostedRoute({ kind: "sessions" })).toEqual({ path: "/api/hosted/sessions", method: "GET" })
    expect(hostedRoute({ kind: "jobs" })).toEqual({ path: "/api/hosted/jobs", method: "GET" })
    expect(hostedRoute({ kind: "start", size: "standard", jobMinutes: 60, prompt: "  Tidy the docs  ", title: "Docs" })).toEqual({
      path: "/api/hosted/sessions",
      method: "POST",
      body: { size: "standard", jobMinutes: 60, prompt: "Tidy the docs", title: "Docs" },
    })
    for (const kind of ["stop", "takeover", "release", "download"] as const)
      expect(hostedRoute({ kind, id: SESSION })).toEqual({
        path: `/api/hosted/sessions/${SESSION}/${kind}`,
        method: "POST",
        body: {},
      })
    expect(hostedRoute({ kind: "viewer", id: SESSION, mode: "control" })).toEqual({
      path: `/api/hosted/sessions/${SESSION}/viewer`,
      method: "POST",
      body: { mode: "control" },
    })
    // The pre-start ceiling: the estimate's hosted form (contract §4.13).
    expect(hostedRoute({ kind: "estimate", size: "large", minutes: 240 })).toEqual({
      path: "/api/model-plans/estimate",
      method: "POST",
      body: { kind: "hosted", minutes: 240, size: "large" },
    })
    expect(hostedRoute({ kind: "job", id: JOB })).toEqual({ path: `/api/hosted/jobs/${JOB}`, method: "GET" })
    expect(hostedRoute({ kind: "cancel-job", id: RECURRING })?.body).toEqual({ action: "cancel" })
    expect(hostedRoute({ kind: "approve-job", id: JOB })).toEqual({
      path: `/api/hosted/jobs/${JOB}/approve`,
      method: "POST",
      body: {},
    })
    expect(
      hostedRoute({
        kind: "queue",
        prompt: "Check the signup page",
        criteria: "Loads\n\n  Has a form  ",
        deliverBy: 1_800_000_000_000,
        size: "standard",
        jobMinutes: 30,
      }),
    ).toEqual({
      path: "/api/hosted/jobs",
      method: "POST",
      body: {
        prompt: "Check the signup page",
        criteria: ["Loads", "Has a form"],
        deliverBy: 1_800_000_000_000,
        size: "standard",
        jobMinutes: 30,
      },
    })
  })

  test("refuses anything else: unknown kinds, other ids, paths, sizes, lengths and extra fields", () => {
    for (const input of [
      undefined,
      null,
      "status",
      [],
      { kind: "admin/flags" },
      { kind: "stop", id: "../admin" },
      { kind: "stop", id: `${SESSION}/x` },
      { kind: "viewer", id: SESSION, mode: "admin" },
      { kind: "start", size: "huge", jobMinutes: 60, prompt: "x" },
      { kind: "start", size: "standard", jobMinutes: 10, prompt: "x" },
      { kind: "start", size: "standard", jobMinutes: 721, prompt: "x" },
      { kind: "start", size: "standard", jobMinutes: 60.5, prompt: "x" },
      { kind: "start", size: "standard", jobMinutes: 60, prompt: "   " },
      { kind: "start", size: "standard", jobMinutes: 60, prompt: "x".repeat(32_001) },
      { kind: "start", size: "standard", jobMinutes: 60, prompt: "x", title: "a\u0000b" },
      { kind: "approve-job", id: RECURRING },
      { kind: "job", id: SESSION },
      { kind: "queue", prompt: "x", criteria: [], deliverBy: 1, size: "standard", jobMinutes: 30 },
      { kind: "queue", prompt: "x", criteria: Array(11).fill("c"), deliverBy: 1, size: "standard", jobMinutes: 30 },
      { kind: "estimate", size: "standard", minutes: 5 },
    ])
      expect(hostedRoute(input)).toBeUndefined()
    // Only the fields a route takes are ever sent, whatever else the renderer adds.
    expect(
      hostedRoute({ kind: "start", size: "standard", jobMinutes: 60, prompt: "x", account: "someone", source: "schedule" })
        ?.body,
    ).toEqual({ size: "standard", jobMinutes: 60, prompt: "x" })
  })

  test("criteria are one per line, at most ten, each one line of at most 300 characters", () => {
    expect(cleanCriteria(["a", " b "])).toEqual(["a", "b"])
    expect(cleanCriteria("a\r\nb")).toEqual(["a", "b"])
    expect(cleanCriteria(["x".repeat(301)])).toBeUndefined()
    expect(cleanCriteria("")).toBeUndefined()
  })
})

describe("links", () => {
  test("a live view link is the computer's own page with a viewer token in its fragment, nothing else", () => {
    const link = `https://vh-abc-6080.sandbox.example#vt=${TOKEN}`
    expect(viewerLinkAllowed(link)).toBe(true)
    expect(viewerOrigin(link)).toBe("https://vh-abc-6080.sandbox.example")
    for (const url of [
      `http://vh-abc-6080.sandbox.example#vt=${TOKEN}`,
      `https://user:pass@vh.sandbox.example#vt=${TOKEN}`,
      `https://vh.sandbox.example:8443#vt=${TOKEN}`,
      `https://vh.sandbox.example/other#vt=${TOKEN}`,
      `https://vh.sandbox.example/?vt=${TOKEN}`,
      `https://vh.sandbox.example#vt=${TOKEN}&next=https://elsewhere.example`,
      "https://vh.sandbox.example#vt=not-a-token",
      `https://localhost#vt=${TOKEN}`,
      `javascript:alert(1)#vt=${TOKEN}`,
      42,
    ])
      expect(viewerLinkAllowed(url)).toBe(false)
    expect(viewerOrigin("https://vh.sandbox.example")).toBeUndefined()
  })

  test("a files link is vectordev.ai's own download route for one session, with its link token only", () => {
    const link = `https://vectordev.ai/api/hosted/sessions/${SESSION}/download?t=abc.def`
    expect(downloadLinkAllowed(link)).toBe(true)
    expect(downloadLinkAllowed(link, "https://preview.example")).toBe(false)
    expect(downloadLinkAllowed(`${link}&x=1`)).toBe(false)
    expect(downloadLinkAllowed(`https://vectordev.ai/api/hosted/sessions/${SESSION}/stop?t=1`)).toBe(false)
    expect(downloadLinkAllowed(`https://evil.example/api/hosted/sessions/${SESSION}/download?t=1`)).toBe(false)
  })

  test("a pull request link is a github.com pull request or compare page; a recording link is an R2 signed link", () => {
    expect(pullRequestLinkAllowed("https://github.com/acme/site/pull/12")).toBe(true)
    expect(pullRequestLinkAllowed("https://github.com/acme/site/compare/main...vector/fix")).toBe(true)
    expect(pullRequestLinkAllowed("https://github.com/acme/site/settings")).toBe(false)
    expect(pullRequestLinkAllowed("https://github.com.evil.example/acme/site/pull/1")).toBe(false)
    expect(pullRequestLinkAllowed("http://github.com/acme/site/pull/1")).toBe(false)
    expect(recordingLinkAllowed(`https://${"ab".repeat(16)}.r2.cloudflarestorage.com/vector-media/x.ts?X-Amz-Signature=1`)).toBe(
      true,
    )
    expect(recordingLinkAllowed("https://example.r2.cloudflarestorage.com/x")).toBe(false)
    expect(recordingLinkAllowed(`http://${"ab".repeat(16)}.r2.cloudflarestorage.com/x`)).toBe(false)
  })
})
