import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createMemo, createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Option, Schema } from "effect"
import { ReviewFixControl } from "@vectordevai/schema/review-fix"
import type { PlacedFinding } from "@vectordevai/core/review/types"
import {
  localFixActions,
  localFixController,
  type LocalFixAPI,
  type LocalFixSource,
  type LocalFixState,
} from "@/features/vectorscope/local-fix"

// VS-12d (SF-10b): the fix controller under Solid's real browser-condition store and memo graph, without a JSX
// transform. Solid decorates objects admitted to its store; the bodies sent must stay exact anyway.
test("Solid's real store drives prepare, offer and approve, and every body sent stays exact", async () => {
  const head = "a".repeat(40)
  const file = "export const a = () => {\n  return 1\n}\n"
  const sha = (text: string) => createHash("sha256").update(text).digest("hex")
  const strict = { onExcessProperty: "error" } as const
  const finding: PlacedFinding = {
    id: "f-verified",
    path: "src/a.ts",
    line: 2,
    side: "RIGHT",
    source: "review",
    severity: "blocking",
    category: "bug",
    title: "Returns the wrong value",
    body: "Body",
    confidence: 0.9,
    verified: true,
    suggestion: "  return 2",
    anchor: { path: "src/a.ts", side: "RIGHT", line: 2, hunk: 0 },
    suggestionAllowed: true,
  }
  const source: LocalFixSource = {
    outcome: {
      pr: 7,
      head,
      baseRef: "main",
      checkout: { mode: "in-place", trust: "trusted", headFiles: [], fromDiff: [] },
      authored: "trusted",
      label: "Reviewing your checkout",
      report: { summary: "", risk: "low", files: [], findings: [] },
      selection: {
        inline: [finding],
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
      },
      skipped: [],
      files: [],
      anchored: {},
      durationMs: 1,
      specialists: [],
      sessions: [],
      banners: [],
      notes: [],
    },
    pr: { number: 7, headRefOid: head, baseRefOid: "b".repeat(40), baseRefName: "main" },
    dismissed: new Set(),
    applied: new Set(),
  }
  const sent = { prepare: [] as unknown[], execute: [] as unknown[] }
  let open: ReviewFixControl.Summary[] = []
  // Every answer is a fresh DTO, as an HTTP response is.
  const api: LocalFixAPI = {
    list: async () => structuredClone({ fixes: open }),
    read: async () => file,
    prepare: async (request) => {
      sent.prepare.push(request)
      open = [
        {
          fixID: "fix_solid",
          state: "preview",
          head,
          sourceBranch: "feature",
          destinationBranch: "vector/fix-solid000",
          digest: `sha256:${"1".repeat(64)}`,
          patchDigest: `sha256:${sha(request.patch)}`,
        },
      ]
      return structuredClone({
        fixID: "fix_solid",
        repository: "/repo",
        worktree: "/fix",
        head,
        base: request.base,
        sourceBranch: "feature",
        baseBranch: request.baseBranch,
        destinationBranch: "vector/fix-solid000",
        source: { kind: "client" as const },
        findingsVerified: false as const,
        findings: [...request.findings],
        digest: `sha256:${"1".repeat(64)}`,
        patchDigest: `sha256:${sha(request.patch)}`,
        patch: request.patch,
        files: [{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 1 }],
        notes: [],
      })
    },
    preview: async (fixID) =>
      structuredClone({
        offerID: "00000000-0000-4000-8000-000000000001",
        fixID,
        operation: { kind: "apply" as const },
        operationDigest: `sha256:${"2".repeat(64)}`,
        head,
        digest: `sha256:${"1".repeat(64)}`,
        patchDigest: open[0]!.patchDigest,
        expiresAt: Date.now() + 300_000,
        notes: [],
      }),
    execute: async (fixID, body) => {
      sent.execute.push(body)
      return structuredClone({
        kind: "apply" as const,
        fixID,
        worktree: "/fix",
        head,
        digest: `sha256:${"1".repeat(64)}`,
        patchDigest: open[0]!.patchDigest,
        consumedAt: 1,
        files: [{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 1 }],
      })
    },
    cancel: async (fixID) => ({ fixID, removed: true }),
  }
  const state = createRoot((dispose) => {
    const [store, setStore] = createStore<{ value: LocalFixState }>({
      value: { fixes: [], results: [], uncertain: false, error: "" },
    })
    const controller = localFixController({
      scope: { identity: {}, server: "solid", parentID: "ses_solid", directory: "/repo", projectID: "p", api },
      enabled: () => true,
      dismissed: () => new Set(),
      changed: (value) => setStore("value", reconcile(value)),
      dwellMs: 0,
    })
    const actions = createMemo(() =>
      localFixActions(store.value, { enabled: true, dismissed: new Set(), now: Date.now(), dwellMs: 0 }),
    )
    const step = createMemo(() => store.value.step)
    return { dispose, controller, actions, step, store }
  })
  try {
    expect(state.actions().prepare.enabled).toBe(true)
    await state.controller.prepare(source)
    expect(state.step()).toBe("preview")
    expect(state.actions().apply.enabled).toBe(true)
    expect(state.actions().commit.enabled).toBe(false)
    expect(sent.prepare).toHaveLength(1)
    expect(Reflect.ownKeys(sent.prepare[0]!)).toEqual([
      "source",
      "head",
      "base",
      "baseBranch",
      "findings",
      "files",
      "patch",
    ])
    expect(Option.isSome(Schema.decodeUnknownOption(ReviewFixControl.Prepare, strict)(sent.prepare[0]))).toBe(true)
    await state.controller.offer({ kind: "apply" })
    expect(state.store.value.offer?.operation.kind).toBe("apply")
    expect(state.actions().approve.enabled).toBe(true)
    await state.controller.approve({ trusted: true, clicks: 1 })
    expect(state.step()).toBe("applied")
    expect(state.actions().commit.enabled).toBe(true)
    expect(sent.execute).toHaveLength(1)
    expect(Reflect.ownKeys(sent.execute[0]!)).toEqual(["offerID", "head", "patchDigest", "operationDigest"])
    expect(Option.isSome(Schema.decodeUnknownOption(ReviewFixControl.Execute, strict)(sent.execute[0]))).toBe(true)
    await state.controller.approve({ trusted: true, clicks: 1 })
    expect(sent.execute).toHaveLength(1)
  } finally {
    state.controller.dispose()
    state.dispose()
  }
})
