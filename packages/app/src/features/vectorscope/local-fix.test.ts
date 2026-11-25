import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { ReviewFixControl } from "@vectordevai/schema/review-fix"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import type { PlacedFinding, Selection } from "@vectordevai/core/review/types"
import type { ReviewOutcomeLite } from "../pull-requests/ai-review"
import {
  LOCAL_FIX_COPY,
  LOCAL_FIX_DWELL_MS,
  LocalFixLost,
  LocalFixRefusal,
  candidateLines,
  localFixActions,
  localFixCancel,
  localFixCandidates,
  localFixController,
  localFixRequest,
  localFixTransport,
  offerLines,
  previewLines,
  resultLines,
  visible,
  type LocalFixAPI,
  type LocalFixPullRequest,
  type LocalFixSource,
  type LocalFixState,
} from "./local-fix"

// VS-12d (SF-10b): the desktop's fix adapter, with the real planner, schema and generated client. Only the engine is
// faked: a recording LocalFixAPI for the controller, and a fetch for the transport.

const head = "a".repeat(40)
const base = "b".repeat(40)
const parentID = "ses_local_fix_parent"
const fixID = "fix_0123abcd-ef45"
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")
const FILE = "export function a(value: number) {\n  return value\n}\n"
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " export function a(value: number) {",
  "-  return value",
  "+  return Math.abs(value)",
  " }",
  "",
].join("\n")

function placed(id: string, overrides: Partial<PlacedFinding> = {}): PlacedFinding {
  return {
    id,
    path: "src/a.ts",
    line: 2,
    side: "RIGHT",
    source: "review",
    severity: "blocking",
    category: "bug",
    title: `Finding ${id}`,
    body: "Body",
    confidence: 0.9,
    anchor: { path: "src/a.ts", side: "RIGHT", line: 2, hunk: 0 },
    suggestionAllowed: true,
    ...overrides,
  }
}

function selection(inline: PlacedFinding[]): Selection {
  return {
    inline,
    outsideDiff: [],
    elsewhere: [],
    nits: [],
    overflow: [],
    stillOpen: [],
    fixed: [],
    dismissed: [],
    reappeared: [],
    raised: [],
    dropped: [],
    risk: "low",
  }
}

function outcome(patch: Partial<ReviewOutcomeLite> = {}): ReviewOutcomeLite {
  return {
    pr: 7,
    head,
    baseRef: "main",
    checkout: { mode: "in-place", trust: "trusted", headFiles: [], fromDiff: [] },
    authored: "trusted",
    label: "Reviewing your checkout",
    report: { summary: "", risk: "low", files: [], findings: [] },
    selection: selection([
      placed("f-verified", { verified: true, suggestion: "  return Math.abs(value)" }),
      placed("f-unverified", { confidence: 0.99, suggestion: "  return 0" }),
    ]),
    skipped: [],
    files: [{ path: "src/a.ts", additions: 1, deletions: 1 }],
    anchored: {},
    durationMs: 1,
    specialists: [],
    sessions: [],
    banners: [],
    notes: [],
    ...patch,
  }
}

const pr: LocalFixPullRequest = { number: 7, headRefOid: head, baseRefOid: base, baseRefName: "main" }
const source = (patch: Partial<LocalFixSource> = {}): LocalFixSource => ({
  outcome: outcome(),
  pr,
  dismissed: new Set(),
  applied: new Set(),
  ...patch,
})

function preview(request: ReviewFixControl.Prepare, patch: Partial<ReviewFixControl.Preview> = {}) {
  return {
    fixID,
    repository: "/repo",
    worktree: "/home/owner/.local/share/vector/fix/fix_0123",
    head: request.head,
    base: request.base,
    sourceBranch: "feature",
    baseBranch: request.baseBranch,
    destinationBranch: "vector/fix-0123abcd",
    source: { kind: "client" as const },
    findingsVerified: false as const,
    findings: [...request.findings],
    digest: `sha256:${"1".repeat(64)}`,
    patchDigest: `sha256:${sha(request.patch)}`,
    patch: request.patch,
    files: [{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 1 }],
    notes: [
      "The engine did not verify the findings this fix names: the patch and its finding references come from your client.",
      "Nothing is applied, committed or pushed until you approve each step, and no command has run.",
    ],
    ...patch,
  } satisfies ReviewFixControl.Preview
}

const commit = "c".repeat(40)
const operations = {
  apply: { kind: "apply" as const },
  checks: {
    kind: "checks" as const,
    commands: [{ argv: ["bun", "test"], cwd: "." }],
    network: "off" as const,
    timeoutMs: 120_000,
    outputBytes: 81_920,
  },
  commit: { kind: "commit" as const, message: "Apply a Vector fix for 1 review finding\n\nReviewed commit: x\n" },
  push: { kind: "push" as const, remote: "file:///srv/remote.git", commit, mode: "branch" as const },
}
let offers = 0
function offerFor(kind: keyof typeof operations, at: number, patch: Partial<ReviewFixControl.Offer> = {}) {
  offers++
  return {
    offerID: `00000000-0000-4000-8000-${String(offers).padStart(12, "0")}`,
    fixID,
    operation: operations[kind],
    // Never equal to the proposal digest, so an echo of the wrong digest cannot pass by chance.
    operationDigest: `sha256:${"e".repeat(60)}${String(offers).padStart(4, "0")}`,
    head,
    digest: `sha256:${"1".repeat(64)}`,
    patchDigest: `sha256:${sha(PATCH)}`,
    expiresAt: at + 300_000,
    ...(kind === "commit" ? { identity: { name: "Owner", email: "owner@example.test" } } : {}),
    notes: kind === "push" ? ["Its hooks do not run, but its own Git configuration is read."] : [],
    ...patch,
  } satisfies ReviewFixControl.Offer
}
function resultFor(kind: keyof typeof operations): ReviewFixControl.Result {
  if (kind === "apply")
    return {
      kind,
      fixID,
      worktree: "/w",
      head,
      digest: `sha256:${"1".repeat(64)}`,
      patchDigest: `sha256:${sha(PATCH)}`,
      consumedAt: 1,
      files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
    }
  if (kind === "checks")
    return {
      kind,
      fixID,
      head,
      digest: `sha256:${"1".repeat(64)}`,
      operation: `sha256:${"2".repeat(64)}`,
      consumedAt: 1,
      results: [
        {
          argv: ["bun", "test"],
          cwd: ".",
          exitCode: 0,
          timedOut: false,
          output: "ok\n",
          truncated: false,
          durationMs: 5,
        },
      ],
      passed: true,
    }
  if (kind === "commit")
    return {
      kind,
      fixID,
      head,
      digest: `sha256:${"1".repeat(64)}`,
      commit,
      tree: "d".repeat(40),
      branch: "vector/fix-0123abcd",
      author: { name: "Owner", email: "owner@example.test" },
      consumedAt: 1,
    }
  return {
    kind,
    fixID,
    commit,
    remote: "file:///srv/remote.git",
    ref: "refs/heads/vector/fix-0123abcd",
    mode: "branch",
    consumedAt: 1,
  }
}

type Call = { method: keyof LocalFixAPI; args: unknown[] }
function fixture(overrides: Partial<LocalFixAPI> = {}, options: { dwellMs?: number } = {}) {
  const calls: Call[] = []
  const clock = { now: 1_000_000 }
  let enabled = true
  let dismissed: ReadonlySet<string> = new Set()
  let state!: LocalFixState
  let open: ReviewFixControl.Summary[] = []
  const record = (method: keyof LocalFixAPI, ...args: unknown[]) => calls.push({ method, args: structuredClone(args) })
  const api: LocalFixAPI = {
    list: async () => {
      record("list")
      return { fixes: open }
    },
    read: async (path) => {
      record("read", path)
      return path === "src/a.ts" ? FILE : undefined
    },
    prepare: async (request) => {
      record("prepare", request)
      const shown = preview(request)
      open = [
        {
          fixID,
          state: "preview",
          head,
          sourceBranch: "feature",
          destinationBranch: shown.destinationBranch,
          digest: shown.digest,
          patchDigest: shown.patchDigest,
        },
      ]
      return shown
    },
    preview: async (id, request) => {
      record("preview", id, request)
      return offerFor(
        request.kind,
        clock.now,
        request.kind === "push" ? { operation: { ...operations.push, ...request, commit } } : {},
      )
    },
    execute: async (id, body) => {
      record("execute", id, body)
      const kind = calls.filter((call) => call.method === "preview").at(-1)!.args[1] as ReviewFixControl.Request
      return resultFor(kind.kind)
    },
    cancel: async (id) => {
      record("cancel", id)
      open = open.filter((fix) => fix.fixID !== id)
      return { fixID: id, removed: true }
    },
    ...overrides,
  }
  const controller = localFixController({
    scope: { identity: {}, server: "fixture", parentID, directory: "/repo", projectID: "project", api },
    enabled: () => enabled,
    dismissed: () => dismissed,
    changed: (value) => {
      state = value
    },
    now: () => clock.now,
    dwellMs: options.dwellMs ?? 0,
  })
  return {
    controller,
    calls,
    api,
    clock,
    state: () => state,
    sent: (method: keyof LocalFixAPI) => calls.filter((call) => call.method === method),
    enable: (value: boolean) => {
      enabled = value
    },
    dismiss: (ids: string[]) => {
      dismissed = new Set(ids)
    },
    setOpen: (value: ReviewFixControl.Summary[]) => {
      open = value
    },
  }
}
const click = { trusted: true, clicks: 1 }

describe("local fix candidates (the desktop's source rule)", () => {
  test("the owner's own in-place review offers only verified committable suggestions; a dismissed one is removed", () => {
    const found = localFixCandidates(source())
    expect(found.ok && found.found.fixes.map((fix) => fix.id)).toEqual(["f-verified"])
    expect(found.ok && found.found.left.unverified).toBe(1)
    const none = localFixCandidates(source({ dismissed: new Set(["f-verified"]) }))
    expect(none.ok && none.found.fixes).toEqual([])
  })

  test("every other review is refused with its fixed reason", () => {
    const cases: [Partial<LocalFixSource>, string][] = [
      [{ outcome: outcome({ pr: undefined }) }, LOCAL_FIX_COPY.uncommitted],
      [{ outcome: outcome({ authored: "untrusted" }) }, LOCAL_FIX_COPY.untrusted],
      [{ outcome: outcome({ authored: undefined }) }, LOCAL_FIX_COPY.untrusted],
      [
        { outcome: outcome({ checkout: { mode: "rebuilt", trust: "untrusted", headFiles: [], fromDiff: [] } }) },
        LOCAL_FIX_COPY.rebuilt,
      ],
      [{ outcome: outcome({ unchanged: true }) }, LOCAL_FIX_COPY.carried],
      [{ outcome: outcome({ carried: 1 }) }, LOCAL_FIX_COPY.carried],
      [{ outcome: outcome({ head: "feature" }) }, LOCAL_FIX_COPY.head],
      [{ pr: { ...pr, headRefOid: "e".repeat(40) } }, LOCAL_FIX_COPY.head],
      [{ pr: { ...pr, baseRefOid: undefined } }, LOCAL_FIX_COPY.base],
      [{ pr: { ...pr, baseRefOid: "b".repeat(64) } }, LOCAL_FIX_COPY.base],
      [{ pr: { ...pr, number: 8 } }, LOCAL_FIX_COPY.number],
      [{ applied: new Set(["f-other"]) }, LOCAL_FIX_COPY.applied],
    ]
    for (const [patch, reason] of cases) expect(localFixCandidates(source(patch))).toEqual({ ok: false, reason })
  })
})

describe("the prepare request", () => {
  test("is the exact client-sourced proposal the CLI would build, and decodes strictly", async () => {
    const reads: string[] = []
    const built = await localFixRequest(source(), async (path) => {
      reads.push(path)
      return FILE
    })
    if (!built.ok) throw new Error(built.reason)
    expect(reads).toEqual(["src/a.ts"])
    expect(built.request).toEqual({
      source: { kind: "client" },
      head,
      base,
      baseBranch: "main",
      findings: ["f-verified"],
      files: [
        {
          path: "src/a.ts",
          preimage: `sha256:${sha(FILE)}`,
          postimage: `sha256:${sha(FILE.replace("return value", "return Math.abs(value)"))}`,
        },
      ],
      patch: PATCH,
    })
    expect(
      Option.isSome(Schema.decodeUnknownOption(ReviewFixControl.Prepare, { onExcessProperty: "error" })(built.request)),
    ).toBe(true)
  })

  test("reads the changed files one after another, never two at once", async () => {
    const two = outcome({
      selection: selection([
        placed("f-verified", { verified: true, suggestion: "  return Math.abs(value)" }),
        placed("f-b", {
          path: "src/b.ts",
          anchor: { path: "src/b.ts", side: "RIGHT", line: 2, hunk: 0 },
          verified: true,
          suggestion: "  return Math.abs(value)",
        }),
      ]),
    })
    const reads: string[] = []
    const reading = { now: 0, most: 0 }
    const built = await localFixRequest(source({ outcome: two }), async (path) => {
      reads.push(path)
      reading.now++
      reading.most = Math.max(reading.most, reading.now)
      await new Promise((resolve) => setTimeout(resolve, 2))
      reading.now--
      return FILE
    })
    expect(reads).toEqual(["src/a.ts", "src/b.ts"])
    expect(reading.most).toBe(1)
    expect(built.ok && built.request.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("a base name a proposal cannot carry is named by the base commit", async () => {
    const built = await localFixRequest(source({ pr: { ...pr, baseRefName: "release..1" } }), async () => FILE)
    expect(built.ok && built.request.baseBranch).toBe(base)
  })

  test("a file that cannot be read or holds a bidi control is left out; with nothing left nothing is sent", async () => {
    const unread = await localFixRequest(source(), async () => undefined)
    expect(unread).toMatchObject({ ok: false, reason: "Nothing to fix: no fix could be made into a patch." })
    expect(unread.plan?.skipped).toEqual([
      {
        id: "f-verified",
        path: "src/a.ts",
        reason: "the file is not UTF-8 text Vector can read at the reviewed commit",
      },
    ])
    const bidi = await localFixRequest(source(), async () => `${FILE}// \u202e\n`)
    expect(bidi.ok).toBe(false)
    expect(bidi.plan?.skipped[0]?.reason).toBe("the file holds control or invisible characters, or CR line endings")
    const none = await localFixRequest(source({ dismissed: new Set(["f-verified"]) }), async () => FILE)
    expect(none).toMatchObject({
      ok: false,
      reason: "Nothing to fix: no verified finding has a suggestion that can be committed as is.",
    })
  })
})

describe("the generated client transport", () => {
  function client(
    options: { session?: Record<string, unknown>; reply?: (method: string, path: string) => Response } = {},
  ) {
    const requests: { method: string; path: string; query: Record<string, string>; body?: unknown }[] = []
    const value = createVectorClient({
      baseUrl: "http://fixture.invalid",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        const url = new URL(request.url)
        const body = request.method === "POST" ? await request.text() : ""
        requests.push({
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          ...(body ? { body: JSON.parse(body) } : {}),
        })
        if (url.pathname === `/session/${parentID}`)
          return Response.json({ id: parentID, projectID: "project", directory: "/repo", ...options.session })
        return options.reply?.(request.method, url.pathname) ?? Response.json({})
      },
    })
    return { requests, value }
  }
  const signal = new AbortController().signal

  test("each call reads the conversation first and reaches only its generated route, with the folder", async () => {
    const built = await localFixRequest(source(), async () => FILE)
    if (!built.ok) throw new Error(built.reason)
    const shown = preview(built.request)
    const root = `/experimental/session/${parentID}/review/fix`
    const answers: Record<string, unknown> = {
      [`GET ${root}`]: { fixes: [] },
      [`POST ${root}`]: shown,
      [`POST ${root}/${fixID}/preview`]: offerFor("apply", 1),
      [`POST ${root}/${fixID}/execute`]: resultFor("apply"),
      [`POST ${root}/${fixID}/cancel`]: { fixID, removed: true },
      "GET /file/content": { type: "text", content: FILE },
    }
    const fake = client({ reply: (method, path) => Response.json(answers[`${method} ${path}`] ?? {}) })
    const api = localFixTransport(fake.value, { parentID, directory: "/repo", projectID: "project" })
    await api.list(signal)
    expect(await api.read("src/a.ts", signal)).toBe(FILE)
    expect(await api.prepare(built.request, signal)).toEqual(shown)
    await api.preview(fixID, { kind: "apply" }, signal)
    const echo = {
      offerID: "00000000-0000-4000-8000-000000000001",
      head,
      patchDigest: shown.patchDigest,
      operationDigest: `sha256:${"3".repeat(64)}`,
    }
    await api.execute(fixID, echo, signal)
    await api.cancel(fixID, signal)
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET /session/${parentID}`,
      `GET ${root}`,
      `GET /session/${parentID}`,
      "GET /file/content",
      `GET /session/${parentID}`,
      `POST ${root}`,
      `GET /session/${parentID}`,
      `POST ${root}/${fixID}/preview`,
      `GET /session/${parentID}`,
      `POST ${root}/${fixID}/execute`,
      `GET /session/${parentID}`,
      `POST ${root}/${fixID}/cancel`,
    ])
    expect(fake.requests.every((request) => request.query.directory === "/repo")).toBe(true)
    expect(fake.requests.find((request) => request.path === root && request.method === "POST")?.body).toEqual(
      built.request,
    )
    expect(fake.requests.find((request) => request.path.endsWith("/execute"))?.body).toEqual(echo)
    expect(fake.requests.find((request) => request.path.endsWith("/preview"))?.body).toEqual({ kind: "apply" })
    for (const session of [
      { parentID: "ses_other" },
      { projectID: "other" },
      { directory: "/other" },
      { internal: "x" },
    ]) {
      const other = client({ session })
      const moved = localFixTransport(other.value, { parentID, directory: "/repo", projectID: "project" })
      await expect(moved.list(signal)).rejects.toThrow(LOCAL_FIX_COPY.mismatch)
      await expect(moved.cancel(fixID, signal)).rejects.toThrow(LOCAL_FIX_COPY.mismatch)
      expect(await moved.read("src/a.ts", signal).catch((cause: Error) => cause.message)).toBe(LOCAL_FIX_COPY.mismatch)
      expect(other.requests.every((request) => request.path === `/session/${parentID}`)).toBe(true)
    }
  })

  test("refusals: the engine's message escaped, the owner copy, an unverifiable answer and a lost one", async () => {
    const api = (reply: (method: string, path: string) => Response) =>
      localFixTransport(client({ reply }).value, { parentID, directory: "/repo", projectID: "project" })
    const refused = await api(() =>
      Response.json({ code: "stale", message: "The reviewed branch moved\u001b[31m \u202e" }, { status: 400 }),
    )
      .list(signal)
      .catch((cause: unknown) => cause)
    expect(refused).toBeInstanceOf(LocalFixRefusal)
    expect((refused as LocalFixRefusal).message).toBe("The reviewed branch moved\\u{1b}[31m \\u{202e}")
    expect((refused as LocalFixRefusal).code).toBe("stale")
    const owner = await api(() => Response.json({ _tag: "ForbiddenError", message: "secret" }, { status: 403 }))
      .list(signal)
      .catch((cause: Error) => cause)
    expect(owner).toBeInstanceOf(LocalFixRefusal)
    expect((owner as Error).message).toBe(LOCAL_FIX_COPY.owner)
    const other400 = await api(() => Response.json({ _tag: "InvalidRequestError", message: "x" }, { status: 400 }))
      .list(signal)
      .catch((cause: Error) => cause.message)
    expect(other400).toBe(LOCAL_FIX_COPY.refused)
    const extra = await api(() => Response.json({ fixes: [], forged: true }))
      .list(signal)
      .catch((cause: unknown) => cause)
    expect(extra).toBeInstanceOf(LocalFixLost)
    expect((extra as Error).message).toBe(LOCAL_FIX_COPY.unverifiable)
    const lost = await localFixTransport(
      createVectorClient({
        baseUrl: "http://fixture.invalid",
        fetch: async (input) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.pathname === `/session/${parentID}`)
            return Response.json({ id: parentID, projectID: "project", directory: "/repo" })
          throw new TypeError("network down")
        },
      }),
      { parentID, directory: "/repo", projectID: "project" },
    )
      .execute(
        fixID,
        {
          offerID: "00000000-0000-4000-8000-000000000001",
          head,
          patchDigest: `sha256:${"1".repeat(64)}`,
          operationDigest: `sha256:${"1".repeat(64)}`,
        },
        signal,
      )
      .catch((cause: unknown) => cause)
    expect(lost).toBeInstanceOf(LocalFixLost)
    const unverified = await localFixTransport(
      createVectorClient({
        baseUrl: "http://fixture.invalid",
        fetch: async () => Response.json({ message: "no" }, { status: 401 }),
      }),
      { parentID, directory: "/repo", projectID: "project" },
    )
      .list(signal)
      .catch((cause: Error) => cause.message)
    expect(unverified).toBe(LOCAL_FIX_COPY.owner)
  })
})

describe("the fix controller", () => {
  test("construction sends nothing, and check reads only the open fixes", async () => {
    const f = fixture()
    expect(f.calls).toEqual([])
    await f.controller.check()
    expect(f.calls.map((call) => call.method)).toEqual(["list"])
    f.controller.dispose()
  })

  test("prepare, then each step previewed and approved on its own, each execute the exact four-key echo", async () => {
    const f = fixture()
    await f.controller.prepare(source())
    expect(f.state().preview?.fixID).toBe(fixID)
    expect(f.state().step).toBe("preview")
    expect(f.sent("prepare")).toHaveLength(1)
    expect(f.sent("preview")).toEqual([])
    await f.controller.offer({ kind: "apply" })
    const apply = f.state().offer!
    expect(f.sent("execute")).toEqual([])
    await f.controller.approve(click)
    expect(f.state().step).toBe("applied")
    expect(f.sent("execute")).toHaveLength(1)
    expect(f.sent("execute")[0]!.args).toEqual([
      fixID,
      { offerID: apply.offerID, head, patchDigest: apply.patchDigest, operationDigest: apply.operationDigest },
    ])
    expect(Object.keys(f.sent("execute")[0]!.args[1] as object)).toEqual([
      "offerID",
      "head",
      "patchDigest",
      "operationDigest",
    ])
    // The offer is spent: a second approval sends nothing, and the apply approval sent no other step.
    await f.controller.approve(click)
    expect(f.sent("execute")).toHaveLength(1)
    expect(f.sent("preview").map((call) => (call.args[1] as ReviewFixControl.Request).kind)).toEqual(["apply"])
    await f.controller.offer({ kind: "commit" })
    await f.controller.approve(click)
    expect(f.state().step).toBe("committed")
    expect(f.state().commit).toBe(commit)
    await f.controller.offer({ kind: "push", remote: "file:///srv/remote.git", mode: "branch" })
    await f.controller.approve(click)
    expect(f.state().step).toBe("pushed")
    expect(f.sent("execute")).toHaveLength(3)
    expect(f.state().results.map((result) => result.kind)).toEqual(["apply", "commit", "push"])
    f.controller.dispose()
  })

  test("an offer that is not the step asked for is refused and never kept; a late one after dispose is dropped", async () => {
    const offered = { value: undefined as ReviewFixControl.Offer | undefined }
    const f = fixture({ preview: async () => offered.value! })
    await f.controller.prepare(source())
    const refused = async (request: ReviewFixControl.Request, value: ReviewFixControl.Offer) => {
      offered.value = value
      await f.controller.offer(request)
      expect(f.state().offer).toBeUndefined()
      expect(f.state().error).toBe(LOCAL_FIX_COPY.mismatchOffer)
    }
    await refused({ kind: "apply" }, offerFor("apply", 1, { patchDigest: `sha256:${"9".repeat(64)}` }))
    await refused({ kind: "apply" }, offerFor("commit", 1))
    await refused({ kind: "apply" }, offerFor("apply", 1, { head: "e".repeat(40) }))
    // The engine reports the fix applied, so checks and commit can be offered.
    f.setOpen([{ ...f.state().fixes[0]!, state: "applied" }])
    await f.controller.check()
    await refused(
      { kind: "checks", commands: [{ argv: ["bun", "test"], cwd: "." }] },
      offerFor("checks", 1, { operation: { ...operations.checks, commands: [{ argv: ["npm", "test"], cwd: "." }] } }),
    )
    await refused({ kind: "commit" }, offerFor("commit", 1, { identity: undefined }))
    await refused({ kind: "commit" }, offerFor("commit", 1, { fixID: "fix_other" }))
    f.setOpen([{ ...f.state().fixes[0]!, state: "committed", commit }])
    await f.controller.check()
    const push = { kind: "push", remote: "file:///srv/remote.git", mode: "branch" } as const
    await refused(push, offerFor("push", 1, { operation: { ...operations.push, remote: "file:///srv/other.git" } }))
    await refused(push, offerFor("push", 1, { operation: { ...operations.push, commit: "e".repeat(40) } }))
    await refused(push, offerFor("push", 1, { operation: { ...operations.push, mode: "draft-pr" } }))
    const late = Promise.withResolvers<ReviewFixControl.Offer>()
    f.api.preview = () => late.promise
    const asking = f.controller.offer(push)
    expect(f.state().busy).toBe("offering")
    const before = f.state()
    f.controller.dispose()
    late.resolve(offerFor("push", 1))
    await asking
    expect(f.state()).toBe(before)
    expect(f.state().offer).toBeUndefined()
  })

  test("a preview that is not the fix built here is cancelled at once", async () => {
    const f = fixture()
    // A different patch with its own correct digest: only comparing the patch itself catches it.
    f.api.prepare = async (request) => {
      const other = request.patch.replace("Math.abs(value)", "Math.abs(value) + 1")
      return preview(request, { patch: other, patchDigest: `sha256:${sha(other)}` })
    }
    await f.controller.prepare(source())
    expect(f.state().preview).toBeUndefined()
    expect(f.state().error).toBe(LOCAL_FIX_COPY.mismatchPreview)
    expect(f.sent("cancel").map((call) => call.args[0])).toEqual([fixID])
    f.api.prepare = async (request) => preview(request, { patchDigest: `sha256:${"0".repeat(64)}` })
    await f.controller.prepare(source())
    expect(f.sent("cancel")).toHaveLength(2)
    f.controller.dispose()
  })

  test("a lost execute is uncertain, is never sent again, and only reading the open fixes clears it", async () => {
    const f = fixture({
      execute: async (id, body) => {
        f.calls.push({ method: "execute", args: [id, body] })
        throw new LocalFixLost(LOCAL_FIX_COPY.lost)
      },
    })
    await f.controller.prepare(source())
    await f.controller.offer({ kind: "apply" })
    await f.controller.approve(click)
    expect(f.state().uncertain).toBe(true)
    expect(f.state().error).toContain("may or may not have run")
    await f.controller.offer({ kind: "apply" })
    await f.controller.approve(click)
    expect(f.sent("execute")).toHaveLength(1)
    expect(f.sent("preview")).toHaveLength(1)
    f.setOpen([{ ...(await f.api.list(new AbortController().signal)).fixes[0]!, state: "applied" }])
    await f.controller.check()
    expect(f.state().uncertain).toBe(false)
    expect(f.state().step).toBe("applied")
    f.controller.dispose()
  })

  test("with the setting off nothing is prepared, offered or approved, and Cancel still works", async () => {
    const f = fixture()
    await f.controller.prepare(source())
    await f.controller.offer({ kind: "apply" })
    f.enable(false)
    await f.controller.approve(click)
    await f.controller.offer({ kind: "commit" })
    expect(f.sent("execute")).toEqual([])
    await f.controller.cancel(fixID)
    expect(f.sent("cancel").map((call) => call.args[0])).toEqual([fixID])
    expect(f.state().preview).toBeUndefined()
    const off = fixture()
    off.enable(false)
    await off.controller.prepare(source())
    expect(off.calls).toEqual([])
    f.controller.dispose()
  })

  test("dispose aborts a running step, drops its late answer and cancels the fix this panel prepared", async () => {
    const gate = Promise.withResolvers<ReviewFixControl.Result>()
    let aborted = false
    const f = fixture({
      execute: async (_id, _body, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true
        })
        return gate.promise
      },
    })
    await f.controller.prepare(source())
    await f.controller.offer({ kind: "apply" })
    const running = f.controller.approve(click)
    expect(f.state().busy).toBe("running")
    expect(f.state().offer).toBeUndefined()
    const before = f.state()
    f.controller.dispose()
    expect(aborted).toBe(true)
    gate.resolve(resultFor("apply"))
    await running
    expect(f.state()).toBe(before)
    expect(f.sent("cancel").map((call) => call.args[0])).toEqual([fixID])
    // The next panel lists the fix only while the cancel was lost, and then offers it Cancel only.
    const next = fixture()
    next.setOpen([{ ...before.fixes[0]!, state: "applied" }])
    await next.controller.check()
    expect(next.state().preview).toBeUndefined()
    expect(next.state().fixes.map((fix) => fix.fixID)).toEqual([fixID])
    expect(localFixActions(next.state(), { enabled: true, dismissed: new Set(), now: 0 }).apply.enabled).toBe(false)
    expect(localFixActions(next.state(), { enabled: true, dismissed: new Set(), now: 0 }).cancel.enabled).toBe(true)
    next.controller.dispose()
  })

  test("a fix the engine placed is cancelled when dispose lands while its preview is being compared", async () => {
    const f = fixture()
    const place = f.api.prepare
    f.api.prepare = async (request, signal) => {
      const shown = await place(request, signal)
      // sameFix reads the patch digest just before it awaits its own digest of the patch: dispose lands in that wait.
      return Object.defineProperty({ ...shown }, "patchDigest", {
        get: () => {
          f.controller.dispose()
          return shown.patchDigest
        },
      })
    }
    await f.controller.prepare(source())
    expect(f.state().preview).toBeUndefined()
    expect(f.sent("cancel").map((call) => call.args[0])).toEqual([fixID])
  })

  test("dispose while preparing leaves the sent prepare to finish, then cancels the fix it placed", async () => {
    const called = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<void>()
    let aborted = false
    const f = fixture()
    const place = f.api.prepare
    f.api.prepare = async (request, signal) => {
      called.resolve()
      // As the transport: an aborted request rejects, and the answer that names the placed fix is lost with it.
      signal.addEventListener("abort", () => {
        aborted = true
      })
      const shown = await place(request, signal)
      await answer.promise
      signal.throwIfAborted()
      return shown
    }
    const preparing = f.controller.prepare(source())
    await called.promise
    expect(f.state().busy).toBe("preparing")
    f.controller.dispose()
    expect(f.sent("cancel")).toEqual([])
    answer.resolve()
    await preparing
    expect(aborted).toBe(false)
    expect(f.sent("cancel").map((call) => call.args[0])).toEqual([fixID])
  })

  test("Approve needs a trusted single click after the pause, before the offer expires", async () => {
    const f = fixture({}, { dwellMs: LOCAL_FIX_DWELL_MS })
    await f.controller.prepare(source())
    await f.controller.offer({ kind: "apply" })
    const offer = f.state().offer!
    f.clock.now += LOCAL_FIX_DWELL_MS - 1
    await f.controller.approve(click)
    expect(f.sent("execute")).toEqual([])
    f.clock.now += 1
    await f.controller.approve({ trusted: false, clicks: 1 })
    await f.controller.approve({ trusted: true, clicks: 2 })
    expect(f.sent("execute")).toEqual([])
    expect(f.state().offer).toEqual(offer)
    f.clock.now = offer.expiresAt
    await f.controller.approve(click)
    expect(f.sent("execute")).toEqual([])
    expect(localFixActions(f.state(), { enabled: true, dismissed: new Set(), now: f.clock.now }).approve.reason).toBe(
      "This offer expired. Preview the step again.",
    )
    f.clock.now = offer.expiresAt - 1
    await f.controller.approve({ trusted: true, clicks: 0 })
    expect(f.sent("execute")).toHaveLength(1)
    f.controller.dispose()
  })

  test("Cancel during a running step stops it, then cancels the fix", async () => {
    const gate = Promise.withResolvers<ReviewFixControl.Result>()
    const f = fixture({ execute: async () => gate.promise })
    await f.controller.prepare(source())
    await f.controller.offer({ kind: "apply" })
    const running = f.controller.approve(click)
    await f.controller.cancel(fixID)
    gate.resolve(resultFor("apply"))
    await running
    expect(f.sent("cancel").map((call) => call.args[0])).toEqual([fixID])
    expect(f.state().preview).toBeUndefined()
    expect(f.state().results).toEqual([])
    f.controller.dispose()
  })

  test("while a step runs, another fix's Cancel neither stops it nor sends anything", async () => {
    const gate = Promise.withResolvers<ReviewFixControl.Result>()
    let aborted = false
    const f = fixture({
      execute: async (_id, _body, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true
        })
        return gate.promise
      },
    })
    await f.controller.prepare(source())
    f.setOpen([
      ...f.state().fixes,
      { ...f.state().fixes[0]!, fixID: "fix_other", destinationBranch: "vector/fix-other" },
    ])
    await f.controller.check()
    expect(f.state().fixes.map((fix) => fix.fixID)).toEqual([fixID, "fix_other"])
    await f.controller.offer({ kind: "apply" })
    const running = f.controller.approve(click)
    expect(f.state().busy).toBe("running")
    expect(localFixCancel(f.state(), "fix_other").enabled).toBe(false)
    expect(localFixCancel(f.state(), fixID).enabled).toBe(true)
    await f.controller.cancel("fix_other")
    expect(aborted).toBe(false)
    expect(f.sent("cancel")).toEqual([])
    expect(f.state().busy).toBe("running")
    gate.resolve(resultFor("apply"))
    await running
    expect(f.state().step).toBe("applied")
    expect(f.state().preview?.fixID).toBe(fixID)
    f.controller.dispose()
  })

  test("open fixes the engine no longer holds, or that stopped, clear the prepared fix with why", async () => {
    const f = fixture()
    await f.controller.prepare(source())
    f.setOpen([])
    await f.controller.check()
    expect(f.state().preview).toBeUndefined()
    expect(f.state().error).toBe(LOCAL_FIX_COPY.gone)
    await f.controller.prepare(source())
    f.setOpen([{ ...f.state().fixes[0]!, state: "failed" }])
    await f.controller.check()
    expect(f.state().preview).toBeUndefined()
    expect(f.state().error).toBe(LOCAL_FIX_COPY.stopped)
    f.controller.dispose()
  })

  test("a refused prepare names the engine's reason and what to do about a changed file", async () => {
    const f = fixture({
      prepare: async () => {
        throw Object.assign(new LocalFixRefusal("This file differs from the approved preimage."), { code: "invalid" })
      },
    })
    await f.controller.prepare(source())
    expect(f.state().error).toBe(`This file differs from the approved preimage. ${LOCAL_FIX_COPY.preimage}`)
    expect(f.state().uncertain).toBe(false)
    f.controller.dispose()
  })
})

describe("what the panel shows", () => {
  test("the preview and each offer, exactly", async () => {
    const built = await localFixRequest(source(), async () => FILE)
    if (!built.ok) throw new Error(built.reason)
    const shown = preview(built.request)
    expect(previewLines(shown)).toEqual([
      "Fix checkout: /home/owner/.local/share/vector/fix/fix_0123 (separate from yours, detached at aaaaaaa)",
      "Repository: /repo",
      "Branch: feature at aaaaaaa; base main (bbbbbbb)",
      "Destination: a new branch vector/fix-0123abcd in this repository, only if you approve the commit",
      "Commands: none",
      "Files:",
      "  M src/a.ts (+1 -1)",
      "Proposal: sha256:1111111111111111111111111111111111111111111111111111111111111111",
    ])
    const time = (ms: number) => `T${ms}`
    expect(offerLines(offerFor("apply", 0), time)).toEqual([
      "Apply the patch above in the fix checkout. Commands: none. Your checkout, index and files are not changed.",
      "This offer can be approved once, until T300000.",
    ])
    expect(offerLines(offerFor("checks", 0, { notes: ["A check can read your home folder."] }), time)).toEqual([
      "Run these checks in the fix checkout, one after another:",
      "  bun test in .",
      "Network: off",
      "Each command: at most 120 s, and 80 KiB of its output shown.",
      "Note: A check can read your home folder.",
      "This offer can be approved once, until T300000.",
    ])
    expect(offerLines(offerFor("commit", 0), time)).toEqual([
      "Commit the applied fix to its new branch with this message:",
      "  Apply a Vector fix for 1 review finding",
      "  ",
      "  Reviewed commit: x",
      "Author and committer: Owner <owner@example.test>",
      "This offer can be approved once, until T300000.",
    ])
    expect(offerLines(offerFor("push", 0), time)).toEqual([
      `Push commit ${commit} to file:///srv/remote.git`,
      "Mode: branch (the commit's new branch only)",
      "Note: Its hooks do not run, but its own Git configuration is read.",
      "This offer can be approved once, until T300000.",
    ])
    const found = localFixCandidates(source())
    expect(found.ok && candidateLines(found.found)).toEqual([
      "f-verified · blocking · src/a.ts:2 · Finding f-verified",
      "Left out: 1 with a suggestion the double-check did not confirm.",
    ])
  })

  test("check output is escaped, leftovers are named and a pass approves nothing", () => {
    const checked = resultFor("checks")
    if (checked.kind !== "checks") throw new Error("checks")
    const lines = resultLines({
      ...checked,
      results: [{ ...checked.results[0]!, output: "ok\u001b[2J \u202e\tdone\n", exitCode: 1 }],
      leftovers: ["coverage/lcov.info"],
      passed: false,
    })
    expect(lines).toEqual([
      "$ bun test (in .): exit 1, 5 ms",
      "ok\\u{1b}[2J \\u{202e}\tdone\n",
      "A check left files in the fix checkout: coverage/lcov.info. No later step runs while they are there; cancel this fix.",
      "Not every check passed. This is information only: it approves no change, commit or push.",
    ])
    expect(resultLines(checked).at(-1)).toBe(
      "Every check passed. This is information only: it approves no change, commit or push.",
    )
    expect(visible("a\nb\u2028c", false)).toBe("a\\u{a}b\\u{2028}c")
  })

  test("which steps are offered, and why not", () => {
    const at = { enabled: true, dismissed: new Set<string>(), now: 10_000 }
    const idle: LocalFixState = { fixes: [], results: [], uncertain: false, error: "" }
    const shown = {
      ...preview({
        source: { kind: "client" },
        head,
        base,
        baseBranch: "main",
        findings: ["f-verified"],
        files: [{ path: "src/a.ts", preimage: null, postimage: null }],
        patch: PATCH,
      }),
    }
    const enabled = (state: LocalFixState, input = at) =>
      Object.entries(localFixActions(state, input))
        .filter((entry) => entry[1].enabled)
        .map((entry) => entry[0])
    expect(enabled(idle)).toEqual(["prepare", "cancel"])
    expect(enabled({ ...idle, preview: shown, step: "preview" })).toEqual(["apply", "cancel"])
    expect(enabled({ ...idle, preview: shown, step: "applied" })).toEqual(["checks", "commit", "cancel"])
    expect(enabled({ ...idle, preview: shown, step: "committed", commit })).toEqual(["checks", "push", "cancel"])
    expect(enabled({ ...idle, preview: shown, step: "pushed", commit })).toEqual(["cancel"])
    const offer = offerFor("apply", 0)
    expect(enabled({ ...idle, preview: shown, step: "preview", offer, offeredAt: 0 })).toEqual(["approve", "cancel"])
    expect(localFixActions({ ...idle, preview: shown, step: "preview", offer, offeredAt: 0 }, at).apply.reason).toBe(
      "Approve or dismiss the offer shown first.",
    )
    const dismissed = { ...at, dismissed: new Set(["f-verified"]) }
    expect(enabled({ ...idle, preview: shown, step: "applied" }, dismissed)).toEqual(["cancel"])
    expect(localFixActions({ ...idle, preview: shown, step: "applied" }, dismissed).commit.reason).toBe(
      "You dismissed a finding this fix includes. Cancel this fix and prepare again.",
    )
    const left = resultFor("checks")
    expect(
      enabled({
        ...idle,
        preview: shown,
        step: "applied",
        results: [{ ...left, leftovers: ["x"] } as ReviewFixControl.Result],
      }),
    ).toEqual(["cancel"])
    const off = { ...at, enabled: false }
    expect(enabled({ ...idle, preview: shown, step: "applied" }, off)).toEqual(["cancel"])
    expect(localFixActions(idle, off).prepare.reason).toBe("Fixes are off in the owner's global VectorScope settings.")
    expect(enabled({ ...idle, preview: shown, step: "applied", uncertain: true })).toEqual(["cancel"])
    expect(enabled({ ...idle, preview: shown, step: "applied", busy: "running" })).toEqual(["cancel"])
    expect(enabled({ ...idle, preview: shown, step: "applied", busy: "listing" })).toEqual([])
    // During a running step only its own fix's Cancel works; any other listed fix's waits.
    const running = { ...idle, preview: shown, step: "applied" as const, busy: "running" as const }
    expect(localFixCancel(running, fixID)).toEqual({ enabled: true })
    expect(localFixCancel(running)).toEqual({ enabled: true })
    expect(localFixCancel(running, "fix_other")).toEqual({
      enabled: false,
      reason: "A step of the fix prepared here is running. Wait for it, or stop it with that fix's own Cancel.",
    })
    expect(localFixCancel({ ...idle, preview: shown, step: "applied" }, "fix_other")).toEqual({ enabled: true })
    expect(localFixCancel(idle, "fix_other")).toEqual({ enabled: true })
    expect(localFixCancel({ ...idle, busy: "cancelling" }, "fix_other").enabled).toBe(false)
  })
})
