import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { resolveTemplate } from "@solid-primitives/i18n"
import { Hands } from "@vectordevai/schema/hands"
import { PublicSession } from "@vectordevai/schema/public-session"
import type { JSX } from "solid-js"
import { dict } from "../i18n/en"
import type { DialogShareSession } from "./dialog-share-session"

// Bun does not run Vite's Solid JSX transform. Compile the real dialog, checkbox and button with the installed preset,
// then let Bun strip TypeScript. Only app contexts, the dialog frame and an unrelated Local notice are replaced; the
// share logic, its checkboxes and buttons are the real components.
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

let Share: typeof DialogShareSession
let client: ReturnType<typeof fakeClient>
const cleanups: (() => void)[] = []

beforeAll(async () => {
  Bun.plugin({
    name: "share dialog Solid DOM fixture",
    setup(build) {
      build.onLoad({ filter: /(?:dialog-share-session|checkbox|button|icon)\.tsx$/ }, async (args) => ({
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
  mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ client }) }))
  mock.module("@/context/platform", () => ({ usePlatform: () => ({}) }))
  mock.module("@vectordevai/ui/context/dialog", () => ({ useDialog: () => ({ close: () => undefined }) }))
  // Kobalte's modal Dialog root (focus trap, presence, scroll lock) is not part of the share logic under test.
  mock.module("@vectordevai/ui/dialog", () => ({
    Dialog: (props: { children?: JSX.Element }) => {
      const frame = document.createElement("div")
      frame.setAttribute("role", "dialog")
      web.insert(frame, () => props.children)
      return frame
    },
  }))
  mock.module("@/features/local/off-in-local", () => ({ OffInLocal: () => null }))
  Share = (await import("./dialog-share-session")).DialogShareSession
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})
afterAll(() => {
  Bun.plugin.clearAll()
  mock.restore()
})

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
function archive(screenshots?: string, tool = "computer"): PublicSession.Archive {
  return {
    version: 1,
    engine: "v2",
    title: "Hands transcript",
    messages: [
      { id: "user", role: "user", createdAt: 1, parts: [{ type: "text", text: "Summarize the meeting" }] },
      {
        id: "assistant",
        role: "assistant",
        createdAt: 2,
        parts: [
          {
            type: "tool",
            name: tool,
            callID: "call",
            status: "completed",
            input: '{"action":"read_ui"}',
            output: "Notes is open",
            ...(screenshots
              ? { screenshots: [{ name: "screen.png", mediaType: "image/png" as const, url: screenshots }] }
              : {}),
          },
        ],
      },
    ],
  }
}
const hash = (value: PublicSession.Archive) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const info: PublicSession.Info = {
  id: "a".repeat(32),
  url: `https://vectordev.ai/s/${"a".repeat(32)}`,
  expiresAt: Date.now() + 86_400_000,
  updatedAt: Date.now(),
  revision: 0,
  updates: false,
}

// The fake engine answers each preview only when the test releases it, so request order and overlap are explicit.
function fakeClient(answer: (includeScreenshots: boolean) => PublicSession.Archive | Promise<PublicSession.Archive>) {
  const previews: { input: { sessionID: string; includeScreenshots?: string }; release: () => void }[] = []
  const shares: { sessionID: string; publicSessionPublish: Record<string, unknown> }[] = []
  return {
    previews,
    shares,
    unshares: 0,
    session: {
      sharePreview(input: { sessionID: string; includeScreenshots?: string }) {
        const pending = Promise.withResolvers<{ data: PublicSession.Archive }>()
        previews.push({
          input,
          release: () =>
            pending.resolve(Promise.resolve(answer(input.includeScreenshots === "true")).then((data) => ({ data }))),
        })
        return pending.promise
      },
      get: async () => ({ data: { id: "session" } }),
      async share(input: { sessionID: string; publicSessionPublish: Record<string, unknown> }) {
        shares.push(input)
        return { data: info }
      },
      unshare: async () => {
        client.unshares++
        return { data: true }
      },
    },
  }
}

function mount(
  answer = (includeScreenshots: boolean): PublicSession.Archive | Promise<PublicSession.Archive> =>
    archive(includeScreenshots ? png : undefined),
) {
  client = fakeClient(answer)
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => solid.createComponent(Share, { sessionID: "session" }), host))
  const checkbox = (label: string) =>
    [...host.querySelectorAll('[data-component="checkbox"]')]
      .find((element) => element.querySelector('[data-slot="checkbox-checkbox-label"]')?.textContent === label)
      ?.querySelector("input") ?? undefined
  return {
    host,
    checkbox,
    screenshots: () => checkbox(t("computer.share.includeScreenshots")),
    reviewed: () => checkbox("I have reviewed the included content and want to make it public")!,
    button: (label: string) => [...host.querySelectorAll("button")].find((button) => button.textContent === label)!,
    review: () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Included transcript"]')?.value ?? "",
  }
}

// Answers the newest preview and waits for the dialog to finish checking it.
async function answer(view: ReturnType<typeof mount>) {
  client.previews.at(-1)!.release()
  await until(() => !view.host.textContent?.includes("Preparing the full visible transcript…"))
}

async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 200 && !done(); attempt++) await new Promise((resolve) => setTimeout(resolve, 1))
  expect(done()).toBe(true)
}

async function publish(view: ReturnType<typeof mount>) {
  view.reviewed().click()
  expect(view.button("Publish public copy").disabled).toBe(false)
  view.button("Publish public copy").click()
  await until(() => client.shares.length > 0 && !!view.host.querySelector("[data-public-share-url]"))
  return client.shares.at(-1)!.publicSessionPublish
}

describe("share dialog screenshot opt-in", () => {
  test("is off by default with the Hands help text, and an untouched publication sends no screenshots", async () => {
    const view = mount()
    await answer(view)
    expect(client.previews.map((preview) => preview.input)).toEqual([{ sessionID: "session" }])
    expect(view.screenshots()?.checked).toBe(false)
    const help = view.host.querySelector('[data-slot="checkbox-checkbox-description"]')?.textContent
    expect(help).toBe(t("computer.share.help", { name: Hands.NAME }))
    expect(help).toContain(Hands.NAME)
    expect(view.review()).not.toContain("Screenshot:")
    const request = await publish(view)
    expect(request).toMatchObject({ includeScreenshots: false, remember: false, previewHash: hash(archive()) })
  })

  test("ticking reloads the review with screenshots, requires a new acknowledgement and publishes that review", async () => {
    const view = mount()
    await answer(view)
    view.reviewed().click()
    expect(view.reviewed().checked).toBe(true)
    view.screenshots()!.click()
    expect(client.previews.at(-1)?.input).toEqual({ sessionID: "session", includeScreenshots: "true" })
    expect(view.reviewed().checked).toBe(false)
    expect(view.button("Publish public copy").disabled).toBe(true)
    await answer(view)
    expect(view.screenshots()?.checked).toBe(true)
    expect(view.reviewed().checked).toBe(false)
    expect(view.button("Publish public copy").disabled).toBe(true)
    expect(view.review()).toContain("Screenshot: screen.png (image/png)")
    expect(view.host.textContent).toContain(t("computer.share.description"))

    view.screenshots()!.click()
    expect(client.previews.at(-1)?.input).toEqual({ sessionID: "session" })
    await answer(view)
    expect(view.review()).not.toContain("Screenshot:")
    view.screenshots()!.click()
    await answer(view)
    const request = await publish(view)
    expect(request).toMatchObject({ includeScreenshots: true, previewHash: hash(archive(png)) })
    expect(client.previews.map((preview) => preview.input.includeScreenshots)).toEqual([
      undefined,
      "true",
      undefined,
      "true",
    ])
  })

  test("the choice and refresh stay locked until the newest review and its hash are stored", async () => {
    const view = mount()
    expect(view.host.textContent).toContain("Preparing the full visible transcript…")
    await answer(view)
    view.screenshots()!.click()
    expect(view.screenshots()?.disabled).toBe(true)
    expect(view.button("Refresh included transcript").disabled).toBe(true)
    view.screenshots()!.click()
    view.button("Refresh included transcript").click()
    expect(client.previews).toHaveLength(2)
    // The preview has arrived but its hash is still being computed: the review is not usable yet.
    client.previews.at(-1)!.release()
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
    expect(view.screenshots()?.disabled).toBe(true)
    expect(view.reviewed().disabled).toBe(true)
    view.screenshots()!.click()
    expect(client.previews).toHaveLength(2)
    await until(() => view.screenshots()?.disabled === false)
    expect(view.screenshots()?.checked).toBe(true)
    expect(await publish(view)).toMatchObject({ includeScreenshots: true, previewHash: hash(archive(png)) })
  })

  test("automatic sharing consent says auto-shares never include screenshots and carries only this choice", async () => {
    const view = mount()
    await answer(view)
    expect(view.host.textContent).not.toContain(t("computer.share.automatic"))
    view.checkbox("Include future updates to this conversation until expiry")!.click()
    view.checkbox("Also allow automatic public sharing of future sessions on this Vector account")!.click()
    expect(view.host.textContent).toContain(t("computer.share.automatic"))
    expect(await publish(view)).toMatchObject({
      consent: { version: 1, public: true, updates: true },
      remember: true,
      includeScreenshots: false,
    })
  })

  test("a transcript without completed Hands steps shows no screenshot choice", async () => {
    const view = mount(() => archive(undefined, "shell"))
    await answer(view)
    expect(view.screenshots()).toBeUndefined()
    expect(view.host.textContent).not.toContain(Hands.NAME)
    expect(await publish(view)).toMatchObject({ includeScreenshots: false })
  })

  test("an opted-in review over the public size limit cannot publish until the box is unticked", async () => {
    const base = JSON.stringify(archive("data:image/png;base64,A")).length
    const sized = (bytes: number) => `data:image/png;base64,${"A".repeat(bytes - base + 1)}`
    for (const [bytes, blocked] of [
      [PublicSession.MAX_BYTES + 1, true],
      [PublicSession.MAX_BYTES, false],
    ] as const) {
      const large = archive(sized(bytes))
      expect(JSON.stringify(large).length).toBe(bytes)
      const view = mount((includeScreenshots) => (includeScreenshots ? large : archive()))
      await answer(view)
      view.screenshots()!.click()
      await answer(view)
      const alert = [...view.host.querySelectorAll('[role="alert"]')].map((element) => element.textContent).join("")
      expect(alert.includes("larger than 4 MB")).toBe(blocked)
      expect(view.reviewed().disabled).toBe(blocked)
      if (!blocked) {
        expect(await publish(view)).toMatchObject({ includeScreenshots: true, previewHash: hash(large) })
        continue
      }
      view.reviewed().click()
      expect(view.reviewed().checked).toBe(false)
      expect(view.button("Publish public copy").disabled).toBe(true)
      view.screenshots()!.click()
      await answer(view)
      expect(view.host.querySelector('[role="alert"]')).toBeNull()
      expect(await publish(view)).toMatchObject({ includeScreenshots: false, previewHash: hash(archive()) })
    }
  })

  test("an opted-in review the engine refuses as too large asks to untick instead of showing an error", async () => {
    // The engine's error body, as the generated client throws it.
    const refusal = {
      _tag: "PublicSessionError",
      code: "TOO_LARGE",
      message: "This conversation is too large to share. Export a local JSON file instead.",
    }
    const view = mount((includeScreenshots) => (includeScreenshots ? Promise.reject(refusal) : archive()))
    await answer(view)
    view.screenshots()!.click()
    await answer(view)
    const alert = () => [...view.host.querySelectorAll('[role="alert"]')].map((element) => element.textContent).join("")
    expect(alert()).toContain("larger than 4 MB")
    expect(alert()).not.toContain(refusal.message)
    expect(view.screenshots()?.checked).toBe(true)
    expect(view.screenshots()?.disabled).toBe(false)
    expect(view.reviewed().disabled).toBe(true)
    expect(view.button("Publish public copy").disabled).toBe(true)
    view.screenshots()!.click()
    await answer(view)
    expect(alert()).toBe("")
    expect(await publish(view)).toMatchObject({ includeScreenshots: false, previewHash: hash(archive()) })
  })

  test("when the text alone is over the limit, an opted-in refusal keeps the engine's message, not the untick advice", async () => {
    const refusal = {
      _tag: "PublicSessionError",
      code: "TOO_LARGE",
      message: "This conversation is too large to share. Export a local JSON file instead.",
    }
    const oversized = (screenshots?: string): PublicSession.Archive => {
      const base = archive(screenshots)
      // Each text part may hold up to 2,000,000 characters; three of them pass the archive limit.
      const parts = [1, 2, 3].map(() => ({ type: "text" as const, text: "x".repeat(1_500_000) }))
      return { ...base, messages: [...base.messages, { id: "long", role: "assistant", createdAt: 3, parts }] }
    }
    // The current engine refuses the opted-in review and the dialog shows its message. An engine without that check
    // returns the review over the limit; publication then fails with the same message, as it would without screenshots.
    for (const [opted, refused] of [
      [() => Promise.reject(refusal), true],
      [() => oversized(png), false],
    ] as const) {
      const view = mount((includeScreenshots) => (includeScreenshots ? opted() : oversized()))
      await answer(view)
      view.screenshots()!.click()
      await answer(view)
      const alert = [...view.host.querySelectorAll('[role="alert"]')].map((element) => element.textContent).join("")
      expect(alert).not.toContain("larger than 4 MB")
      expect(alert).toBe(refused ? refusal.message : "")
      expect(view.reviewed().disabled).toBe(refused)
    }
  })

  test("unsharing an opted-in copy starts the next publication unticked with a screenshot-free review", async () => {
    const view = mount()
    await answer(view)
    view.screenshots()!.click()
    await answer(view)
    await publish(view)
    view.checkbox("Remove this public copy")!.click()
    view.button("Unshare").click()
    await until(() => client.unshares === 1 && client.previews.length === 3)
    expect(client.previews.at(-1)?.input).toEqual({ sessionID: "session" })
    await answer(view)
    expect(view.screenshots()?.checked).toBe(false)
    expect(view.review()).not.toContain("Screenshot:")
    expect(await publish(view)).toMatchObject({ includeScreenshots: false, previewHash: hash(archive()) })
  })
})
