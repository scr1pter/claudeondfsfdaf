import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import {
  reviewMemoryController,
  ReviewMemoryRequestError,
  type ReviewMemorySelection,
  type ReviewMemoryTransport,
  type ReviewMemoryViewState,
} from "./review-memory"

const scope = `vrs1_${"1".repeat(64)}`
const otherScope = `vrs1_${"2".repeat(64)}`
const previewID = "00000000-0000-4000-8000-000000000001"
const digest = "3".repeat(64)
const proposed: ReviewMemoryControl.ProposedEntry = {
  id: "review_proposal",
  kind: "outcome",
  origin: "review",
  status: "proposed",
  text: "PRIVATE_PROPOSED_OUTCOME",
  reason: "A genuine retained review proposed this.",
  paths: ["src/*"],
  citations: [{ path: "src/a.ts", line: 2, head: "a".repeat(40), quote: "PRIVATE_EXACT_QUOTE" }],
  visibility: "repository",
  createdAt: 1,
  updatedAt: 2,
  source: { parentID: "ses_parent", reviewID: "ses_review", head: "a".repeat(40) },
}
const stored: ReviewMemoryControl.OwnerEntry = {
  id: "owner_preference",
  kind: "preference",
  origin: "owner",
  status: "active",
  text: "PRIVATE_STORED_TEXT",
  reason: "Owner preference",
  paths: ["src/*"],
  citations: [],
  visibility: "private",
  createdAt: 1,
  updatedAt: 2,
  approvedBy: "owner_local",
  approvedAt: 2,
}
function fixture(extra: Partial<ReviewMemoryTransport> = {}, selection: Partial<ReviewMemorySelection> = {}) {
  const calls = {
    reads: [] as ReviewMemoryControl.InspectInput[],
    prepares: [] as ReviewMemoryControl.Prepare[],
    confirms: [] as ReviewMemoryControl.Confirmation[],
    discards: [] as string[],
  }
  let snapshot: ReviewMemoryControl.Inspect = {
    repository: "repo",
    scope,
    state: { enabled: true, generation: 0, entries: [stored, proposed] },
  }
  let state!: ReviewMemoryViewState
  let time = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let id = 0
  const api: ReviewMemoryTransport = {
    inspect: async (input) => {
      calls.reads.push(input)
      return structuredClone(snapshot)
    },
    prepare: async (input) => {
      calls.prepares.push(structuredClone(input))
      const { action, ...payload } = input.command
      return Schema.decodeUnknownSync(ReviewMemoryControl.Preview)({
        previewId: previewID,
        sha256: digest,
        expiresAt: 1_000_000 + time + ReviewMemoryControl.LIMIT.ttl,
        repository: snapshot.repository,
        scope: snapshot.scope,
        expected: input.command.expected,
        operation: action,
        payload: action === "approve" ? { ...payload, entry: proposed } : payload,
      })
    },
    confirm: async (input) => {
      calls.confirms.push(structuredClone(input))
      snapshot = {
        ...snapshot,
        state: { ...snapshot.state, generation: snapshot.state.generation + 1, enabled: false },
      }
      return { enabled: false, generation: snapshot.state.generation }
    },
    discard: async (input) => {
      calls.discards.push(input)
    },
    ...extra,
  }
  const selected: ReviewMemorySelection = {
    identity: {},
    server: "local-engine",
    directory: "/repo",
    epoch: 0,
    owner: "owner",
    connected: true,
    capability: true,
    api,
    ...selection,
  }
  const controller = reviewMemoryController({
    selection: selected,
    changed: (next) => {
      state = next
    },
    clock: {
      now: () => time,
      date: () => 1_000_000 + time,
      schedule: (delay, run) => {
        const key = ++id
        timers.set(key, { at: time + delay, run })
        return () => {
          timers.delete(key)
        }
      },
    },
  })
  return {
    controller,
    calls,
    api,
    selected,
    state: () => state,
    snapshot: () => snapshot,
    set: (next: ReviewMemoryControl.Inspect) => {
      snapshot = structuredClone(next)
    },
    advance: (amount: number) => {
      time += amount
      for (const [key, timer] of [...timers])
        if (timer.at <= time) {
          timers.delete(key)
          timer.run()
        }
    },
  }
}

describe("inactive repository review-memory App controller", () => {
  test("an owned read never prepares or confirms, and a fresh exact preview still needs explicit unchecked consent", async () => {
    const f = fixture()
    await f.controller.refresh()
    expect(f.calls.reads).toEqual([{ offset: 0, limit: 50 }])
    expect(f.calls.prepares).toEqual([])
    expect(f.calls.confirms).toEqual([])
    await f.controller.prepare({ action: "configure", enabled: false })
    expect(f.calls.reads).toHaveLength(2)
    expect(f.calls.prepares).toEqual([
      { expectedScope: scope, command: { action: "configure", expected: 0, enabled: false } },
    ])
    expect(f.state().preview?.sha256).toBe(digest)
    expect(f.state().approved).toBe(false)
    await f.controller.confirm()
    expect(f.calls.confirms).toEqual([])
    f.controller.approve(true)
    await f.controller.confirm()
    expect(f.calls.confirms).toEqual([{ previewId: previewID, approvedSha256: digest }])
    expect(f.state().read?.state).toMatchObject({ enabled: false, generation: 1 })
    expect(f.state().preview).toBeUndefined()
    f.controller.dispose()
  })

  test("owner preferences/checks use canonical bounds; outcome approval exposes full source and exact quotes without autoapproval", async () => {
    const f = fixture()
    await f.controller.refresh()
    f.controller.editDraft({
      kind: "check",
      text: "Check empty input.",
      paths: "src/*\nlib/*",
      reason: "Avoid a crash",
      visibility: "repository",
    })
    await f.controller.prepareDraft()
    expect(f.calls.prepares[0]?.command).toEqual({
      action: "record",
      expected: 0,
      kind: "check",
      text: "Check empty input.",
      paths: ["src/*", "lib/*"],
      citations: [],
      reason: "Avoid a crash",
      visibility: "repository",
    })
    expect(f.calls.confirms).toHaveLength(0)
    await f.controller.discard()
    expect(f.calls.discards).toEqual([previewID])
    await f.controller.prepare({ action: "approve", id: proposed.id })
    const preview = f.state().preview
    if (preview?.operation !== "approve") throw new Error("Missing proposed outcome preview")
    expect(preview.payload.entry).toEqual(proposed)
    expect(f.state().approved).toBe(false)
    expect(f.calls.confirms).toEqual([])
    f.controller.dispose()
  })

  test("every authority dimension immediately removes stored text, draft, preview and consent", async () => {
    for (const changed of [
      { identity: {} },
      { server: "other-engine" },
      { directory: "/other" },
      { epoch: 1 },
      { owner: "guest" as const },
      { owner: "unknown" as const },
      { connected: false },
      { capability: false },
      { capability: undefined },
    ]) {
      const f = fixture()
      await f.controller.refresh()
      f.controller.editDraft({ text: "PRIVATE_DRAFT" })
      await f.controller.prepare({ action: "approve", id: proposed.id })
      f.controller.approve(true)
      expect(f.state().read?.state.entries).toHaveLength(2)
      f.controller.update({ ...f.selected, ...changed })
      expect(f.state().read).toBeUndefined()
      expect(f.state().preview).toBeUndefined()
      expect(f.state().retry).toBeUndefined()
      expect(f.state().draft.text).toBe("")
      expect(f.state().approved).toBe(false)
      expect(JSON.stringify(f.state())).not.toContain("PRIVATE_")
      f.controller.dispose()
    }
  })

  test("same-SDK reconnect/disposal requires a fresh authority epoch and rejects a late successful old owner read", async () => {
    const delayed = Promise.withResolvers<ReviewMemoryControl.Inspect>()
    const entered = Promise.withResolvers<void>()
    const f = fixture({
      inspect: async () => {
        entered.resolve()
        return delayed.promise
      },
    })
    const reading = f.controller.refresh()
    await entered.promise
    f.controller.retire()
    expect(f.controller.canRead()).toBe(false)
    delayed.resolve(f.snapshot())
    await reading
    expect(f.state().read).toBeUndefined()
    await f.controller.refresh()
    expect(f.state().read).toBeUndefined()
    f.controller.update({ ...f.selected, epoch: 1 })
    expect(f.controller.canRead()).toBe(true)
    f.controller.dispose()
  })

  test("retirement is sticky across same-proof selection changes and cannot roll its proof epoch backward", async () => {
    const f = fixture()
    await f.controller.refresh()
    f.controller.retire()
    for (const changed of [
      { directory: "/other" },
      { capability: false },
      { capability: true },
      { api: { ...f.api } },
      { identity: {} },
      { owner: "guest" as const },
      { owner: "owner" as const },
      { epoch: -1 },
    ]) {
      f.controller.update({ ...f.selected, ...changed })
      expect(f.controller.canRead()).toBe(false)
      await f.controller.refresh()
      expect(f.state().read).toBeUndefined()
    }
    expect(f.calls.reads).toHaveLength(1)
    f.controller.update({ ...f.selected, epoch: 2 })
    expect(f.controller.canRead()).toBe(true)
    await f.controller.refresh()
    f.controller.retire()
    f.controller.update({ ...f.selected, epoch: 1 })
    f.controller.update({ ...f.selected, epoch: 2 })
    expect(f.controller.canRead()).toBe(false)
    f.controller.update({ ...f.selected, epoch: 3 })
    expect(f.controller.canRead()).toBe(true)
    f.controller.dispose()
  })

  test("published view DTOs and state snapshots cannot mutate captured generation, preview or consent", async () => {
    const f = fixture()
    await f.controller.refresh()
    const published = f.state()
    if (!published.read) throw new Error("Missing owned read")
    Reflect.set(published.read.state, "generation", 99)
    Reflect.set(published.draft, "text", "PRIVATE_PUBLISHER_EDIT")
    await f.controller.prepare({ action: "configure", enabled: false })
    expect(f.calls.prepares[0]?.command.expected).toBe(0)
    const view = f.state()
    if (!view.preview) throw new Error("Missing immutable preview")
    Reflect.set(view.preview, "sha256", "0".repeat(64))
    Reflect.set(view, "approved", true)
    await f.controller.confirm()
    expect(f.calls.confirms).toEqual([])
    f.controller.approve(true)
    await f.controller.confirm()
    expect(f.calls.confirms).toEqual([{ previewId: previewID, approvedSha256: digest }])
    const exposed = f.controller.state()
    Reflect.set(exposed.draft, "text", "PRIVATE_EXTERNAL_EDIT")
    expect(f.controller.state().draft.text).toBe("")
    expect("api" in exposed).toBe(false)
    f.controller.dispose()
  })

  test("a late prepare or confirm result cannot repopulate a navigated or signed-out view", async () => {
    const waitPreview = Promise.withResolvers<ReviewMemoryControl.Preview>()
    const enteredPreview = Promise.withResolvers<ReviewMemoryControl.Prepare>()
    const f = fixture({
      prepare: async (input) => {
        enteredPreview.resolve(input)
        return waitPreview.promise
      },
    })
    await f.controller.refresh()
    const preparing = f.controller.prepare({ action: "configure", enabled: false })
    await enteredPreview.promise
    f.controller.update({ ...f.selected, directory: "/other" })
    waitPreview.resolve({
      operation: "configure",
      payload: { expected: 0, enabled: false },
      expected: 0,
      repository: "repo",
      scope,
      previewId: previewID,
      sha256: digest,
      expiresAt: 1_120_000,
    })
    await preparing
    expect(f.state().preview).toBeUndefined()
    expect(f.state().read).toBeUndefined()
    f.controller.dispose()
    const waitConfirm = Promise.withResolvers<ReviewMemoryControl.ConfirmationResult>()
    const enteredConfirm = Promise.withResolvers<void>()
    const g = fixture({
      confirm: async () => {
        enteredConfirm.resolve()
        return waitConfirm.promise
      },
    })
    await g.controller.refresh()
    await g.controller.prepare({ action: "configure", enabled: false })
    g.controller.approve(true)
    const confirming = g.controller.confirm()
    await enteredConfirm.promise
    await g.controller.confirm()
    g.controller.update({ ...g.selected, owner: "guest" })
    waitConfirm.resolve({ enabled: false, generation: 1 })
    await confirming
    expect(g.state().read).toBeUndefined()
    expect(g.state().retry).toBeUndefined()
    expect(g.state().message).toContain("owner")
    g.controller.dispose()
  })

  test("fresh scope or generation changes never retarget the displayed action", async () => {
    const f = fixture()
    await f.controller.refresh()
    f.controller.editDraft({ text: "PRIVATE_DRAFT" })
    f.set({ ...f.snapshot(), scope: otherScope })
    await f.controller.prepare({ action: "configure", enabled: false })
    expect(f.calls.prepares).toEqual([])
    expect(f.state().read).toBeUndefined()
    expect(f.state().draft.text).toBe("")
    expect(f.state().message).toContain("scope changed")
    await f.controller.refresh()
    expect(f.state().read?.scope).toBe(otherScope)
    f.set({ ...f.snapshot(), state: { ...f.snapshot().state, generation: 1 } })
    await f.controller.prepare({ action: "configure", enabled: false })
    expect(f.calls.prepares).toEqual([])
    expect(f.state().read?.state.generation).toBe(1)
    f.controller.dispose()
  })

  test("a failed fresh owner read clears all private display state and never silently confirms", async () => {
    let denied = false
    const f = fixture({
      inspect: async () => {
        if (denied) throw new ReviewMemoryRequestError("denied")
        return f.snapshot()
      },
    })
    await f.controller.refresh()
    f.controller.editDraft({ text: "PRIVATE_DRAFT" })
    denied = true
    await f.controller.refresh()
    expect(f.state().status).toBe("unavailable")
    expect(JSON.stringify(f.state())).not.toContain("PRIVATE_")
    expect(f.calls.prepares).toEqual([])
    expect(f.calls.confirms).toEqual([])
    f.controller.dispose()
  })

  test("lost confirm keeps only the opaque exact approval; GET cannot claim a commit or create a new preview", async () => {
    const f = fixture({
      confirm: async (input) => {
        f.calls.confirms.push(input)
        f.set({ ...f.snapshot(), state: { ...f.snapshot().state, generation: 1, enabled: false } })
        throw new Error("PRIVATE_UPSTREAM_MESSAGE")
      },
    })
    await f.controller.refresh()
    await f.controller.prepare({ action: "configure", enabled: false })
    f.controller.approve(true)
    await f.controller.confirm()
    expect(f.state().retry).toEqual({ previewId: previewID, approvedSha256: digest })
    expect(f.state().read).toBeUndefined()
    expect(f.state().preview).toBeUndefined()
    expect(JSON.stringify(f.state())).not.toContain("PRIVATE_")
    await f.controller.refresh()
    expect(f.state().retry).toEqual({ previewId: previewID, approvedSha256: digest })
    expect(f.state().message).toContain("does not prove")
    await f.controller.prepare({ action: "erase" })
    await f.controller.retry()
    expect(f.calls.prepares).toHaveLength(1)
    expect(f.calls.confirms).toHaveLength(1)
    f.controller.approveRetry(true)
    await f.controller.retry()
    expect(f.calls.confirms).toEqual([
      { previewId: previewID, approvedSha256: digest },
      { previewId: previewID, approvedSha256: digest },
    ])
    f.controller.dispose()
  })

  test("used replay and service restart never report an exact successful earlier commit or resubmit a new approval", async () => {
    let calls = 0
    const f = fixture({
      confirm: async (input) => {
        f.calls.confirms.push(input)
        if (++calls === 1) throw new Error("lost")
        throw new ReviewMemoryRequestError("used")
      },
    })
    await f.controller.refresh()
    await f.controller.prepare({ action: "configure", enabled: false })
    f.controller.approve(true)
    await f.controller.confirm()
    f.controller.approveRetry(true)
    await f.controller.retry()
    expect(f.state().retry).toBeUndefined()
    expect(f.state().message).toContain("does not prove")
    expect(f.calls.prepares).toHaveLength(1)
    f.controller.dispose()
    const g = fixture({
      confirm: async () => {
        throw new ReviewMemoryRequestError("unavailable")
      },
    })
    await g.controller.refresh()
    await g.controller.prepare({ action: "configure", enabled: false })
    g.controller.approve(true)
    await g.controller.confirm()
    expect(g.state().status).toBe("unavailable")
    expect(g.state().preview).toBeUndefined()
    expect(g.state().retry).toBeUndefined()
    expect(g.state().read).toBeUndefined()
    g.controller.dispose()
  })

  test("monotonic idle expiry clears approval and uncertain retry even after an intervening GET", async () => {
    const f = fixture()
    await f.controller.refresh()
    await f.controller.prepare({ action: "approve", id: proposed.id })
    f.controller.approve(true)
    f.advance(ReviewMemoryControl.LIMIT.ttl + 1)
    expect(f.state().preview).toBeUndefined()
    expect(f.state().approved).toBe(false)
    await f.controller.confirm()
    expect(f.calls.confirms).toHaveLength(0)
    f.controller.dispose()
    const g = fixture({
      confirm: async () => {
        throw new Error("lost")
      },
    })
    await g.controller.refresh()
    await g.controller.prepare({ action: "configure", enabled: false })
    g.controller.approve(true)
    await g.controller.confirm()
    await g.controller.refresh()
    expect(g.state().retry).toBeDefined()
    g.advance(ReviewMemoryControl.LIMIT.ttl + 1)
    expect(g.state().retry).toBeUndefined()
    g.controller.dispose()
  })

  test("unknown capability, guests and disconnected scopes send zero requests; paging stays bounded and disposal clears text", async () => {
    for (const selection of [
      { capability: undefined },
      { capability: false },
      { owner: "guest" as const },
      { connected: false },
    ]) {
      const f = fixture({}, selection)
      await f.controller.refresh()
      await f.controller.prepare({ action: "erase" })
      expect(f.calls.reads).toEqual([])
      expect(f.calls.prepares).toEqual([])
      expect(f.state().status).toBe("unavailable")
      f.controller.dispose()
    }
    const f = fixture()
    await f.controller.refresh(201)
    expect(f.calls.reads).toEqual([])
    await f.controller.refresh(50)
    expect(f.calls.reads).toEqual([{ offset: 50, limit: 50 }])
    f.controller.editDraft({ text: "PRIVATE_DRAFT" })
    f.controller.dispose()
    expect(JSON.stringify(f.state())).not.toContain("PRIVATE_")
  })

  test("expiry during a delayed read or failed confirmation cannot resurrect an opaque approval", async () => {
    let held: Promise<ReviewMemoryControl.Inspect> | undefined
    const f = fixture({
      inspect: async () => held ?? f.snapshot(),
      confirm: async () => {
        throw new Error("lost")
      },
    })
    await f.controller.refresh()
    await f.controller.prepare({ action: "configure", enabled: false })
    f.controller.approve(true)
    await f.controller.confirm()
    const delayed = Promise.withResolvers<ReviewMemoryControl.Inspect>()
    held = delayed.promise
    const reading = f.controller.refresh()
    f.advance(ReviewMemoryControl.LIMIT.ttl + 1)
    delayed.resolve(f.snapshot())
    await reading
    expect(f.state().retry).toBeUndefined()
    expect(f.state().approved).toBe(false)
    f.controller.dispose()
    const entered = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<ReviewMemoryControl.ConfirmationResult>()
    const g = fixture({
      confirm: async () => {
        entered.resolve()
        return failed.promise
      },
    })
    await g.controller.refresh()
    await g.controller.prepare({ action: "configure", enabled: false })
    g.controller.approve(true)
    const confirming = g.controller.confirm()
    await entered.promise
    g.advance(ReviewMemoryControl.LIMIT.ttl + 1)
    failed.reject(new Error("lost after expiry"))
    await confirming
    expect(g.state().retry).toBeUndefined()
    expect(g.state().preview).toBeUndefined()
    g.controller.dispose()
  })
})
