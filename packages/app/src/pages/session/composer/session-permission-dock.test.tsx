import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test, vi } from "bun:test"
import { createRequire } from "node:module"
import { resolveTemplate } from "@solid-primitives/i18n"
import type { PermissionRequest, QuestionRequest, Session } from "@vectordevai/sdk/v2"
import { Hands } from "@vectordevai/schema/hands"
import { dict } from "../../../i18n/en"
import type { SessionPermissionDock } from "./session-permission-dock"
import type { createSessionComposerController } from "./session-composer-state"

// Bun does not run Vite's Solid JSX transform. Compile these real UI components with the same installed
// preset, then let Bun strip TypeScript. Keep this fixture in the normal src unit suite, including when
// it runs without --conditions=browser; only app contexts are mocked, never the dock, buttons or model.
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

let Dock: typeof SessionPermissionDock
let createController: typeof createSessionComposerController
let contexts: ReturnType<typeof controllerContexts>
const cleanups: (() => void)[] = []

beforeAll(async () => {
  Bun.plugin({
    name: "permission dock Solid DOM fixture",
    setup(build) {
      build.onLoad(
        { filter: /(?:session-permission-dock|dock-prompt|dock-surface|button|icon)\.tsx$/ },
        async (args) => ({
          contents:
            babel.transformSync(await Bun.file(args.path).text(), {
              filename: args.path,
              babelrc: false,
              configFile: false,
              parserOpts: { plugins: ["typescript", "jsx"] },
              presets: [[compiler.resolve("babel-preset-solid"), { generate: "dom", hydratable: false }]],
            })?.code ?? "",
          loader: "ts",
        }),
      )
      build.onLoad({ filter: /session-permission-dock\.css$/ }, () => ({ contents: "", loader: "js" }))
    },
  })
  mock.module("@solidjs/router", () => ({ useParams: () => ({ id: "session" }) }))
  mock.module("@/context/sdk", () => ({ useSDK: () => () => contexts.sdk }))
  mock.module("@/context/sync", () => ({ useSync: () => () => contexts.sync }))
  mock.module("@/context/server-sync", () => ({ useServerSync: () => () => contexts.server }))
  mock.module("@/context/permission", () => ({ usePermission: () => ({ autoResponds: () => false }) }))
  mock.module("@/utils/toast", () => ({ showToast: () => undefined }))
  Dock = (await import("./session-permission-dock")).SessionPermissionDock
  createController = (await import("./session-composer-state")).createSessionComposerController
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  vi.useRealTimers()
})
afterAll(() => {
  Bun.plugin.clearAll()
  mock.restore()
})

const appKey = "app:macos:com.apple.notes"
function app(id = "app-request"): PermissionRequest {
  return {
    id,
    sessionID: "session",
    permission: "computer_app",
    patterns: ["window:42:0", appKey],
    always: [appKey],
    metadata: {
      action: "use_app",
      level: "interact",
      target: {
        appName: "Notes",
        appKey,
        platform: "macos",
        publisher: "Apple Inc.",
        verified: true,
        category: "office",
        icon: "data:image/png;base64,aGVsbG8=",
      },
      canAlways: true,
      mentioned: true,
      reason: "Summarize the meeting.",
    },
  }
}

function sensitive(): PermissionRequest {
  return {
    ...app("sensitive-request"),
    permission: "computer_sensitive",
    metadata: {
      action: "click",
      why: "send",
      target: { appName: "Mail", appKey: "app:macos:com.apple.mail" },
      targetName: "Send",
    },
  }
}

function mount(request = app(), onDecide?: (reply: string) => Promise<boolean>) {
  const composer = document.createElement("textarea")
  composer.value = "hello"
  document.body.append(composer)
  composer.focus()
  const host = document.createElement("div")
  document.body.append(host)
  const replies: string[] = []
  const [state, setState] = store.createStore({ request, responding: false })
  cleanups.push(
    web.render(
      () =>
        solid.createComponent(Dock, {
          get request() {
            return state.request
          },
          get responding() {
            return state.responding
          },
          onDecide(reply) {
            replies.push(reply)
            return onDecide?.(reply) ?? Promise.resolve(true)
          },
        }),
      host,
    ),
  )
  return {
    host,
    composer,
    replies,
    setState,
    dock: () => host.querySelector<HTMLDivElement>('[data-component="dock-prompt"]')!,
    button: (label: string) => [...host.querySelectorAll("button")].find((button) => button.textContent === label)!,
  }
}

function key(target: HTMLElement, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function pointer(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }))
}

describe("Hands permission dock", () => {
  test("renders the app identity and fixed copy without stealing focus or exposing patterns", () => {
    const view = mount()
    expect(document.activeElement).toBe(view.composer)
    expect(view.host.querySelector('[role="heading"]')?.textContent).toBe(`Allow ${Hands.NAME} to use Notes?`)
    expect(view.host.textContent).toContain("From Apple Inc.")
    expect(view.host.textContent).toContain("You mentioned Notes in your message.")
    expect(view.host.textContent).toContain("The agent says: “Summarize the meeting.”")
    expect(view.host.textContent).not.toContain("window:42:0")
    expect(view.host.textContent).not.toContain(appKey)
    expect(view.host.querySelector("img")?.getAttribute("alt")).toBe("")
    expect(view.button("Allow").disabled).toBe(true)
    expect(view.button("Always allow").disabled).toBe(true)
    expect(view.button("Deny").disabled).toBe(false)
  })

  test("composer Enter and a bubbled event with focus elsewhere never answer the ask", () => {
    const view = mount()
    vi.advanceTimersByTime(700)
    key(view.composer, "Enter")
    key(view.dock(), "Enter")
    expect(view.composer.value).toBe("hello")
    expect(view.replies).toEqual([])
    expect(document.activeElement).toBe(view.composer)
  })

  test("Enter inside the dock is disabled through 699ms and replies once at 700ms", () => {
    const view = mount()
    view.button("Deny").focus()
    vi.advanceTimersByTime(699)
    expect(key(view.button("Deny"), "Enter").defaultPrevented).toBe(true)
    pointer(view.button("Allow"))
    pointer(view.button("Always allow"))
    expect(view.replies).toEqual([])
    vi.advanceTimersByTime(1)
    expect(view.button("Allow").disabled).toBe(false)
    expect(view.button("Allow").hasAttribute("data-computer-arming")).toBe(false)
    key(view.button("Deny"), "Enter")
    key(view.button("Deny"), "Enter")
    pointer(view.button("Allow"))
    expect(view.replies).toEqual(["once"])
  })

  test("Escape shares the app keyboard delay; pointer Deny is immediate", () => {
    const view = mount()
    view.button("Deny").focus()
    key(view.button("Deny"), "Escape")
    expect(view.replies).toEqual([])
    vi.advanceTimersByTime(700)
    key(view.button("Deny"), "Escape")
    expect(view.replies).toEqual(["reject"])
    const other = mount(app("other"))
    pointer(other.button("Deny"))
    expect(other.replies).toEqual(["reject"])
  })

  test("editable elements within the dock never become approval shortcuts", () => {
    const view = mount()
    vi.advanceTimersByTime(700)
    for (const element of [document.createElement("input"), document.createElement("div")]) {
      element.contentEditable = "true"
      element.tabIndex = 0
      view.dock().append(element)
      element.focus()
      expect(key(element, "Enter").defaultPrevented).toBe(false)
      expect(key(element, "Escape").defaultPrevented).toBe(false)
    }
    expect(view.replies).toEqual([])
  })

  test("a sensitive ask blocks native Enter, Space and synthetic keyboard clicks", () => {
    const view = mount(sensitive())
    expect(view.host.textContent).toContain("This sends a message.")
    expect(view.button("Always allow")).toBeUndefined()
    pointer(view.button("Allow once"))
    expect(view.replies).toEqual([])
    vi.advanceTimersByTime(700)
    for (const button of [view.button("Allow once"), view.button("Deny")]) {
      button.focus()
      for (const value of ["Enter", "Escape", " "]) expect(key(button, value).defaultPrevented).toBe(true)
      button.click()
    }
    expect(view.replies).toEqual([])
    pointer(view.button("Allow once"))
    expect(view.replies).toEqual(["once"])
  })

  test("browser and malformed computer asks never expose Always or raw fallback patterns", () => {
    const request = app()
    const browser = mount({
      ...request,
      metadata: { ...request.metadata, target: { ...(request.metadata.target as object), category: "browser" } },
    })
    expect(browser.button("Always allow")).toBeUndefined()
    expect(browser.host.textContent).toContain(`${Hands.NAME} always asks for browsers`)
    const malformed = mount({ ...app("malformed"), metadata: { targetName: "Trust this malicious label" } })
    expect(malformed.host.querySelectorAll("button")).toHaveLength(1)
    expect(malformed.host.textContent).not.toContain("Trust this malicious label")
    expect(malformed.host.textContent).not.toContain("window:42:0")
    pointer(malformed.button("Deny"))
    expect(malformed.replies).toEqual(["reject"])
  })

  test("replacing a request rearms it, while replacing only its object preserves timing and the reply latch", () => {
    const view = mount()
    vi.advanceTimersByTime(500)
    view.setState("request", app("next"))
    vi.advanceTimersByTime(200)
    pointer(view.button("Allow"))
    expect(view.replies).toEqual([])
    view.setState("request", app("next"))
    vi.advanceTimersByTime(500)
    pointer(view.button("Always allow"))
    expect(view.replies).toEqual(["always"])
    view.setState("request", app("next"))
    pointer(view.button("Allow"))
    expect(view.replies).toEqual(["always"])
  })

  test("responding prevents decisions and failed replies unlock explicit retry only", async () => {
    let fail = true
    const view = mount(app(), async () => !fail)
    vi.advanceTimersByTime(700)
    view.setState("responding", true)
    pointer(view.button("Allow"))
    expect(view.replies).toEqual([])
    view.setState("responding", false)
    pointer(view.button("Allow"))
    await Promise.resolve()
    expect(view.button("Allow").disabled).toBe(false)
    fail = false
    pointer(view.button("Allow"))
    await Promise.resolve()
    view.setState("responding", false)
    pointer(view.button("Allow"))
    expect(view.replies).toEqual(["once", "once"])
  })

  test("a stale failed reply cannot unlock a replacement request or shorten its delay", async () => {
    const pending = Promise.withResolvers<boolean>()
    const view = mount(app(), () => pending.promise)
    vi.advanceTimersByTime(700)
    pointer(view.button("Allow"))
    view.setState("request", app("replacement"))
    pending.resolve(false)
    await Promise.resolve()
    pointer(view.button("Allow"))
    expect(view.replies).toEqual(["once"])
    expect(view.button("Allow").disabled).toBe(true)
  })

  test("ordinary permissions retain their existing immediate buttons and patterns", () => {
    const view = mount({ ...app(), permission: "bash", patterns: ["git status"], always: ["git status"], metadata: {} })
    expect(view.host.textContent).toContain("git status")
    expect(view.button("Allow once").disabled).toBe(false)
    pointer(view.button("Allow once"))
    expect(view.replies).toEqual(["once"])
  })

  test("another tool's permission that shares the computer_ prefix keeps the ordinary dock", () => {
    // A plugin tool can ask any id, and an MCP server named "computer use" asks `computer_use_<tool>` with empty
    // metadata (mcp/catalog.ts toolName); the engine refuses a server named "computer" itself.
    for (const permission of ["computer_screenshot", "computer_click", "computer_app_extra", "computer_observe"]) {
      const view = mount({ ...app(permission), permission, patterns: ["*"], always: ["*"], metadata: {} })
      expect(view.host.textContent).toContain("Permission required")
      expect(view.host.textContent).not.toContain(Hands.NAME)
      expect(view.button("Allow once").disabled).toBe(false)
      // The prefix still never offers a saved approval (PermissionPolicy.canAlwaysApprove).
      expect(view.button("Allow always")).toBeUndefined()
      pointer(view.button("Allow once"))
      expect(view.replies).toEqual(["once"])
    }
  })

  test("thrown and rejected decision failures both allow an explicit retry", async () => {
    for (const fail of [
      () => {
        throw new Error("failed")
      },
      () => Promise.reject(new Error("failed")),
    ]) {
      const view = mount(app(), fail)
      vi.advanceTimersByTime(700)
      pointer(view.button("Allow"))
      await Promise.resolve()
      expect(view.button("Allow").disabled).toBe(false)
      pointer(view.button("Allow"))
      await Promise.resolve()
      expect(view.replies).toEqual(["once", "once"])
    }
  })
})

function controllerContexts(request = app()) {
  const [data, setData] = store.createStore({
    session: [{ id: "session" } as Session],
    permission: { session: [request] },
    question: { session: [] as QuestionRequest[] },
    session_working: () => true,
  })
  const modern = mock((_input: object, _options: object) => Promise.resolve({ data: true }))
  const legacy = mock((_input: object) => Promise.resolve({ data: true }))
  return {
    setData,
    modern,
    legacy,
    sdk: { directory: "/repo", client: { permission: { reply: modern, respond: legacy } } },
    sync: { data, set: () => undefined },
    server: { session: { data: { todo: {} } } },
  }
}

function controller(request = app()) {
  contexts = controllerContexts(request)
  return solid.createRoot((dispose) => {
    cleanups.push(dispose)
    return { state: createController(), ...contexts }
  })
}

describe("Hands permission controller", () => {
  test("keeps only computer asks composable, while the pending decision still blocks execution", () => {
    const view = controller()
    expect(view.state.blocked()).toBe(true)
    expect(view.state.promptAllowed()).toBe(true)
    expect(view.state.computerPending()).toBe(true)
    view.setData("question", "session", [{ id: "question", sessionID: "session", questions: [] }])
    expect(view.state.promptAllowed()).toBe(false)
    expect(view.state.computerPending()).toBe(false)
    view.setData("question", "session", [])
    view.setData("permission", "session", [{ ...app(), permission: "bash" }])
    expect(view.state.promptAllowed()).toBe(false)
    view.setData("permission", "session", [])
    expect(view.state.promptAllowed()).toBe(true)
    expect(view.state.blocked()).toBe(false)
  })

  test("binds the visible ID, uses modern replies, and deduplicates successful acknowledgements before SSE", async () => {
    const view = controller()
    expect(view.state.decide("once", "old-request")).toBeUndefined()
    expect(view.modern).not.toHaveBeenCalled()
    expect(await view.state.decide("once", "app-request")).toBe(true)
    expect(view.modern).toHaveBeenCalledWith({ requestID: "app-request", reply: "once" }, { throwOnError: true })
    expect(view.state.permissionResponding()).toBe(false)
    await view.state.decide("always", "app-request")
    expect(view.modern).toHaveBeenCalledTimes(1)
    expect(view.legacy).not.toHaveBeenCalled()
    view.setData("permission", "session", [app("next-request")])
    view.state.decide("reject", "app-request")
    await view.state.decide("reject", "next-request")
    expect(view.modern).toHaveBeenCalledTimes(2)
  })

  test("a failed HTTP reply permits retry, while a concurrent duplicate does not", async () => {
    const view = controller()
    view.modern.mockRejectedValueOnce(new Error("network failed"))
    const first = view.state.decide("once", "app-request")
    view.state.decide("once", "app-request")
    expect(await first).toBe(false)
    expect(view.modern).toHaveBeenCalledTimes(1)
    expect(await view.state.decide("once", "app-request")).toBe(true)
    expect(view.modern).toHaveBeenCalledTimes(2)
  })

  test("ordinary permissions retain the session response endpoint and response body", async () => {
    const view = controller({ ...app("ordinary"), permission: "bash" })
    view.state.decide("once", "ordinary")
    await Promise.resolve()
    expect(view.legacy).toHaveBeenCalledWith({ sessionID: "session", permissionID: "ordinary", response: "once" })
    expect(view.modern).not.toHaveBeenCalled()
  })

  test("another tool's computer_ permission blocks the composer and answers like any ordinary ask", async () => {
    const view = controller({ ...app("mcp"), permission: "computer_screenshot", metadata: {} })
    expect(view.state.computerPending()).toBe(false)
    expect(view.state.promptAllowed()).toBe(false)
    view.state.decide("once", "mcp")
    await Promise.resolve()
    expect(view.legacy).toHaveBeenCalledWith({ sessionID: "session", permissionID: "mcp", response: "once" })
    expect(view.modern).not.toHaveBeenCalled()
  })
})
