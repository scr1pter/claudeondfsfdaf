import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { JSX } from "solid-js"
import type { VaultPlatform, VaultRestoreResult, VaultStatus, VaultVersions } from "@/context/platform"
import type { SettingsMemoryBackup } from "./memory-backup"
import { STARTING_COPY } from "./memory-backup-model"

// Settings → Memory → Backup (WP A45, R45b) on happy-dom: the real page, compiled with the installed Solid preset as
// the plugins dialog's test does. Only the platform, the button and the switch are replaced. The button calls onClick
// on every click and ignores `disabled`, so the page's own busy guard is what keeps a restore from going twice. This
// is not browser acceptance; that stays B10's.
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

const VERSION = "v1762225200000-0123abcd"
const NOW = Date.UTC(2026, 10, 4, 3)
const STILL_STARTING =
  "Error invoking remote method 'vault-restore': Error: Vector is still starting. Try again in a moment."
const FIGURE = /\$|€|£|credit|token|price|cost/i

const contexts: { platform?: object } = {}
const storage: unknown[][] = []
let Backup: typeof SettingsMemoryBackup
const cleanups: (() => void)[] = []

beforeAll(async () => {
  Bun.plugin({
    name: "memory backup Solid DOM fixture",
    setup(build) {
      build.onLoad({ filter: /[\\/]memory-backup\.tsx$/ }, async (args) => ({
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
  mock.module("@/context/platform", () => ({ usePlatform: () => contexts.platform }))
  mock.module("@vectordevai/ui/v2/button-v2", () => ({
    ButtonV2: (props: { disabled?: boolean; onClick?: () => void; children?: JSX.Element }) => {
      const button = document.createElement("button")
      button.type = "button"
      solid.createRenderEffect(() => button.toggleAttribute("data-disabled", Boolean(props.disabled)))
      button.addEventListener("click", () => props.onClick?.())
      web.insert(button, () => props.children)
      return button
    },
  }))
  mock.module("@vectordevai/ui/v2/switch-v2", () => ({ Switch: () => null }))
  Backup = (await import("./memory-backup")).SettingsMemoryBackup
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  storage.length = 0
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})
afterAll(() => {
  Bun.plugin.clearAll()
  mock.restore()
})

const vault = (fields: Partial<VaultStatus> = {}): VaultStatus => ({
  secure: true,
  enabled: false,
  backend: "github",
  hasVault: false,
  ...fields,
})
const REAL = vault({ enabled: true, githubRepo: "octo/brain-vault", hasVault: true })
const listing = (fields: Partial<Extract<VaultVersions, { ok: true }>> = {}): VaultVersions => ({
  ok: true,
  label: "your GitHub repository octo/brain-vault",
  snapshots: [{ id: VERSION, createdAt: NOW, bytes: 1_200 }],
  mine: true,
  status: REAL,
  ...fields,
})
const plan = (fields: Partial<ModelPlanStatus.Status>) =>
  ({
    signedIn: true,
    enabled: true,
    access: true,
    purchased: { bought: false },
    empty: false,
    low: false,
    ...fields,
  }) as ModelPlanStatus.Status

type Answers = { [K in Exclude<keyof VaultPlatform, "onChange">]?: VaultPlatform[K] }

/** A desktop vault bridge that records every call and answers with what the test gives it. */
function mount(answers: Answers, codium?: ModelPlanStatus.Status) {
  const calls: unknown[][] = []
  const listeners = new Set<(status: VaultStatus) => void>()
  const call =
    (name: keyof Answers) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
      const answer = answers[name] as ((...args: unknown[]) => Promise<unknown>) | undefined
      return answer ? answer(...args) : Promise.reject(new Error(`unexpected ${name}`))
    }
  const bridge = {
    status: call("status"),
    configure: call("configure"),
    backup: call("backup"),
    versions: call("versions"),
    restore: call("restore"),
    forget: call("forget"),
    remove: call("remove"),
    onChange: (callback: (status: VaultStatus) => void) => {
      listeners.add(callback)
      return () => void listeners.delete(callback)
    },
  }
  contexts.platform = {
    platform: "desktop",
    vault: bridge,
    vectorAccount: { codium: async () => codium ?? plan({ listed: [] }) },
    storage: (...args: unknown[]) => {
      storage.push(args)
      return { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
    },
  }
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => solid.createComponent(Backup, {}), host))
  return {
    host,
    calls: (name: string) => calls.filter((entry) => entry[0] === name),
    emit: (status: VaultStatus) => listeners.forEach((listener) => listener(status)),
    button: (text: string) =>
      [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === text),
    tabs: () => [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim()),
    repository: () => host.querySelector<HTMLInputElement>('input[aria-label="Private GitHub repository for backups"]'),
  }
}

async function settle() {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 1))
}

async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 200 && !done(); attempt++) await new Promise((resolve) => setTimeout(resolve, 1))
  expect(done()).toBe(true)
}

describe("Settings → Memory → Backup", () => {
  test("a restore is sent once however fast it is pressed; a failure frees the page and shows plain copy", async () => {
    const pending = Promise.withResolvers<VaultRestoreResult>()
    let restores = 0
    const page = mount({
      status: async () => REAL,
      versions: async () => listing(),
      restore: () => (++restores === 1 ? pending.promise : Promise.reject(new Error(STILL_STARTING))),
    })
    await until(() => Boolean(page.button("Show versions")))
    page.button("Show versions")!.click()
    await until(() => Boolean(page.button("Restore")))
    page.button("Restore")!.click()
    page.button("Restore")!.click()
    await settle()
    expect(page.calls("restore")).toEqual([["restore", { version: VERSION }]])
    expect(page.button("Restore")!.hasAttribute("data-disabled")).toBe(true)

    // A thrown IPC call carries Electron's own text, never copy written for the person (R45-24).
    pending.reject(new Error(STILL_STARTING))
    await until(() => Boolean(page.host.querySelector('[role="alert"]')))
    expect(page.host.querySelector('[role="alert"]')!.textContent?.trim()).toBe("Vector could not do that. Try again.")
    expect(page.host.textContent).not.toContain("Error invoking")
    expect(page.button("Restore")!.hasAttribute("data-disabled")).toBe(false)
    page.button("Restore")!.click()
    await settle()
    expect(page.calls("restore")).toHaveLength(2)
  })

  test("the recovery code shows once and reaches no storage", async () => {
    const code = "VVR1-ABCD-EFGH-JKLM-NPQR-STUV"
    const page = mount({
      status: async () => vault({ githubRepo: "octo/brain-vault" }),
      backup: async () => ({ ok: true, message: "Backed up.", status: REAL, code }),
      versions: async () => listing({ mine: false }),
      restore: async () => ({ ok: true, message: "Restored.", status: REAL }),
    })
    await until(() => Boolean(page.button("Back up now")))
    page.button("Back up now")!.click()
    await until(() => Boolean(page.host.querySelector('[data-component="settings-memory-backup-code"]')))
    expect(page.host.querySelector('[data-component="settings-memory-backup-code"]')!.textContent).toContain(code)
    page.button("I saved it")!.click()
    await settle()
    expect(page.host.textContent).not.toContain(code)

    page.button("Show versions")!.click()
    await until(() => Boolean(page.host.querySelector('input[aria-label="Recovery code"]')))
    const input = page.host.querySelector<HTMLInputElement>('input[aria-label="Recovery code"]')!
    expect(input.type).toBe("password")
    expect(input.getAttribute("autocomplete")).toBe("off")
    input.value = code
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    page.button("Restore")!.click()
    await until(() => page.calls("restore").length === 1 && input.value === "")
    expect(page.calls("restore")).toEqual([["restore", { version: VERSION, code }]])
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(storage).toEqual([])
  })

  test("Brain Vault on Vector shows only for a listed vault with storage; GitHub always", async () => {
    const offered = plan({ listed: ["vault"], entitlements: { vault: { gb: 10, versionDays: 30 } } })
    const unlisted = mount({ status: async () => REAL }, plan({ listed: [], entitlements: { vault: { gb: 10 } } }))
    await until(() => unlisted.tabs().length > 0)
    await settle()
    expect(unlisted.tabs()).toEqual(["Your GitHub repository"])

    const listed = mount(
      {
        status: async () => vault({ backend: "vector", hasVault: true }),
        versions: async () => listing({ usage: { usedBytes: 1_200_000_000, quotaBytes: 10_000_000_000 } }),
      },
      offered,
    )
    await until(() => listed.tabs().length === 2)
    expect(listed.tabs()).toEqual(["Your GitHub repository", "Brain Vault on Vector"])
    await until(() => Boolean(listed.button("Show versions")))
    listed.button("Show versions")!.click()
    await until(() => listed.host.textContent?.includes("Using 1.2 GB of 10.0 GB.") === true)
    expect(listed.host.textContent).not.toMatch(FIGURE)

    // Already the chosen place, so the person can move off it.
    const chosen = mount({ status: async () => vault({ backend: "vector" }) }, plan({ listed: [] }))
    await until(() => chosen.tabs().length === 2)
    expect(chosen.tabs()).toEqual(["Your GitHub repository", "Brain Vault on Vector"])
  })

  test("while Vector starts the page waits for Brain Vault, then shows its real place", async () => {
    const starting = mount({ status: async () => vault({ starting: true }) })
    await until(() => starting.host.textContent?.includes(STARTING_COPY) === true)
    expect(starting.button("Back up now")).toBeUndefined()
    expect(starting.repository()).toBeNull()
    starting.emit(REAL)
    await until(() => Boolean(starting.button("Back up now")))
    expect(starting.repository()!.value).toBe("octo/brain-vault")
    expect(starting.host.querySelector('[data-component="settings-memory-backup-delete"]')).not.toBeNull()
    expect(starting.host.textContent).not.toContain(STARTING_COPY)

    // Brain Vault's first status can arrive before the answer to the page's own read, which still holds the stand-in.
    const late = Promise.withResolvers<VaultStatus>()
    const racing = mount({ status: () => late.promise })
    await settle()
    racing.emit(REAL)
    await until(() => Boolean(racing.button("Back up now")))
    late.resolve(vault({ starting: true }))
    await settle()
    expect(racing.button("Back up now")).not.toBeUndefined()
    expect(racing.repository()!.value).toBe("octo/brain-vault")
    expect(racing.host.querySelector('[data-component="settings-memory-backup-delete"]')).not.toBeNull()
    expect(racing.host.textContent).not.toContain(STARTING_COPY)
  })
})
