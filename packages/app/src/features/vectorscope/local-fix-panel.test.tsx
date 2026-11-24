import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { ReviewFixControl } from "@vectordevai/schema/review-fix"
import type { PlacedFinding } from "@vectordevai/core/review/types"
import type { ReviewOutcomeLite } from "../pull-requests/ai-review"
import type { LocalFixAPI, LocalFixSource, LocalFixState } from "./local-fix"
import type { LocalFixPanel, LocalFixView } from "./local-fix-panel"
import type { LocalFixSlot, localFixesMounted } from "./local-fix-slot"

// VS-12d (SF-10b): the fix panel's presentation and its mount boundary, rendered in happy-dom. Bun does not run Vite's
// Solid JSX transform, so the real view, slot, button and icon are compiled with the installed preset, as the share
// dialog's test does. Only the two server contexts the panel module imports are replaced; the view runs the real
// controller against a recording LocalFixAPI. Playwright (scope-app-validation.yml) clicks it in a real browser.
const compiler = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = compiler("@babel/core") as {
  transformSync(source: string, options: object): { code?: string | null } | null
}
const browserSolid = "solid-js/dist/solid.js"
const solid: typeof import("solid-js") = await import(browserSolid)
mock.module("solid-js", () => solid)
const browserWeb = "solid-js/web/dist/web.js"
const web: typeof import("solid-js/web") = await import(browserWeb)
mock.module("solid-js/web", () => web)
const browserStore = "solid-js/store/dist/store.js"
const store: typeof import("solid-js/store") = await import(browserStore)
mock.module("solid-js/store", () => store)

let View: typeof LocalFixView
let Panel: typeof LocalFixPanel
// What the two server contexts give LocalFixPanel; the view tests never read them.
let panelSDK: unknown
let panelSync: unknown
let Slot: typeof LocalFixSlot
let mounted: typeof localFixesMounted
let fix: typeof import("./local-fix")
const cleanups: (() => void)[] = []

beforeAll(async () => {
  Bun.plugin({
    name: "local fix Solid DOM fixture",
    setup(build) {
      build.onLoad({ filter: /(?:local-fix-panel|local-fix-slot|button|icon)\.tsx$/ }, async (args) => ({
        contents:
          babel.transformSync(await Bun.file(args.path).text(), {
            filename: args.path,
            babelrc: false,
            configFile: false,
            parserOpts: { plugins: ["typescript", "jsx"] },
            presets: [[compiler.resolve("babel-preset-solid"), { generate: "dom", hydratable: false }]],
          })?.code ?? "",
        loader: "ts",
      }))
    },
  })
  // LocalFixPanel reads these; the view tests do not.
  mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => panelSDK }))
  mock.module("@/context/server-sync", () => ({ useServerSync: () => () => panelSync }))
  const panel = await import("./local-fix-panel")
  View = panel.LocalFixView
  Panel = panel.LocalFixPanel
  const slot = await import("./local-fix-slot")
  Slot = slot.LocalFixSlot
  mounted = slot.localFixesMounted
  fix = await import("./local-fix")
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})
afterAll(() => {
  Bun.plugin.clearAll()
  mock.restore()
})

const head = "a".repeat(40)
const base = "b".repeat(40)
const FILE = "export const a = () => {\n  return 1\n}\n"
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

function source(patch: Partial<ReviewOutcomeLite> = {}): LocalFixSource {
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
    suggestion: '  return "<b>2</b>"',
    anchor: { path: "src/a.ts", side: "RIGHT", line: 2, hunk: 0 },
    suggestionAllowed: true,
  }
  return {
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
      ...patch,
    },
    pr: { number: 7, headRefOid: head, baseRefOid: base, baseRefName: "main" },
    dismissed: new Set(),
    applied: new Set(),
  }
}

const elsewhere: ReviewFixControl.Summary = {
  fixID: "fix_elsewhere",
  state: "applied",
  head,
  sourceBranch: "feature",
  destinationBranch: "vector/fix-elsewhere",
  digest: `sha256:${"1".repeat(64)}`,
  patchDigest: `sha256:${"2".repeat(64)}`,
}

function engine(open: ReviewFixControl.Summary[] = [], execute?: LocalFixAPI["execute"]) {
  const calls: string[] = []
  const fixID = "fix_0123abcd"
  let patch = ""
  const api: LocalFixAPI = {
    list: async () => {
      calls.push("list")
      return { fixes: open }
    },
    read: async (path) => {
      calls.push(`read ${path}`)
      return FILE
    },
    prepare: async (request) => {
      calls.push("prepare")
      patch = request.patch
      open = [
        ...open,
        {
          fixID,
          state: "preview",
          head,
          sourceBranch: "feature",
          destinationBranch: "vector/fix-0123abcd",
          digest: `sha256:${"1".repeat(64)}`,
          patchDigest: `sha256:${sha(patch)}`,
        },
      ]
      return {
        fixID,
        repository: "/repo",
        worktree: "/fix/worktree",
        head: request.head,
        base: request.base,
        sourceBranch: "feature",
        baseBranch: request.baseBranch,
        destinationBranch: "vector/fix-0123abcd",
        source: { kind: "client" },
        findingsVerified: false,
        findings: [...request.findings],
        digest: `sha256:${"1".repeat(64)}`,
        patchDigest: `sha256:${sha(request.patch)}`,
        patch: request.patch,
        files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
        notes: ["The engine did not verify the findings this fix names."],
      }
    },
    preview: async (id, request) => {
      calls.push(`preview ${request.kind}`)
      return {
        offerID: "00000000-0000-4000-8000-000000000001",
        fixID: id,
        operation: { kind: "apply" },
        operationDigest: `sha256:${"2".repeat(64)}`,
        head,
        digest: `sha256:${"1".repeat(64)}`,
        patchDigest: `sha256:${sha(patch)}`,
        expiresAt: Date.now() + 300_000,
        notes: [],
      } satisfies ReviewFixControl.Offer
    },
    execute: async (id, body, signal) => {
      calls.push("execute")
      if (execute) return execute(id, body, signal)
      throw new Error("no execute in this test")
    },
    cancel: async (id) => {
      calls.push(`cancel ${id}`)
      open = open.filter((item) => item.fixID !== id)
      return { fixID: id, removed: true }
    },
  }
  return { api, calls }
}

function mount(
  input: {
    source?: LocalFixSource
    enabled?: boolean
    dwellMs?: number
    open?: ReviewFixControl.Summary[]
    execute?: LocalFixAPI["execute"]
  } = {},
) {
  const fake = engine(input.open, input.execute)
  const [state, setState] = store.createStore({
    value: { fixes: [], results: [], uncertain: false, error: "" } as LocalFixState,
  })
  const controller = fix.localFixController({
    scope: {
      identity: {},
      server: "test",
      parentID: "ses_parent",
      directory: "/repo",
      projectID: "project",
      api: fake.api,
    },
    enabled: () => input.enabled !== false,
    dismissed: () => new Set(),
    changed: (value) => setState("value", store.reconcile(value)),
    ...(input.dwellMs === undefined ? {} : { dwellMs: input.dwellMs }),
  })
  const host = document.createElement("div")
  document.body.append(host)
  const view = input.source ?? source()
  cleanups.push(
    web.render(
      () =>
        solid.createComponent(View, {
          get state() {
            return state.value
          },
          enabled: input.enabled !== false,
          source: () => view,
          controller,
          ...(input.dwellMs === undefined ? {} : { dwellMs: input.dwellMs }),
        }),
      host,
    ),
  )
  cleanups.push(() => controller.dispose())
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)
  return { host, calls: fake.calls, button, controller }
}

async function until(done: () => boolean, attempts = 400) {
  for (let attempt = 0; attempt < attempts && !done(); attempt++) await new Promise((resolve) => setTimeout(resolve, 2))
  expect(done()).toBe(true)
}

describe("the fix panel's mount boundary", () => {
  test("mounts only for an engine with the owner fix API and with the global setting on", () => {
    const on = { experimental: { vectorscope: true } }
    expect(mounted(true, on)).toBe(true)
    expect(mounted(false, on)).toBe(false)
    expect(mounted(true, undefined)).toBe(false)
    expect(mounted(true, { experimental: { vectorscope: false } })).toBe(false)
    expect(mounted(true, {})).toBe(false)
    expect(mounted(true, { ...on, agent: { vectorscope: { disable: true } } })).toBe(false)
    expect(mounted(true, { experimental: { vectorscope: "true" as unknown as boolean } })).toBe(false)
  })

  test("the slot renders nothing without the layout's prop or for uncommitted changes, and a dismissal never remounts it", async () => {
    const [pr, setPr] = solid.createSignal<{ number: number; baseRefName: string } | undefined>()
    const [render, setRender] = solid.createSignal<
      ((input: { dismissed: () => ReadonlySet<string> }) => Node) | undefined
    >()
    const [dismissed, setDismissed] = solid.createSignal<ReadonlySet<string>>(new Set())
    const seen: ReadonlySet<string>[] = []
    let renders = 0
    const host = document.createElement("div")
    document.body.append(host)
    cleanups.push(
      web.render(
        () =>
          solid.createComponent(Slot, {
            get pr() {
              return pr()
            },
            get render() {
              return render() as never
            },
            outcome: () => source().outcome,
            dismissed,
            applied: () => new Set(),
          }),
        host,
      ),
    )
    const panel = (input: { dismissed: () => ReadonlySet<string> }) => {
      renders++
      const section = document.createElement("section")
      section.setAttribute("aria-label", "Local VectorScope fixes")
      solid.createEffect(() => seen.push(input.dismissed()))
      return section
    }
    const sections = () => host.querySelectorAll('section[aria-label="Local VectorScope fixes"]').length
    setRender(() => panel)
    expect(sections()).toBe(0)
    setRender(undefined)
    setPr({ number: 7, baseRefName: "main" })
    expect(sections()).toBe(0)
    setRender(() => panel)
    expect(sections()).toBe(1)
    expect(renders).toBe(1)
    setDismissed(new Set(["f-verified"]))
    await until(() => seen.length === 2)
    expect(renders).toBe(1)
    expect([...seen.at(-1)!]).toEqual(["f-verified"])
    setPr(undefined)
    expect(sections()).toBe(0)
  })

  test("without the layout's prop the slot adds nothing to its parent's markup", () => {
    // The pull request panel's review result, reduced to the nodes around the slot: the "Not reviewed" note before it
    // and the footer after it.
    const parent = (slot: boolean, pr?: { number: number; baseRefName: string }) => {
      const host = document.createElement("div")
      document.body.append(host)
      cleanups.push(
        web.render(() => {
          const note = document.createElement("p")
          note.textContent = "Not reviewed"
          const footer = document.createElement("footer")
          footer.textContent = "Post review"
          return [
            note,
            ...(slot
              ? [
                  solid.createComponent(Slot, {
                    pr,
                    render: undefined,
                    outcome: () => source().outcome,
                    dismissed: () => new Set(),
                    applied: () => new Set(),
                  }),
                ]
              : []),
            footer,
          ]
        }, host),
      )
      return host.innerHTML
    }
    const before = parent(false)
    expect(before).toBe("<p>Not reviewed</p><footer>Post review</footer>")
    expect(parent(true, { number: 7, baseRefName: "main" })).toBe(before)
    expect(parent(true)).toBe(before)
  })
})

// scope-finish takeover (2026-11-23): the panel itself, against a fake server SDK whose event emitter the test drives
// and whose generated client answers from the same recording fake engine the view tests use.
function mountPanel() {
  const fake = engine()
  const listeners = new Set<(event: { name: string; details: { type: string } }) => void>()
  const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } as Response })
  const signal = new AbortController().signal
  const client = {
    session: { get: async () => ok({ id: "ses_parent", projectID: "project", directory: "/repo" }) },
    file: { read: async (input: { path: string }) => ok({ type: "text", content: await fake.api.read(input.path, signal) }) },
    review: {
      fix: {
        list: async () => ok(await fake.api.list(signal)),
        prepare: async (input: { reviewFixControlPrepare: never }) =>
          ok(await fake.api.prepare(input.reviewFixControlPrepare, signal)),
        preview: async (input: { fixID: string; reviewFixControlRequest: never }) =>
          ok(await fake.api.preview(input.fixID, input.reviewFixControlRequest, signal)),
        execute: async (input: { fixID: string; reviewFixControlExecute: never }) =>
          ok(await fake.api.execute(input.fixID, input.reviewFixControlExecute, signal)),
        cancel: async (input: { fixID: string }) => ok(await fake.api.cancel(input.fixID, signal)),
      },
    },
  }
  panelSDK = {
    scope: "test",
    client,
    event: {
      listen: (listener: (event: { name: string; details: { type: string } }) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
  panelSync = {
    session: {
      get: (id: string) =>
        id === "ses_parent" ? { id: "ses_parent", projectID: "project", directory: "/repo" } : undefined,
    },
    globalConfig: () => ({ experimental: { vectorscope: true } }),
  }
  const host = document.createElement("div")
  document.body.append(host)
  const view = source()
  cleanups.push(
    web.render(
      () =>
        solid.createComponent(Panel, {
          outcome: view.outcome,
          pr: view.pr,
          dismissed: new Set<string>(),
          applied: new Set<string>(),
          parentID: "ses_parent",
          directory: "/repo",
        }),
      host,
    ),
  )
  const emit = (name: string, type: string) => {
    for (const listener of [...listeners]) listener({ name, details: { type } })
  }
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)
  return { host, calls: fake.calls, button, emit }
}

describe("the fix panel under a review result", () => {
  test("another folder's instance disposal keeps the prepared fix; this folder's retires it and cancels the fix", async () => {
    const panel = mountPanel()
    await until(() => panel.calls.includes("list"))
    panel.button("Prepare a fix checkout")!.click()
    await until(() => !!panel.button("Preview apply"))
    const prepared = panel.calls.length
    // An isolated task's worktree, or another project, retiring its instance.
    panel.emit("/other", "server.instance.disposed")
    panel.emit("/repo/worktrees/task", "server.instance.disposed")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(panel.calls.slice(prepared)).toEqual([])
    expect(panel.button("Preview apply")).toBeDefined()
    // This checkout's own instance (a settings reload): the fix goes, and a new controller lists again.
    panel.emit("/repo", "server.instance.disposed")
    await until(() => panel.calls.includes("cancel fix_0123abcd"))
    await until(() => !panel.button("Preview apply"))
    await until(() => panel.calls.slice(prepared).includes("list"))
    // A reconnect retires the panel whatever folder it names.
    const listed = panel.calls.filter((call) => call === "list").length
    panel.emit("global", "server.connected")
    await until(() => panel.calls.filter((call) => call === "list").length > listed)
  })
})

describe("the fix panel's view", () => {
  test("one Prepare, then four separate step buttons, the full patch as text, and a script's click approves nothing", async () => {
    const view = mount({ dwellMs: 0 })
    const section = view.host.querySelector('section[aria-label="Local VectorScope fixes"]')!
    expect(section.textContent).toContain("Posting this review to GitHub, suggestions included, approves none of them.")
    expect(section.textContent).toContain("The engine did not check those findings again.")
    expect(section.textContent).toContain(
      `At most ${ReviewFixControl.LIMIT.fixes} fixes can be open in a repository, other conversations’ included.`,
    )
    expect(view.calls).toEqual([])
    for (const label of ["Preview apply", "Preview checks", "Preview commit", "Preview push"])
      expect(view.button(label)).toBeUndefined()
    view.button("Prepare a fix checkout")!.click()
    await until(() => !!view.button("Preview apply"))
    expect(view.calls).toEqual(["read src/a.ts", "prepare", "list"])
    expect(view.button("Preview apply")!.disabled).toBe(false)
    for (const label of ["Preview checks", "Preview commit", "Preview push"])
      expect(view.button(label)!.disabled).toBe(true)
    const patch = view.host.querySelector('pre[aria-label="Fix patch"]')!
    expect(patch.textContent).toContain('+  return "<b>2</b>"')
    expect(patch.querySelector("b")).toBeNull()
    expect(view.host.textContent).toContain("Destination: a new branch vector/fix-0123abcd in this repository")
    expect(view.host.textContent).toContain("Commands: none")
    view.button("Preview apply")!.click()
    await until(() => !!view.button("Approve and apply"))
    expect(view.calls.at(-1)).toBe("preview apply")
    expect(view.button("Preview apply")!.disabled).toBe(true)
    // happy-dom's click is not trusted, like a script's: nothing is executed and the offer stays.
    view.button("Approve and apply")!.click()
    view.button("Approve and apply")!.dispatchEvent(new MouseEvent("click", { detail: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(view.calls).not.toContain("execute")
    expect(view.button("Approve and apply")).toBeDefined()
    view.button("Dismiss")!.click()
    await until(() => !view.button("Approve and apply"))
    expect(view.button("Preview apply")!.disabled).toBe(false)
  })

  test("Approve stays disabled for the pause after an offer appears, then enables", async () => {
    const view = mount()
    view.button("Prepare a fix checkout")!.click()
    await until(() => !!view.button("Preview apply"))
    view.button("Preview apply")!.click()
    await until(() => !!view.button("Approve and apply"))
    expect(view.button("Approve and apply")!.disabled).toBe(true)
    expect(view.button("Approve and apply")!.title).toBe("Read the offer first.")
    await until(() => view.button("Approve and apply")!.disabled === false, 2_000)
  })

  test("a review the source rule refuses shows why and offers no Prepare", () => {
    const view = mount({ source: source({ authored: "untrusted" }) })
    expect(view.host.textContent).toContain(fix.LOCAL_FIX_COPY.untrusted)
    expect(view.button("Prepare a fix checkout")).toBeUndefined()
    const carried = mount({ source: source({ carried: 2 }) })
    expect(carried.host.textContent).toContain(fix.LOCAL_FIX_COPY.carried)
  })

  test("with the setting off, Prepare is disabled and a listed fix keeps its Cancel", async () => {
    const view = mount({ enabled: false, open: [elsewhere] })
    await view.controller.check()
    expect(view.host.textContent).toContain("Fixes are off in the owner’s global VectorScope settings.")
    expect(view.button("Prepare a fix checkout")!.disabled).toBe(true)
    expect(view.host.textContent).toContain("prepared elsewhere: it can only be cancelled here")
    view.button("Cancel this fix")!.click()
    await until(() => view.calls.includes("cancel fix_elsewhere"))
  })

  test("while a step runs, only its own fix's button stops it; another listed fix's Cancel is disabled", async () => {
    const gate = Promise.withResolvers<ReviewFixControl.Result>()
    const view = mount({ dwellMs: 0, open: [elsewhere], execute: () => gate.promise })
    view.button("Prepare a fix checkout")!.click()
    await until(() => !!view.button("Preview apply"))
    view.button("Preview apply")!.click()
    await until(() => !!view.button("Approve and apply"))
    // happy-dom cannot make a trusted click, so the approval a person's click makes is sent to the controller directly.
    const running = view.controller.approve({ trusted: true, clicks: 1 })
    await until(() => !!view.button("Stop and cancel this fix"))
    expect(view.button("Stop and cancel this fix")!.disabled).toBe(false)
    const other = view.button("Cancel this fix")!
    expect(other.disabled).toBe(true)
    expect(other.title).toBe(
      "A step of the fix prepared here is running. Wait for it, or stop it with that fix's own Cancel.",
    )
    other.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(view.calls.filter((call) => call.startsWith("cancel"))).toEqual([])
    gate.resolve({
      kind: "apply",
      fixID: "fix_0123abcd",
      worktree: "/fix/worktree",
      head,
      digest: `sha256:${"1".repeat(64)}`,
      patchDigest: `sha256:${"2".repeat(64)}`,
      consumedAt: 1,
      files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
    })
    await running
    await until(() => view.button("Cancel this fix")?.disabled === false)
    expect(view.calls.filter((call) => call.startsWith("cancel"))).toEqual([])
  })
})
