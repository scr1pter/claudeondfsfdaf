import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { resolveTemplate } from "@solid-primitives/i18n"
import { Hands } from "@vectordevai/schema/hands"
import type { JSX } from "solid-js"
import { dict } from "../i18n/en"
import { ServerScope } from "../utils/server-scope"
import type { DialogSelectPlugins } from "./dialog-select-plugins"

// Bun does not run Vite's Solid JSX transform. Compile the real dialog and catalog with the installed preset, as the
// share dialog's test does. Only app contexts, the dialog frame and the switch are replaced; the dismissal is stored
// through the real `persisted`, on a desktop-shaped storage whose reads answer only when the test releases them, as
// the desktop's IPC store does.
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

const noticeKey = "vector.global.dat:plugins.computer-use-notice"
const notice = t("computer.community.installed", { name: Hands.NAME })

let Plugins: typeof DialogSelectPlugins
let desktop: ReturnType<typeof desktopStorage>
const cleanups: (() => void)[] = []

beforeAll(async () => {
  Bun.plugin({
    name: "plugins dialog Solid DOM fixture",
    setup(build) {
      // Windows paths use backslashes, so the catalog's directory separator matches either one.
      build.onLoad({ filter: /(?:dialog-select-plugins|plugins[\\/]catalog)\.tsx$/ }, async (args) => ({
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
  // A supported desktop on its built-in engine, so the row reads as Hands' and an installed copy has a notice.
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "desktop", storage: desktop.storage, computer: { supported: true } }),
  }))
  mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: ServerScope.local }) }))
  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { config: {}, mcp: { "computer-use": { status: "connected" } } },
      mcp: { refresh: async () => undefined },
    }),
  }))
  mock.module("@/context/mcp", () => ({
    useMcpAdd: () => ({ isPending: false, mutateAsync: async () => undefined }),
    useMcpToggle: () => ({ isPending: false, mutate: () => undefined }),
    useMcpRemove: () => ({ isPending: false, mutate: () => undefined }),
  }))
  // Kobalte's modal Dialog root and switch are not part of the notice under test.
  mock.module("@vectordevai/ui/dialog", () => ({
    Dialog: (props: { children?: JSX.Element }) => {
      const frame = document.createElement("div")
      frame.setAttribute("role", "dialog")
      web.insert(frame, () => props.children)
      return frame
    },
  }))
  mock.module("@vectordevai/ui/switch", () => ({ Switch: () => null }))
  Plugins = (await import("./dialog-select-plugins")).DialogSelectPlugins
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})
afterAll(() => {
  Bun.plugin.clearAll()
  mock.restore()
})

// Values are kept by storage name and key, as the desktop keeps one store per name.
function desktopStorage(saved: Record<string, string>) {
  const values = new Map(Object.entries(saved))
  const loaded = Promise.withResolvers<void>()
  return {
    values,
    release: () => loaded.resolve(),
    storage: (name = "default") => ({
      getItem: async (key: string) => {
        await loaded.promise
        return values.get(`${name}:${key}`) ?? null
      },
      setItem: async (key: string, value: string) => {
        values.set(`${name}:${key}`, value)
      },
      removeItem: async (key: string) => {
        values.delete(`${name}:${key}`)
      },
    }),
  }
}

function mount(saved: Record<string, string>) {
  desktop = desktopStorage(saved)
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => solid.createComponent(Plugins, {}), host))
  const row = () => host.querySelector('[data-plugin="computer-use"]')
  return { row, notice: () => row()?.querySelector("[data-computer-notice]") ?? null }
}

async function settle() {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 1))
}

async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 200 && !done(); attempt++) await new Promise((resolve) => setTimeout(resolve, 1))
  expect(done()).toBe(true)
}

describe("plugins dialog community notice on the desktop's asynchronous storage", () => {
  test("a dismissed notice stays hidden while the stored dismissal loads, and after", async () => {
    const view = mount({ [noticeKey]: JSON.stringify({ dismissed: true }) })
    // Until the read answers, the store holds its default `dismissed: false`.
    await settle()
    expect(view.row()?.textContent).toContain(
      t("computer.community.description", { name: Hands.NAME, mention: Hands.MENTION }),
    )
    expect(view.notice()).toBeNull()
    desktop.release()
    await settle()
    expect(view.row()).not.toBeNull()
    expect(view.notice()).toBeNull()
  })

  test("with no stored dismissal the notice waits for the read, then shows until Dismiss, which is stored", async () => {
    const view = mount({})
    await settle()
    expect(view.row()).not.toBeNull()
    expect(view.notice()).toBeNull()
    desktop.release()
    await until(() => view.notice()?.textContent?.includes(notice) === true)
    const dismiss = [...view.notice()!.querySelectorAll("button")].find((button) => button.textContent === "Dismiss")
    dismiss!.click()
    expect(view.notice()).toBeNull()
    await until(() => desktop.values.get(noticeKey) === JSON.stringify({ dismissed: true }))
  })
})
