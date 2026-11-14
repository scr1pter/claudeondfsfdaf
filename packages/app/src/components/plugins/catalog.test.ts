import { describe, expect, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import { Hands } from "@vectordevai/schema/hands"
import type { ComputerConfig } from "@vectordevai/sdk/v2/client"
import { dict } from "@/i18n/en"
import { isPinnedPluginCommand, PLUGIN_CATALOG, pluginCopy, visiblePlugins } from "./catalog"

const t = (key: "computer.community.description" | "computer.community.installed", params: Record<string, string>) =>
  resolveTemplate(dict[key], params)

const community = PLUGIN_CATALOG.find((plugin) => plugin.id === "computer-use")!
const others = PLUGIN_CATALOG.filter((plugin) => plugin !== community)
const ids = (plugins: readonly { id: string }[]) => plugins.map((plugin) => plugin.id)

const handsBlurb = `Third-party desktop control without ${Hands.NAME}' per-app asks, glow or stop key. Prefer @${Hands.MENTION}.`
const handsNotice = `${Hands.NAME} now does this with per-app asks and a stop key. This plugin can give Vector itself screen access; consider removing it.`

describe("community computer-control entry", () => {
  test("is renamed with the Hands blurb, keeping its id, logo, badge and pinned command", () => {
    expect(community.name).toBe("Computer Control (community MCP)")
    expect(pluginCopy(community, { installed: false, hands: true, dismissed: false, t }).blurb).toBe(handsBlurb)
    expect(community.logo).toBe("computeruse")
    expect(community.badge).toBe("community")
    expect(community.category).toBe("Design & browser")
    expect(community.auth).toEqual({ kind: "none" })
    const config = community.build?.({})
    expect(config?.type === "local" ? config.command : undefined).toEqual([
      "uvx",
      "--python",
      "3.12",
      "computer-control-mcp@0.3.14",
    ])
    expect(isPinnedPluginCommand(config?.type === "local" ? config.command : [])).toBe(true)
    expect(PLUGIN_CATALOG.filter((plugin) => (plugin.server ?? plugin.id) === "computer-use")).toEqual([community])
  })

  test("computer-use entry is hidden when policy restricts Vector Hands", () => {
    const restricting: ComputerConfig[] = [
      { enabled: false },
      { default_app_access: "deny" },
      { apps: { macos: { "com.apple.Notes": "allow" } } },
      { apps: { macos: { "com.acme.ledger@ABCDE12345": "deny" } } },
      { apps: { windows: [{ aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", access: "allow" }] } },
      { apps: { windows: [{ publisher: "Acme", product: "Ledger", access: "deny" }] } },
      {
        enabled: true,
        default_app_access: "ask",
        apps: { macos: {}, windows: [{ aumid: "Acme.Ledger!App", access: "deny" }] },
      },
    ]
    for (const config of restricting) {
      const visible = visiblePlugins(config)
      expect(ids(visible)).toEqual(ids(others))
      // The rows that stay are the same objects, so the dialog keeps them mounted when the entry leaves.
      expect(visible.every((plugin) => PLUGIN_CATALOG.includes(plugin))).toBe(true)
    }
  })

  test("absent policy, empty rules and unrelated company settings keep the entry", () => {
    const permissive: (ComputerConfig | undefined)[] = [
      undefined,
      {},
      { apps: {} },
      { apps: { macos: {}, windows: [] } },
      {
        enabled: true,
        default_app_access: "ask",
        allow_always: false,
        background: false,
        keep_awake: false,
        away_minutes: 10,
        screenshot_retention_days: 0,
        max_actions: 1,
        max_minutes: 1,
        native_tools: "off",
        screenshots: { keep: 1, max_width: 800, max_height: 600 },
      },
    ]
    for (const config of permissive) expect(visiblePlugins(config)).toBe(PLUGIN_CATALOG)
  })

  test("without Hands the entry keeps its neutral blurb and shows no notice", () => {
    const copy = pluginCopy(community, { installed: true, hands: false, dismissed: false, t })
    expect(copy).toEqual({ blurb: community.blurb })
    for (const text of [community.name, community.blurb]) {
      expect(text).not.toContain(Hands.NAME)
      expect(text).not.toContain(`@${Hands.MENTION}`)
    }
    expect(community.blurb.startsWith("Third-party desktop control")).toBe(true)
  })

  test("the notice shows only for an installed copy where Hands is available, until it is dismissed", () => {
    expect(pluginCopy(community, { installed: true, hands: true, dismissed: false, t }).notice).toBe(handsNotice)
    expect(pluginCopy(community, { installed: false, hands: true, dismissed: false, t }).notice).toBeUndefined()
    expect(pluginCopy(community, { installed: true, hands: true, dismissed: true, t }).notice).toBeUndefined()
    // The stored dismissal has not loaded yet: a notice dismissed earlier must not show meanwhile.
    expect(pluginCopy(community, { installed: true, hands: true, dismissed: undefined, t }).notice).toBeUndefined()
    expect(pluginCopy(community, { installed: true, hands: true, dismissed: true, t }).blurb).toBe(handsBlurb)
  })

  test("other entries keep their own text and never get a notice", () => {
    for (const plugin of others) {
      expect(pluginCopy(plugin, { installed: true, hands: true, dismissed: false, t })).toEqual({ blurb: plugin.blurb })
    }
  })
})
