import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { runInNewContext } from "node:vm"

// WP A54: the credential guard runs in an isolated world of every frame of the computer's browser and tells hostd when
// the focused field takes a password, a one-time code or card details, and where CAPTCHAs are. It reads; it never
// changes the page.

const source = readFileSync(path.join(import.meta.dir, "..", "image", "credential-guard.js"), "utf8")

type Guard = {
  classify(field: Record<string, unknown>): string | null
  captchaUrl(src: string): boolean
  focused(): { kind: string | null }
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
    expect(focused.focused()).toEqual({ kind: "credential" })
    const unfocused = load({ document: { hasFocus: () => false, activeElement: password } })
    expect(unfocused.focused()).toEqual({ kind: null })
    const inShadow = load({ document: { hasFocus: () => true, activeElement: { tagName: "X-LOGIN", shadowRoot: { activeElement: password } } } })
    expect(inShadow.focused()).toEqual({ kind: "credential" })
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
