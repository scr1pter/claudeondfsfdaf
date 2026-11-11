import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { runInNewContext } from "node:vm"

// WP A54: the credential guard runs in an isolated world of every frame of the computer's browser and tells hostd when
// the focused field takes a password, a one-time code or card details, and where CAPTCHAs are. It reads; it never
// changes the page.

const source = readFileSync(path.join(import.meta.dir, "..", "image", "credential-guard.js"), "utf8")

type Answer = { kind: string | null; here?: boolean; child?: boolean }
type Guard = {
  classify(field: Record<string, unknown>): string | null
  captchaUrl(src: string): boolean
  focused(): Answer
  pointed(x: number, y: number): Answer
  secrets(): Answer
  captchas(): { x: number; y: number; w: number; h: number }[]
}

function load(globals: Record<string, unknown> = {}): Guard {
  const context: Record<string, unknown> = { URL, ...globals }
  context.globalThis = context
  runInNewContext(source, context)
  return context.__vectorGuard as Guard
}

describe("which fields are the person's", () => {
  const guard = load()
  const input = (attrs: Record<string, unknown>) => guard.classify({ tag: "INPUT", ...attrs })

  test("passwords and one-time codes", () => {
    expect(input({ type: "password" })).toBe("credential")
    expect(input({ autocomplete: "current-password" })).toBe("credential")
    expect(input({ autocomplete: "username one-time-code" })).toBe("credential")
    expect(input({ name: "otp" })).toBe("credential")
    expect(input({ id: "verificationCode" })).toBe("credential")
    expect(input({ label: "Enter the 6-digit security code" })).toBe("credential")
    expect(input({ placeholder: "2FA code" })).toBe("credential")
    expect(input({ name: "user_pin" })).toBe("credential")
  })

  test("card and bank details", () => {
    expect(input({ autocomplete: "cc-number" })).toBe("payment_details")
    expect(input({ autocomplete: "cc-csc" })).toBe("payment_details")
    expect(input({ name: "cardNumber" })).toBe("payment_details")
    expect(input({ ariaLabel: "CVV" })).toBe("payment_details")
    expect(input({ label: "Expiration date" })).toBe("payment_details")
    expect(input({ name: "iban" })).toBe("payment_details")
  })

  test("ordinary fields stay the agent's", () => {
    for (const attrs of [
      { name: "q", type: "search" },
      { name: "email", type: "email", autocomplete: "email" },
      { name: "username", autocomplete: "username" },
      { name: "spinner" },
      { label: "Pinned repositories" },
      { name: "shipping" },
      { type: "checkbox", name: "password_remember" },
    ])
      expect({ attrs, kind: input(attrs) }).toEqual({ attrs, kind: null })
    expect(guard.classify({ tag: "DIV", name: "password" })).toBeNull()
    expect(guard.classify({ tag: "DIV", editable: true, ariaLabel: "Password" })).toBe("credential")
  })

  test("CAPTCHA frames by address", () => {
    expect(guard.captchaUrl("https://www.google.com/recaptcha/api2/anchor?k=x")).toBe(true)
    expect(guard.captchaUrl("https://www.recaptcha.net/recaptcha/api2/bframe")).toBe(true)
    expect(guard.captchaUrl("https://newassets.hcaptcha.com/captcha/v1/x")).toBe(true)
    expect(guard.captchaUrl("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x")).toBe(true)
    expect(guard.captchaUrl("https://www.google.com/maps/embed")).toBe(false)
    expect(guard.captchaUrl("https://example.com/recaptcha-lookalike")).toBe(false)
    expect(guard.captchaUrl("not a url")).toBe(false)
  })
})

describe("the page as the guard sees it", () => {
  const element = (attrs: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    tagName: "INPUT",
    type: attrs.type ?? "",
    id: attrs.id ?? "",
    isContentEditable: false,
    getAttribute: (name: string) => attrs[name] ?? null,
    ...extra,
  })

  test("only the focused field of a frame that has the keyboard counts", () => {
    const password = element({ type: "password" })
    const focused = load({ document: { hasFocus: () => true, activeElement: password } })
    expect(focused.focused()).toEqual({ kind: "credential", here: true })
    const unfocused = load({ document: { hasFocus: () => false, activeElement: password } })
    expect(unfocused.focused()).toEqual({ kind: null })
    const inShadow = load({ document: { hasFocus: () => true, activeElement: { tagName: "X-LOGIN", shadowRoot: { activeElement: password } } } })
    expect(inShadow.focused()).toEqual({ kind: "credential", here: true })
    const nothing = load({ document: { hasFocus: () => true, activeElement: { tagName: "BODY", getAttribute: () => null } } })
    expect(nothing.focused()).toEqual({ kind: null, here: true })
  })

  test("focus in a child frame: looked into when this world can reach it, reported as a child's otherwise", () => {
    const password = element({ type: "password" })
    // A frame of the same process (an about:blank editor, say): its document is read from here.
    const reachable = load({ document: { hasFocus: () => true, activeElement: { tagName: "IFRAME", contentDocument: { activeElement: password } } } })
    expect(reachable.focused()).toEqual({ kind: "credential", here: true })
    // A frame of another process (or one this world may not read): its own guard world answers for it.
    for (const tagName of ["IFRAME", "FRAME", "OBJECT", "EMBED", "FENCEDFRAME"]) {
      const remote = load({ document: { hasFocus: () => true, activeElement: { tagName, contentDocument: null } } })
      expect({ tagName, answer: remote.focused() }).toEqual({ tagName, answer: { kind: null, child: true } })
    }
    const refusing = load({
      document: {
        hasFocus: () => true,
        activeElement: {
          tagName: "IFRAME",
          get contentDocument() {
            throw new Error("blocked")
          },
        },
      },
    })
    expect(refusing.focused()).toEqual({ kind: null, child: true })
  })

  test("the field at a screen point, from the window's position, looking into reachable frames", () => {
    const password = element({ type: "password" })
    const search = element({ name: "q", type: "search" })
    const calls: [string, number, number][] = []
    const inner = {
      elementFromPoint: (x: number, y: number) => {
        calls.push(["inner", x, y])
        return password
      },
    }
    const frame = {
      tagName: "IFRAME",
      contentDocument: inner,
      clientLeft: 2,
      clientTop: 3,
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 300, height: 200 }),
      ownerDocument: { defaultView: { getComputedStyle: () => ({ paddingLeft: "4px", paddingTop: "5px" }) } },
    }
    const window = { screenX: 0, screenY: 0, outerWidth: 1280, innerWidth: 1280, outerHeight: 800, innerHeight: 720, devicePixelRatio: 1 }
    const guard = load({
      ...window,
      document: {
        visibilityState: "visible",
        elementFromPoint: (x: number, y: number) => {
          calls.push(["top", x, y])
          return x >= 100 && x < 400 && y >= 50 && y < 250 ? frame : search
        },
      },
    })
    // The page's content starts 80 pixels down the screen (its toolbar).
    expect(guard.pointed(10, 100)).toEqual({ kind: null, here: true })
    expect(calls.at(-1)).toEqual(["top", 10, 20])
    expect(guard.pointed(150, 180)).toEqual({ kind: "credential", here: true })
    expect(calls.at(-1)).toEqual(["inner", 150 - 100 - 2 - 4, 100 - 50 - 3 - 5])
    // Off the page (the toolbar), or a hidden page: not this page's field.
    expect(guard.pointed(10, 40)).toEqual({ kind: null })
    const hidden = load({ ...window, document: { visibilityState: "hidden", elementFromPoint: () => password } })
    expect(hidden.pointed(10, 100)).toEqual({ kind: null })
    // A frame of another process: reported as a child's.
    const remote = load({ ...window, document: { visibilityState: "visible", elementFromPoint: () => ({ tagName: "IFRAME", contentDocument: null }) } })
    expect(remote.pointed(10, 100)).toEqual({ kind: null, child: true })
  })

  test("whether a frame holds a secret field anywhere, looking through open shadow roots", () => {
    const of = (elements: unknown[]) => ({ querySelectorAll: (selector: string) => (selector === "*" ? elements : []) })
    const box = (extra: Record<string, unknown>) => ({ tagName: "DIV", getAttribute: () => null, hasAttribute: () => false, ...extra })
    const field = (attrs: Record<string, string>) => element(attrs, { hasAttribute: (name: string) => name in attrs })
    expect(load({ document: of([box({}), field({ name: "q" })]) }).secrets()).toEqual({ kind: null })
    expect(load({ document: of([field({ autocomplete: "cc-number" })]) }).secrets()).toEqual({ kind: "payment_details" })
    const shadow = of([field({ type: "password" })])
    expect(load({ document: of([box({ shadowRoot: shadow })]) }).secrets()).toEqual({ kind: "credential" })
    // Too large a document to read through counts as holding one.
    expect(load({ document: of(new Array(50_001).fill(box({}))) }).secrets()).toEqual({ kind: "credential" })
  })

  test("a second copy of the script keeps the first", () => {
    const context: Record<string, unknown> = { URL }
    context.globalThis = context
    runInNewContext(source, context)
    const first = context.__vectorGuard
    runInNewContext(source, context)
    expect(context.__vectorGuard).toBe(first)
  })

  test("CAPTCHAs are placed on the screen with a margin, from the window's position", () => {
    const frame = { src: "https://www.google.com/recaptcha/api2/bframe", getBoundingClientRect: () => ({ left: 100, top: 50, width: 300, height: 400 }) }
    const guard = load({
      document: {
        visibilityState: "visible",
        querySelectorAll: (selector: string) => (selector.startsWith("iframe") ? [frame] : []),
      },
      screenX: 0,
      screenY: 0,
      outerWidth: 1280,
      innerWidth: 1280,
      outerHeight: 800,
      innerHeight: 720,
      devicePixelRatio: 1,
      location: { href: "https://shop.example/checkout" },
    })
    expect(guard.captchas()).toEqual([{ x: 84, y: 114, w: 332, h: 432 }])
    const hidden = load({ document: { visibilityState: "hidden", querySelectorAll: () => [frame] } })
    expect(hidden.captchas()).toEqual([])
  })

  test("the guard is frozen: a page script in the same world could not swap its answers", () => {
    const guard = load()
    expect(Object.isFrozen(guard)).toBe(true)
  })
})
