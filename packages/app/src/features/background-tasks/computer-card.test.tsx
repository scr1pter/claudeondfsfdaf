import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test, vi } from "bun:test"
import { createRequire } from "node:module"
import { resolveTemplate } from "@solid-primitives/i18n"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import type { PermissionRequest } from "@vectordevai/sdk/v2"
import { dict } from "../../i18n/en"
import type { FakeComputer } from "../computer/fake-platform"
import type { ComputerCard as Card } from "./computer-card"

// Bun does not run Vite's Solid JSX transform. Compile the real card with the same installed preset, as the
// permission dock's test does; only app contexts (language, SDK, sync, toast) are mocked. The Hands state is the real
// shared state, fed by the real fake platform or by real engine events.
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
const ui = await import("@vectordevai/ui/i18n/en")
const translations: Record<string, string> = { ...dict, ...ui.dict }
const t = (key: string, params?: Record<string, string | number | boolean>) =>
  resolveTemplate(translations[key] ?? key, params)
mock.module("@/context/language", () => ({ useLanguage: () => ({ t }) }))

const ROOT = "ses_root"
const OTHER = "ses_other"
const appKey = "app:macos:com.apple.iwork.numbers"

type Reply = { requestID: string; reply: string }
const contexts = {
  replies: [] as Reply[],
  aborts: [] as string[],
  toasts: [] as unknown[],
  answer: (_reply: Reply): Promise<unknown> => Promise.resolve(true),
  abort: (_sessionID: string): Promise<unknown> => Promise.resolve(true),
  permission: undefined as unknown as ReturnType<typeof store.createStore<Record<string, PermissionRequest[]>>>,
}

let ComputerCard: typeof Card
let stateModule: typeof import("../computer/use-computer-state")
let fake: typeof import("../computer/fake-platform")
const cleanups: (() => void)[] = []

beforeAll(async () => {
  Bun.plugin({
    name: "computer card Solid DOM fixture",
    setup(build) {
      build.onLoad({ filter: /computer-card\.tsx$/ }, async (args) => ({
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
  mock.module("@/context/sdk", () => ({
    useSDK: () => () => ({
      client: {
        permission: {
          reply: (input: Reply) => {
            contexts.replies.push({ requestID: input.requestID, reply: input.reply })
            return contexts.answer(input)
          },
        },
        session: {
          abort: (input: { sessionID: string }) => {
            contexts.aborts.push(input.sessionID)
            return contexts.abort(input.sessionID)
          },
        },
      },
    }),
  }))
  mock.module("@/context/sync", () => ({
    useSync: () => () => ({ data: { permission: contexts.permission[0] } }),
  }))
  mock.module("@/utils/toast", () => ({ showToast: (toast: unknown) => contexts.toasts.push(toast) }))
  stateModule = await import("../computer/use-computer-state")
  fake = await import("../computer/fake-platform")
  ComputerCard = (await import("./computer-card")).ComputerCard
})

beforeEach(() => {
  vi.useFakeTimers()
  contexts.replies = []
  contexts.aborts = []
  contexts.toasts = []
  contexts.answer = () => Promise.resolve(true)
  contexts.abort = () => Promise.resolve(true)
  contexts.permission = store.createStore<Record<string, PermissionRequest[]>>({})
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  vi.useRealTimers()
})
afterAll(() => {
  Bun.plugin.clearAll()
  mock.restore()
})

function state(patch: Partial<Computer.ComputerState> = {}): Computer.ComputerState {
  return {
    phase: "working",
    backend: "local-macos",
    mode: "foreground",
    holder: { sessionID: ROOT, directory: "/repo", title: "Receipts", startedAt: Date.now(), actions: 1 },
    apps: [{ key: appKey, name: "Numbers" }],
    step: "Clicking “Save” in Numbers",
    queue: [],
    escStops: true,
    stopChord: "⌘⇧Esc",
    lease: 1,
    reduceMotion: false,
    ...patch,
  }
}

function appAsk(id: string): PermissionRequest {
  return {
    id,
    sessionID: ROOT,
    permission: "computer_app",
    patterns: [appKey],
    always: [appKey],
    metadata: {
      action: "use_app",
      level: "interact",
      target: { appName: "Numbers", appKey, platform: "macos", verified: true, category: "office" },
      canAlways: true,
    },
  }
}

function asking(requestID: string, kind: "app" | "sensitive" | "handoff" | "check_in" | "pointer" = "app") {
  return state({
    phase: kind === "handoff" ? "handoff" : "asking",
    ask: {
      requestID,
      directory: "/repo",
      kind,
      title: `Allow ${Hands.NAME} to use Numbers?`,
      canAlways: false,
      shownAt: 1,
    },
  })
}

/** Mounts the real card with the real shared state: the fake desktop, or engine events when `desktop` is false. */
function mount(options: { desktop?: boolean; rootID?: string } = {}) {
  const composer = document.createElement("textarea")
  document.body.append(composer)
  composer.focus()
  const host = document.createElement("div")
  document.body.append(host)
  const desktop: FakeComputer = fake.createFakeComputer()
  const engine = new Set<(event: { sessionID: string; state: unknown }) => void>()
  const opened: unknown[] = []
  const reviewed: unknown[] = []
  cleanups.push(
    web.render(() => {
      const value = stateModule.createComputerState({
        desktop: options.desktop === false ? undefined : desktop,
        listen: (cb) => {
          engine.add(cb)
          return () => engine.delete(cb)
        },
        working: () => true,
      })
      return solid.createComponent(stateModule.ComputerStateContext.Provider, {
        value,
        get children() {
          return solid.createComponent(ComputerCard, {
            rootID: options.rootID ?? ROOT,
            onOpen: (holder) => opened.push(holder),
            onReview: (holder) => reviewed.push(holder),
          })
        },
      })
    }, host),
  )
  return {
    host,
    composer,
    desktop,
    opened,
    reviewed,
    push: (next: Computer.ComputerState) =>
      options.desktop === false
        ? engine.forEach((cb) => cb({ sessionID: next.holder!.sessionID, state: next }))
        : desktop.emit(next),
    button: (label: string) => [...host.querySelectorAll("button")].find((button) => button.textContent === label),
    commands: () => desktop.calls.filter((call) => call.method === "command"),
  }
}

function click(target: HTMLElement | undefined) {
  target!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }))
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("Hands Tasks card", () => {
  test("shows the status, step, app and action count of the open conversation's run", () => {
    const view = mount()
    view.push(state({ queue: [{ sessionID: OTHER, title: "Taxes" }] }))
    expect(view.host.querySelector('[data-computer-card="holder"]')).not.toBeNull()
    expect(view.host.textContent).toContain(Hands.NAME)
    expect(view.host.textContent).toContain("Working")
    expect(view.host.textContent).toContain("Clicking “Save” in Numbers")
    expect(view.host.textContent).toContain("Numbers")
    expect(view.host.textContent).toContain("1 action")
    expect(view.host.textContent).not.toContain("1 actions")
    expect(view.host.textContent).toContain("+1 waiting")
    view.push(state({ holder: { sessionID: OTHER, directory: "/other", title: "Taxes", startedAt: 0, actions: 3 } }))
    expect(view.host.querySelector("[data-computer-card]")).toBeNull()
  })

  test("Allow is inert through 699 ms, armed at 700 ms, and nothing takes focus", () => {
    contexts.permission[1](ROOT, [appAsk("per_a")])
    const view = mount()
    view.push(asking("per_a"))
    const allow = view.button("Allow")!
    expect(allow.disabled).toBe(true)
    expect(allow.dataset.computerArming).toBe("true")
    click(allow)
    vi.advanceTimersByTime(699)
    click(view.button("Allow"))
    expect(contexts.replies).toEqual([])
    vi.advanceTimersByTime(1)
    expect(view.button("Allow")!.disabled).toBe(false)
    expect(document.activeElement).toBe(view.composer)
    click(view.button("Allow"))
    expect(contexts.replies).toEqual([{ requestID: "per_a", reply: "once" }])
    expect(view.button("Always allow")).toBeUndefined()
  })

  test("each request is answered once while its reply is pending", async () => {
    contexts.permission[1](ROOT, [appAsk("per_a")])
    let resolve = (_value: unknown) => {}
    contexts.answer = () => new Promise((done) => (resolve = done))
    const view = mount()
    view.push(asking("per_a"))
    vi.advanceTimersByTime(700)
    click(view.button("Allow"))
    click(view.button("Allow"))
    click(view.button("Deny"))
    expect(contexts.replies).toEqual([{ requestID: "per_a", reply: "once" }])
    resolve(true)
    await flush()
    // A successful reply stays latched until the request leaves the store.
    click(view.button("Deny"))
    expect(contexts.replies).toHaveLength(1)
  })

  test("a failed reply shows an error and can be tried again", async () => {
    contexts.permission[1](ROOT, [appAsk("per_a")])
    contexts.answer = () => Promise.reject(new Error("offline"))
    const view = mount()
    view.push(asking("per_a"))
    vi.advanceTimersByTime(700)
    click(view.button("Allow"))
    await flush()
    expect(contexts.toasts).toHaveLength(1)
    expect(view.button("Allow")!.disabled).toBe(false)
    contexts.answer = () => Promise.resolve(true)
    click(view.button("Allow"))
    expect(contexts.replies.map((reply) => reply.requestID)).toEqual(["per_a", "per_a"])
  })

  test("a new request re-arms, and a late answer for the old one cannot answer or unlock it", async () => {
    contexts.permission[1](ROOT, [appAsk("per_a")])
    let fail = (_error: unknown) => {}
    contexts.answer = () => new Promise((_, reject) => (fail = reject))
    const view = mount()
    view.push(asking("per_a"))
    vi.advanceTimersByTime(700)
    click(view.button("Allow"))
    contexts.permission[1](ROOT, [appAsk("per_b")])
    view.push(asking("per_b"))
    expect(view.host.querySelector("[data-computer-ask]")?.getAttribute("data-computer-ask")).toBe("per_b")
    expect(view.button("Allow")!.disabled).toBe(true)
    fail(new Error("late"))
    await flush()
    expect(contexts.toasts).toEqual([])
    click(view.button("Allow"))
    expect(contexts.replies).toEqual([{ requestID: "per_a", reply: "once" }])
    vi.advanceTimersByTime(700)
    contexts.answer = () => Promise.resolve(true)
    click(view.button("Allow"))
    expect(contexts.replies).toEqual([
      { requestID: "per_a", reply: "once" },
      { requestID: "per_b", reply: "once" },
    ])
  })

  test("an app ask shows the dock's access line and warnings beside Allow", () => {
    const risky = appAsk("per_risky")
    contexts.permission[1](ROOT, [
      {
        ...risky,
        metadata: {
          ...risky.metadata,
          target: {
            appName: "Numbers",
            appKey,
            platform: "macos",
            verified: false,
            category: "developer",
            ownBuild: { repo: "receipts-app" },
          },
          localWarning: true,
        },
      },
      { ...appAsk("per_observe"), metadata: { ...appAsk("per_observe").metadata, level: "observe" } },
    ])
    const view = mount()
    view.push(asking("per_risky"))
    const ask = view.host.querySelector("[data-computer-ask]")!
    const warnings = [...ask.querySelectorAll('[data-variant="warning"]')].map((node) => node.textContent)
    expect(warnings).toEqual([
      t("computer.ask.unverified"),
      t("computer.ask.category.developer", { name: Hands.NAME, app: "Numbers" }),
      t("computer.ask.builtApp", { repo: "receipts-app" }),
      t("computer.ask.localNetwork"),
    ])
    expect(ask.textContent).toContain(t("computer.ask.app.body", { app: "Numbers" }))
    expect(view.button("Allow")).toBeDefined()
    // An observe-only grant says so, and a verified ordinary app carries no warning.
    view.push(asking("per_observe"))
    const observe = view.host.querySelector("[data-computer-ask]")!
    expect(observe.textContent).toContain(t("computer.ask.app.bodyObserve", { app: "Numbers" }))
    expect(observe.textContent).not.toContain(t("computer.ask.app.body", { app: "Numbers" }))
    expect(observe.querySelectorAll('[data-variant="warning"]')).toHaveLength(0)
  })

  test("Deny answers at once, before the arm delay", () => {
    contexts.permission[1](ROOT, [appAsk("per_a")])
    const view = mount()
    view.push(asking("per_a"))
    click(view.button("Deny"))
    expect(contexts.replies).toEqual([{ requestID: "per_a", reply: "reject" }])
  })

  test("sensitive, handoff and check-in asks, and an app ask not pending here, only link to the conversation", () => {
    const view = mount()
    for (const [id, kind] of [
      ["per_s", "sensitive"],
      ["que_h", "handoff"],
      ["que_c", "check_in"],
      ["per_missing", "app"],
    ] as const) {
      view.push(asking(id, kind))
      expect(view.button("Allow")).toBeUndefined()
      expect(view.button("Deny")).toBeUndefined()
      expect(view.button("Allow once")).toBeUndefined()
      click(view.button("Review in the conversation"))
    }
    expect(view.reviewed).toHaveLength(4)
    expect(view.reviewed[0]).toEqual({ sessionID: ROOT, directory: "/repo" })
    expect(contexts.replies).toEqual([])
  })

  test("a pointer ask is shown, never answered on the card", () => {
    const view = mount()
    view.push(asking("ptr_1", "pointer"))
    expect(view.button("Hand over")).toBeUndefined()
    expect(view.button("Not now")).toBeUndefined()
    expect(view.button("Review in the conversation")).toBeUndefined()
    expect(view.host.textContent).toContain(`Allow ${Hands.NAME} to use Numbers?`)
  })

  test("a pointer wait shows the mouse sentence and Stop, never Resume", () => {
    const view = mount()
    view.push(
      state({
        phase: "paused",
        pause: "pointer",
        ask: { requestID: "ptr_1", directory: "/repo", kind: "pointer", title: "", canAlways: false, shownAt: 1 },
      }),
    )
    expect(view.host.textContent).toContain(`${Hands.NAME} needs the mouse for a moment`)
    expect(view.button("Resume")).toBeUndefined()
    expect(view.button("Hand over")).toBeUndefined()
    expect(view.button("Not now")).toBeUndefined()
    expect(view.button("Stop")).toBeDefined()
    expect(view.commands()).toEqual([])
  })

  test("Stop, Take over and Resume reach the desktop, and Take over and Resume swap", () => {
    const view = mount()
    view.push(state())
    expect(view.button("Resume")).toBeUndefined()
    click(view.button("Take over"))
    click(view.button("Stop"))
    view.push(state({ phase: "paused", pause: "input" }))
    expect(view.host.textContent).toContain("Paused — you have control")
    expect(view.button("Take over")).toBeUndefined()
    click(view.button("Resume"))
    expect(view.commands()).toEqual([
      { method: "command", command: "takeover" },
      { method: "command", command: "stop" },
      { method: "command", command: "resume" },
    ])
    expect(contexts.aborts).toEqual([])
  })

  test("when the desktop rejects Stop, the turn of the holder shown at the click is aborted", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    const view = mount()
    const command = view.desktop.command
    let fail = (_error: unknown) => {}
    view.desktop.command = async (name, arg) => {
      await command(name, arg)
      return new Promise((_, reject) => (fail = reject))
    }
    view.push(state())
    click(view.button("Stop"))
    await flush()
    // Another conversation takes the computer before the desktop answers; the abort still targets the one clicked.
    view.push(state({ holder: { sessionID: OTHER, directory: "/other", title: "Taxes", startedAt: 0, actions: 3 } }))
    fail(new Error("helper gone"))
    await flush()
    expect(view.commands()).toEqual([{ method: "command", command: "stop" }])
    expect(contexts.aborts).toEqual([ROOT])
    expect(errors).toHaveBeenCalledTimes(1)
    expect(contexts.toasts).toEqual([])
    errors.mockRestore()
  })

  test("Stop shows an error only when the desktop and the abort both fail", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    contexts.abort = () => Promise.reject(new Error("offline"))
    const view = mount()
    view.desktop.command = () => Promise.reject(new Error("helper gone"))
    view.push(state())
    click(view.button("Stop"))
    await flush()
    expect(contexts.aborts).toEqual([ROOT])
    expect(contexts.toasts).toHaveLength(1)
    errors.mockRestore()
  })

  test("a finished run offers no Stop, and a background run no Take over", () => {
    const view = mount()
    view.push(state({ mode: "background" }))
    expect(view.button("Take over")).toBeUndefined()
    view.push(state({ phase: "done" }))
    expect(view.host.textContent).toContain("Done")
    expect(view.button("Stop")).toBeUndefined()
  })

  test("a queued conversation's Stop fails only its own call, and Open that task opens the holder", () => {
    const view = mount({ rootID: OTHER })
    view.push(state({ queue: [{ sessionID: OTHER, title: "Taxes" }] }))
    expect(view.host.textContent).toContain("Waiting for the computer: Receipts is using it")
    click(view.button("Stop"))
    click(view.button("Open that task"))
    expect(view.commands()).toEqual([{ method: "command", command: "stop-session", arg: { sessionID: OTHER } }])
    expect(view.opened).toEqual([{ sessionID: ROOT, directory: "/repo" }])
  })

  test("without the desktop, Stop aborts the holder's turn and a queued card has no Stop", () => {
    const view = mount({ desktop: false })
    view.push(state())
    expect(view.button("Take over")).toBeUndefined()
    click(view.button("Stop"))
    expect(contexts.aborts).toEqual([ROOT])
    expect(view.commands()).toEqual([])

    const queued = mount({ desktop: false, rootID: OTHER })
    queued.push(state({ queue: [{ sessionID: OTHER, title: "Taxes" }] }))
    expect(queued.host.textContent).toContain("Waiting for the computer: Receipts is using it")
    expect(queued.button("Stop")).toBeUndefined()
    expect(queued.button("Open that task")).toBeDefined()
  })

  test("secure typing names the app that holds it and says how to continue", () => {
    const view = mount()
    view.push(state({ phase: "paused", pause: "secure_input", secureInputHolder: "1Password" }))
    expect(view.host.textContent).toContain("Paused — secure typing is on in 1Password")
    expect(view.host.textContent).toContain("1Password turned on secure keyboard entry")
  })
})
