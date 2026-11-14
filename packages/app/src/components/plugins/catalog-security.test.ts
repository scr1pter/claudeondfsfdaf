import { describe, expect, test } from "bun:test"
import type { McpLocalConfig } from "@vectordevai/sdk/v2/client"
import {
  assertPluginInstallable,
  isPinnedPluginCommand,
  isSecurePluginRemoteUrl,
  PLUGIN_CATALOG,
  type PluginDef,
} from "./catalog"
import { securePluginConfig } from "./secure-config"

// A distinct value per field, so a credential can never collide with part of
// the command when securePluginConfig swaps it for a vault reference.
function sampleValues(plugin: PluginDef) {
  if (plugin.auth.kind !== "token") return {}
  return Object.fromEntries(plugin.auth.fields.map((field) => [field.key, `sample-${field.key}-value`]))
}

function installable(config: Parameters<typeof assertPluginInstallable>[0]) {
  try {
    assertPluginInstallable(config)
    return true
  } catch {
    return false
  }
}

describe("plugin supply-chain policy", () => {
  test("accepts immutable package versions and rejects latest or unversioned commands", () => {
    expect(isPinnedPluginCommand(["npx", "-y", "@vendor/plugin@1.2.3"])).toBe(true)
    expect(isPinnedPluginCommand(["uvx", "vendor-plugin@1.2.3"])).toBe(true)
    expect(isPinnedPluginCommand(["docker", "run", "vendor/plugin@sha256:" + "a".repeat(64)])).toBe(true)
    expect(isPinnedPluginCommand(["npx", "-y", "@vendor/plugin@latest"])).toBe(false)
    expect(isPinnedPluginCommand(["npx", "-y", "@vendor/plugin"])).toBe(false)
    expect(isPinnedPluginCommand(["npx", "-y", "mutable-plugin", "pinned-decoy@1.2.3"])).toBe(false)
    expect(isPinnedPluginCommand(["uvx", "vendor-plugin"])).toBe(false)
  })

  test("blocks an unpinned local install before returning executable config", () => {
    const config: McpLocalConfig = {
      type: "local",
      command: ["npx", "-y", "@vendor/plugin@latest"],
      environment: { VENDOR_TOKEN: "secret" },
      enabled: true,
    }
    expect(() => assertPluginInstallable(config)).toThrow("not pinned")
    expect(() => assertPluginInstallable({ ...config, command: ["npx", "-y", "@vendor/plugin"] })).toThrow("not pinned")
    expect(() => assertPluginInstallable({ ...config, command: ["uvx", "vendor-plugin"] })).toThrow("not pinned")
    expect(() => assertPluginInstallable({ ...config, command: ["docker", "run", "-i", "vendor/plugin"] })).toThrow(
      "not pinned",
    )
  })

  test("every local connector that can be installed runs a pinned command", () => {
    const connectors = PLUGIN_CATALOG.filter((plugin) => !plugin.soon && plugin.build).flatMap((plugin) => {
      const config = plugin.build!(sampleValues(plugin))
      return config.type === "local" ? [{ id: plugin.id, plugin, config }] : []
    })
    expect(connectors.length).toBeGreaterThan(0)

    expect(connectors.filter(({ config }) => !isPinnedPluginCommand(config.command)).map(({ id }) => id)).toEqual([])
    expect(connectors.filter(({ config }) => !installable(config)).map(({ id }) => id)).toEqual([])
    // The install path checks the config after credentials move into the vault.
    expect(
      connectors
        .filter(({ plugin }) => {
          const prepared = securePluginConfig(plugin, sampleValues(plugin))
          return !prepared || !installable(prepared.config)
        })
        .map(({ id }) => id),
    ).toEqual([])
  })

  test("every uvx connector that can be installed names a Python new enough for it", () => {
    // uvx otherwise resolves against the first Python it finds, and macOS ships 3.9, older than these servers need.
    const unpinned = PLUGIN_CATALOG.filter((plugin) => !plugin.soon && plugin.build).flatMap((plugin) => {
      const config = plugin.build!(sampleValues(plugin))
      if (config.type !== "local" || config.command[0] !== "uvx") return []
      const python = config.command.indexOf("--python")
      return python === 1 && config.command[2] === "3.12" ? [] : [plugin.id]
    })
    expect(unpinned).toEqual([])
  })

  test("starts the Supabase server read-only", () => {
    const config = PLUGIN_CATALOG.find((item) => item.id === "supabase")?.build?.({ SUPABASE_ACCESS_TOKEN: "sbp_test" })
    expect(config?.type === "local" ? config.command : []).toContain("--read-only")
  })

  test("allows only credential-free HTTPS remote plugin endpoints", () => {
    expect(isSecurePluginRemoteUrl("https://mcp.example.test/path")).toBe(true)
    expect(isSecurePluginRemoteUrl("http://mcp.example.test/path")).toBe(false)
    expect(isSecurePluginRemoteUrl("https://user:secret@mcp.example.test/path")).toBe(false)
    expect(isSecurePluginRemoteUrl("https://mcp.example.test/path?token=secret")).toBe(false)
    expect(isSecurePluginRemoteUrl("javascript:alert(1)")).toBe(false)
  })
})
