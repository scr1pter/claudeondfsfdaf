import { beforeEach, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { BrowserAgentInput } from "../preload/types"

// What the agent browser's commands do to a page: typing, keys, clicks, lists, hovering and the checks before them.
// The page is happy-dom (a DOM for tests), and the stand-in for Electron's web contents runs every
// script Vector sends, in either world, against it, as Chromium would. happy-dom has no layout, so where an element is
// and what shows at a point are set by each test. Trusted key events are played into the focused field the way
// Chromium plays them: a char event types its character, and Enter in an editable element starts a new block. What
// only a real Electron run can show (modifier keys reaching a page, select all and undo, Chromium's dialogs) is left to
// the desktop smoke. Each desktop test file runs in its own process, so this file's Electron mock stays its own.

GlobalRegistrator.register({ url: "http://localhost:3000/" })

type Listener = { listener(...input: unknown[]): unknown }["listener"]
type Input = { type: string; keyCode?: string; modifiers?: string[]; x?: number; y?: number }

// The script Vector sends, run in the page: its value, a promise's included.
const evaluate = (code: string): unknown => (0, eval)(code)

// What holds focus, followed into open shadow roots and frames, as Chromium routes a key event.
const focused = () => {
  const state = { active: document.activeElement as Element | null }
  while (state.active?.shadowRoot?.activeElement) state.active = state.active.shadowRoot.activeElement
  return state.active
}

class FakeContents {
  readonly id = 1
  readonly listeners = new Map<string, Listener[]>()
  readonly inputs: Input[] = []
  readonly edits: string[] = []
  url = ""
  /** Runs before a key event reaches the page, as a page's own key handler would. */
  onKey?: (event: Input) => void
  /** Whether Electron refuses an event, as it does a key code it cannot read. */
  refuses?: (event: Input) => boolean
  readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  once(event: string, listener: Listener) {
    return this.on(event, listener)
  }
  removeListener(event: string, listener: Listener) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((item) => item !== listener),
    )
    return this
  }
  emit(event: string, ...input: unknown[]) {
    ;(this.listeners.get(event) ?? []).forEach((listener) => listener(...input))
  }
  setWindowOpenHandler() {}
  /** The debugger, as the tab's file chooser interception drives it: it records what it was sent. */
  readonly debugger = {
    sent: [] as { method: string; params?: unknown }[],
    attached: false,
    attach: () => {
      page.debugger.attached = true
    },
    detach: () => {
      page.debugger.attached = false
    },
    isAttached: () => page.debugger.attached,
    sendCommand: async (method: string, params?: unknown) => void page.debugger.sent.push({ method, params }),
    on: () => undefined,
    removeListener: () => undefined,
  }
  async loadURL(url: string) {
    this.emit("did-start-navigation")
    this.url = url
  }
  isLoading() {
    return false
  }
  isDestroyed() {
    return false
  }
  getURL() {
    return this.url
  }
  getTitle() {
    return document.title
  }
  getZoomFactor() {
    return 1
  }
  focus() {}
  close() {}
  selectAll() {
    this.edits.push("selectAll")
  }
  undo() {
    this.edits.push("undo")
  }
  redo() {
    this.edits.push("redo")
  }
  async executeJavaScript(code: string) {
    return evaluate(code)
  }
  async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) {
    return evaluate(scripts[0]!.code)
  }
  sendInputEvent(event: Input) {
    if (this.refuses?.(event)) throw new Error("Invalid event object")
    this.inputs.push(event)
    if (event.type === "keyDown") this.onKey?.(event)
    if (event.type !== "char" || !event.keyCode) return
    const named: Record<string, string> = { Space: " ", Enter: "\n", Tab: "\t" }
    const text = named[event.keyCode] ?? (event.keyCode.length === 1 ? event.keyCode : "")
    const field = focused()
    if (!text || !field) return
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      if (text === "\n" && field instanceof HTMLInputElement) return
      const start = field.selectionStart ?? field.value.length
      const end = field.selectionEnd ?? field.value.length
      field.value = field.value.slice(0, start) + text + field.value.slice(end)
      field.setSelectionRange(start + text.length, start + text.length)
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }))
      return
    }
    if (field.getAttribute("contenteditable") !== "true") return
    if (text === "\n") return void field.appendChild(document.createElement("div"))
    ;(field.lastElementChild ?? field).append(text)
  }
}

const page = new FakeContents()
class FakeView {
  readonly webContents = page
  setBackgroundColor() {}
  setBounds() {}
  setVisible() {}
  getVisible() {
    return true
  }
}
class FakeWindow {
  readonly contentView = { addChildView() {}, removeChildView() {} }
  readonly webContents = { send() {} }
  constructor(readonly options?: Record<string, unknown>) {}
  once() {}
  isDestroyed() {
    return false
  }
  destroy() {}
}
const electron = {
  BrowserWindow: Object.assign(FakeWindow, { fromWebContents: () => undefined }),
  WebContentsView: FakeView,
  session: {
    fromPartition: () => ({
      on() {},
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: { onSendHeaders() {}, onCompleted() {}, onErrorOccurred() {} },
    }),
  },
}
mock.module("electron", () => ({ default: electron, ...electron }))

const agent = await import("./browser-agent")
const { CLIPBOARD_REFUSED } = await import("./browser-agent-keys")
// One page for the whole file, opened once; settling is left to the tabs tests.
const run = (input: Omit<BrowserAgentInput, "contextId">) =>
  agent.runBrowserAgent(undefined, { contextId: "ses_input", settle: false, ...input })
await run({ command: "openUrl", url: "http://localhost:3000/" })

const html = (body: string) => {
  document.body.innerHTML = body
}
const byId = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T
// Where an element is, as Chromium would lay it out; elementFromPoint says what shows there.
const place = (element: Element, box: { left: number; top: number; width: number; height: number }) =>
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height }),
    configurable: true,
  })
const showAt = (find: () => Element | null) =>
  Object.defineProperty(document, "elementFromPoint", { value: find, configurable: true })
const refusal = (target: string) =>
  `Refused to send keystrokes to ${target}: it is a credential field (password, one-time code, or card number). Vector never fills credentials — use handoff so the user can complete this step in the live browser.`
const MOD = process.platform === "darwin" ? "meta" : "control"

beforeEach(() => {
  page.inputs.length = 0
  page.edits.length = 0
  page.onKey = undefined
  page.refuses = undefined
  showAt(() => null)
})

describe("type by selector", () => {
  test("a multi-line message in an editable element is typed with keys and left as the editor built it", async () => {
    html(`<div id="composer" contenteditable="true"></div>`)
    const typed = await run({ command: "type", selector: "#composer", text: "Hello\nWorld" })
    expect(typed.ok).toBe(true)
    expect(typed.actions[0]!.label).toBe("Typed into #composer")
    // The line break is a block of its own, as typing made it, and not one text node written over the editor.
    expect(byId("composer").innerHTML).toBe("Hello<div>World</div>")
  })

  test("a field the page removes while Vector types fails the command instead of reporting it typed", async () => {
    html(`<input id="q">`)
    page.onKey = () => byId("q").remove()
    const typed = await run({ command: "type", selector: "#q", text: "heat pumps" })
    expect(typed).toMatchObject({
      ok: false,
      error: "Focus left #q while Vector typed, so it stopped. Check the page again.",
    })
  })

  test("a tab in the text moves focus off the field, and typing stops before a space can press what holds it", async () => {
    html(`<input id="name"><button id="pay">Pay</button>`)
    const clicks: string[] = []
    byId("pay").addEventListener("click", () => clicks.push("pay"))
    // Chromium moves focus on Tab's keyDown.
    page.onKey = (event) => {
      if (event.keyCode === "Tab") byId("pay").focus()
    }
    const typed = await run({ command: "type", selector: "#name", text: "x\t " })
    expect(typed).toMatchObject({
      ok: false,
      error: "Focus left #name while Vector typed, so it stopped. Check the page again.",
    })
    // The Tab's keyDown went, and nothing after it: no char, no space.
    expect(page.inputs.map((input) => [input.type, input.keyCode])).toEqual([
      ["keyDown", "x"],
      ["char", "x"],
      ["keyUp", "x"],
      ["keyDown", "Tab"],
    ])
    expect(byId<HTMLInputElement>("name").value).toBe("x")
    expect(clicks).toEqual([])
  })

  test("a button, a checkbox or a list is no field to type into, so no key reaches it", async () => {
    html(`<button id="pay">Pay</button><input id="agree" type="checkbox"><select id="size"></select>`)
    for (const selector of ["#pay", "#agree", "#size"])
      expect({ selector, report: await run({ command: "type", selector, text: " " }) }).toMatchObject({
        selector,
        report: {
          ok: false,
          error: `${selector} is no text field: Vector types into text fields, text areas and editable text. Use select_option for a list.`,
        },
      })
    expect(page.inputs).toEqual([])
  })

  test("a key handler that moves focus into a shadow root's password field stops the next character", async () => {
    html(`<input id="name"><x-login id="login"></x-login>`)
    const shadow = byId("login").attachShadow({ mode: "open" })
    shadow.innerHTML = `<input id="secret" type="password">`
    page.onKey = () => (shadow.getElementById("secret") as HTMLInputElement).focus()
    const typed = await run({ command: "type", selector: "#name", text: "hunter2" })
    expect(typed).toMatchObject({ ok: false, error: refusal("the focused field") })
    expect((shadow.getElementById("secret") as HTMLInputElement).value).toBe("")
    expect(page.inputs.map((input) => input.type)).toEqual(["keyDown"])
  })
})

describe("typeRef", () => {
  test("types into a field observe named, with trusted keys, and checks what it shows", async () => {
    html(`<label for="name">Name</label><input id="name" value="old"><input id="secret" type="password" name="pin">`)
    const observed = await run({ command: "observePage" })
    expect(observed.observed?.elements.map((element) => [element.ref, element.name])).toEqual([
      ["ref_1", "Name"],
      ["ref_2", "pin"],
    ])
    const typed = await run({ command: "typeRef", ref: "ref_1", text: "Ana" })
    expect(typed.ok).toBe(true)
    expect(byId<HTMLInputElement>("name").value).toBe("Ana")
    expect(page.inputs.filter((input) => input.type === "char").map((input) => input.keyCode)).toEqual(["A", "n", "a"])
    expect(typed.actions[0]!.label).toBe("Typed into ref_1")
    page.inputs.length = 0
    expect(await run({ command: "typeRef", ref: "ref_2", text: "hunter2" })).toMatchObject({
      ok: false,
      error: refusal("ref_2"),
    })
    expect(page.inputs).toEqual([])
  })

  test("a multi-line message goes into an editable element as typed", async () => {
    html(`<div id="editor" contenteditable="true" aria-label="Message"></div>`)
    await run({ command: "observePage" })
    expect((await run({ command: "typeRef", ref: "ref_1", text: "Hello\nWorld" })).ok).toBe(true)
    expect(byId("editor").innerHTML).toBe("Hello<div>World</div>")
  })

  test("a character no key types is written with the field's value, and focus that moves stops the typing", async () => {
    html(`<input id="name" aria-label="Name"><input id="other" aria-label="Other">`)
    await run({ command: "observePage" })
    page.refuses = (event) => event.keyCode === "🙂"
    const typed = await run({ command: "typeRef", ref: "ref_1", text: "Hi 🙂" })
    expect(typed.ok).toBe(true)
    expect(byId<HTMLInputElement>("name").value).toBe("Hi 🙂")
    expect(typed.actions[0]!.label).toBe("Typed into ref_1 (native setter fallback)")
    page.refuses = undefined
    page.onKey = () => byId<HTMLInputElement>("other").focus()
    expect(await run({ command: "typeRef", ref: "ref_1", text: "abc" })).toMatchObject({
      ok: false,
      error: "Focus left ref_1 while Vector typed, so it stopped. Observe the page again.",
    })
    expect(byId<HTMLInputElement>("other").value).toBe("")
  })
})

describe("press", () => {
  test("sends a combination's modifiers, and no character with Control or Meta", async () => {
    html(`<textarea id="note"></textarea>`)
    byId<HTMLTextAreaElement>("note").focus()
    expect((await run({ command: "press", key: "Control+Enter" })).ok).toBe(true)
    expect(page.inputs).toEqual([
      { type: "keyDown", keyCode: "Enter", modifiers: ["control"] },
      { type: "keyUp", keyCode: "Enter", modifiers: ["control"] },
    ])
    page.inputs.length = 0
    await run({ command: "press", key: "Shift+Tab" })
    expect(page.inputs.map((input) => [input.type, input.keyCode, input.modifiers])).toEqual([
      ["keyDown", "Tab", ["shift"]],
      ["char", "Tab", ["shift"]],
      ["keyUp", "Tab", ["shift"]],
    ])
  })

  test("select all, undo and redo run as the page's own commands", async () => {
    await run({ command: "press", key: "Mod+a" })
    await run({ command: "press", key: "Mod+Z" })
    await run({ command: "press", key: "Mod+Shift+z" })
    await run({ command: "press", key: `${MOD === "meta" ? "Cmd" : "Ctrl"}+y` })
    expect(page.edits).toEqual(["selectAll", "undo", "redo", "redo"])
    expect(page.inputs).toEqual([])
  })

  test("refuses the clipboard's keys", async () => {
    for (const key of ["Mod+c", "Mod+X", "Mod+v", "Mod+Shift+v", "Shift+Insert", "Control+Insert"])
      expect({ key, report: await run({ command: "press", key }) }).toMatchObject({
        key,
        report: { ok: false, error: CLIPBOARD_REFUSED },
      })
    expect(page.inputs).toEqual([])
  })

  test("a combination Electron refuses fails, with no synthetic events in its place", async () => {
    html(`<input id="field">`)
    byId<HTMLInputElement>("field").focus()
    const seen: string[] = []
    byId("field").addEventListener("keydown", () => seen.push("keydown"))
    page.refuses = (event) => event.keyCode === "Pause"
    expect(await run({ command: "press", key: "Alt+Pause" })).toMatchObject({
      ok: false,
      error: "The browser could not press Alt+Pause.",
    })
    expect(seen).toEqual([])
    expect(await run({ command: "press", key: "Hyper+a" })).toMatchObject({
      ok: false,
      error: "Vector does not know the modifier Hyper.",
    })
  })

  test("a key that types a character goes through the credential guard, focus followed into a shadow root", async () => {
    html(`<x-login id="login"></x-login>`)
    const shadow = byId("login").attachShadow({ mode: "open" })
    shadow.innerHTML = `<input id="secret" type="password">`
    ;(shadow.getElementById("secret") as HTMLInputElement).focus()
    for (const key of ["h", "Shift+h", "Alt+e"])
      expect({ key, report: await run({ command: "press", key }) }).toMatchObject({
        key,
        report: { ok: false, error: refusal("the focused field") },
      })
    expect(page.inputs).toEqual([])
    // Keys that type nothing still reach the field.
    expect((await run({ command: "press", key: "Tab" })).ok).toBe(true)
    expect((await run({ command: "press", key: `${MOD === "meta" ? "Meta" : "Control"}+Enter` })).ok).toBe(true)
  })

  test("Enter or Space on a focused file field, and typing into one, are refused: they would open a file picker", async () => {
    html(`<input id="upload" type="file"><x-upload id="host"></x-upload>`)
    byId<HTMLInputElement>("upload").focus()
    for (const key of ["Enter", "Space", " ", "\r", "Shift+Enter"])
      expect({ key, report: await run({ command: "press", key }) }).toMatchObject({
        key,
        report: {
          ok: false,
          error: `Vector never opens a file picker in a page, so it did not press ${key} on that file field.`,
        },
      })
    const shadow = byId("host").attachShadow({ mode: "open" })
    shadow.innerHTML = `<input id="inner" type="FILE">`
    ;(shadow.getElementById("inner") as HTMLInputElement).focus()
    expect((await run({ command: "press", key: "Enter" })).ok).toBe(false)
    expect(page.inputs).toEqual([])
    // A key that presses nothing moves on from it.
    expect((await run({ command: "press", key: "Tab" })).ok).toBe(true)
    expect(await run({ command: "type", selector: "#upload", text: "a b" })).toMatchObject({
      ok: false,
      error: "Vector never opens a file picker in a page, so it did not type into that file field.",
    })
  })

  test("Enter or Space in a frame, object or embed Vector cannot read is refused: it may hold a file field", async () => {
    for (const host of [`<iframe id="widget"></iframe>`, `<object id="widget"></object>`, `<embed id="widget">`]) {
      html(host)
      const widget = byId("widget")
      // As Chromium shows a document of another origin to the page: none.
      Object.defineProperty(widget, "contentDocument", { value: null, configurable: true })
      widget.setAttribute("tabindex", "0")
      widget.focus()
      for (const key of ["Enter", "\r", "Shift+Enter", "Space"])
        expect({ host, key, report: await run({ command: "press", key }) }).toMatchObject({
          host,
          key,
          report: {
            ok: false,
            error: `Vector did not press ${key}: focus is in a frame Vector cannot read, where it could open a file picker. Click what you mean instead.`,
          },
        })
      // A key that presses nothing still goes, and a key that types a character is refused by the credential guard.
      expect((await run({ command: "press", key: "Tab" })).ok).toBe(true)
      page.inputs.length = 0
      expect(await run({ command: "press", key: "a" })).toMatchObject({
        ok: false,
        error: refusal("the focused field"),
      })
      expect(page.inputs).toEqual([])
    }
  })
})

describe("clicks, hovers and lists", () => {
  test("a selector click takes the trusted path, and never clicks a file field or its label", async () => {
    html(`<input type="file" id="upload"><label for="upload" id="pick">Upload</label><button id="go">Go</button>`)
    const clicks: string[] = []
    byId("upload").addEventListener("click", () => clicks.push("upload"))
    for (const selector of ["#upload", "#pick"])
      expect({ selector, report: await run({ command: "click", selector }) }).toMatchObject({
        selector,
        report: {
          ok: false,
          error: "Vector never opens a file picker in a page, so it did not click that file field.",
        },
      })
    expect(clicks).toEqual([])
    // Shown where it is: trusted input at its centre.
    place(byId("go"), { left: 20, top: 40, width: 100, height: 30 })
    showAt(() => byId("go"))
    expect((await run({ command: "click", selector: "#go" })).ok).toBe(true)
    expect(page.inputs.map((input) => [input.type, input.x, input.y])).toEqual([
      ["mouseMove", 70, 55],
      ["mouseDown", 70, 55],
      ["mouseUp", 70, 55],
    ])
    // Covered: the DOM's own click.
    byId("go").addEventListener("click", () => clicks.push("go"))
    showAt(() => document.body)
    expect((await run({ command: "click", selector: "#go" })).ok).toBe(true)
    expect(clicks).toEqual(["go"])
    expect(await run({ command: "click", selector: "#missing" })).toMatchObject({
      ok: false,
      error: "No element matches selector: #missing",
    })
  })

  test("hover moves a trusted pointer to the element's centre, by ref or selector", async () => {
    html(`<button id="menu" aria-label="Menu">≡</button>`)
    place(byId("menu"), { left: 0, top: 100, width: 40, height: 20 })
    await run({ command: "observePage" })
    expect((await run({ command: "hover", ref: "ref_1" })).ok).toBe(true)
    expect((await run({ command: "hover", selector: "#menu" })).ok).toBe(true)
    expect(page.inputs).toEqual([
      { type: "mouseMove", x: 20, y: 110 },
      { type: "mouseMove", x: 20, y: 110 },
    ])
  })

  test("selectOption chooses in a <select> by ref or selector, and says what the list offers when nothing matches", async () => {
    html(
      `<label for="size">Size</label><select id="size"><option value="s">Small</option><option value="m">Medium</option></select>`,
    )
    const changes: string[] = []
    byId("size").addEventListener("change", () => changes.push(byId<HTMLSelectElement>("size").value))
    await run({ command: "observePage" })
    const chosen = await run({ command: "selectOption", ref: "ref_1", values: ["Medium"] })
    expect(chosen.ok).toBe(true)
    expect(chosen.actions[0]!.label).toBe("Selected Medium in ref_1")
    expect(await run({ command: "selectOption", selector: "#size", values: ["s"] })).toMatchObject({ ok: true })
    expect(changes).toEqual(["m", "s"])
    expect(await run({ command: "selectOption", ref: "ref_1", values: ["Large"] })).toMatchObject({
      ok: false,
      error: 'No option of that list is "Large". It offers: Small, Medium',
    })
  })
})

describe("the page Vector checked is the page it acts on", () => {
  test("a command expecting another origin does nothing", async () => {
    html(`<button id="send">Send</button>`)
    const clicks: string[] = []
    byId("send").addEventListener("click", () => clicks.push("send"))
    expect(await run({ command: "click", selector: "#send", expectOrigin: "https://mail.example" })).toMatchObject({
      ok: false,
      error:
        "The page changed to http://localhost:3000 since Vector checked it, so nothing was done. Check the page again.",
    })
    expect(clicks).toEqual([])
    expect((await run({ command: "click", selector: "#send", expectOrigin: "http://localhost:3000" })).ok).toBe(true)
    expect(clicks).toEqual(["send"])
  })

  test("a command judged on a tab with no page yet expects none, so a page loaded in between takes nothing", async () => {
    html(`<button id="send">Send</button>`)
    const clicks: string[] = []
    byId("send").addEventListener("click", () => clicks.push("send"))
    for (const input of [
      { command: "click", selector: "#send" },
      { command: "press", key: "Enter" },
      { command: "type", selector: "#send", text: "x" },
      { command: "scroll", deltaY: 100 },
    ] as const)
      expect({ command: input.command, report: await run({ ...input, expectOrigin: "" }) }).toMatchObject({
        command: input.command,
        report: {
          ok: false,
          error:
            "The page changed to http://localhost:3000 since Vector checked it, so nothing was done. Check the page again.",
        },
      })
    expect(clicks).toEqual([])
    expect(page.inputs).toEqual([])
  })

  test("a click whose target no longer has the name judged clicks nothing", async () => {
    html(`<button id="action">Cancel</button>`)
    const clicks: string[] = []
    byId("action").addEventListener("click", () => clicks.push(byId("action").textContent ?? ""))
    await run({ command: "observePage" })
    const inspected = await run({ command: "inspectDom", ref: "ref_1" })
    expect(inspected.target).toEqual({ found: true, label: "Cancel" })
    byId("action").textContent = "Pay now"
    expect(await run({ command: "clickRef", ref: "ref_1", expectLabel: "Cancel" })).toMatchObject({
      ok: false,
      error: "The element changed since Vector checked it, so nothing was clicked. Check the page again.",
    })
    expect(await run({ command: "click", selector: "#action", expectLabel: "Cancel" })).toMatchObject({ ok: false })
    expect(clicks).toEqual([])
    expect((await run({ command: "clickRef", ref: "ref_1", expectLabel: "Pay now" })).ok).toBe(true)
    expect(clicks).toEqual(["Pay now"])
  })
})

describe("reading the page", () => {
  test("inspectPageHtml says how long the whole document is when it sends only the start", async () => {
    html(`<main>${"<p>Field study notes.</p>".repeat(6_000)}</main>`)
    const read = await run({ command: "inspectPageHtml" })
    expect(read.pageHtml).toHaveLength(120_000)
    expect(read.pageHtmlTotal).toBe(document.documentElement.outerHTML.length)
    expect(read.pageHtmlTotal).toBeGreaterThan(120_000)
  })
})

describe("dialogs", () => {
  test("what a page's alert, confirm or prompt asked is in the next report, once", async () => {
    html(`<p>Ready</p>`)
    // Dialogs are off in this browser: each returns at once. The hook keeps what the page asked.
    Object.assign(window, { alert: () => undefined, confirm: () => false, prompt: () => null })
    page.emit("dom-ready")
    await Bun.sleep(0)
    expect(window.confirm("Delete this project?")).toBe(false)
    window.alert("Saved")
    const report = await run({ command: "wait", milliseconds: 0 })
    expect(report.dialogs).toEqual([
      { type: "confirm", message: "Delete this project?", url: "http://localhost:3000/", at: expect.any(String) },
      { type: "alert", message: "Saved", url: "http://localhost:3000/", at: expect.any(String) },
    ])
    expect((await run({ command: "wait", milliseconds: 0 })).dialogs).toBeUndefined()
  })
})
