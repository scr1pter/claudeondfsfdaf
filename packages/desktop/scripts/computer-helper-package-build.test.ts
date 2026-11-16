import { describe, expect, test } from "bun:test"
import path from "node:path"
import { computerHelperBuildEnvironment, parseComputerHelperHashes } from "./computer-helper-package-build"
import type { ComputerHelperPackageResult } from "./computer-helper-package"

const x64 = "a".repeat(64)
const arm64 = "b".repeat(64)
const result = (windowsHashes: ComputerHelperPackageResult["windowsHashes"]): ComputerHelperPackageResult => ({
  skipped: false,
  manifests: [],
  windowsHashes,
})

describe("desktop Windows helper build pins", () => {
  test("parses only supported SHA-256 maps and normalizes their case", () => {
    expect(parseComputerHelperHashes(undefined)).toEqual({})
    expect(parseComputerHelperHashes(JSON.stringify({ arm64: arm64.toUpperCase(), x64 }))).toEqual({ arm64, x64 })
    for (const invalid of [
      "[]",
      "null",
      "false",
      "{",
      JSON.stringify({ ia32: x64 }),
      JSON.stringify({ x64: "bad" }),
      JSON.stringify({ x64: 1 }),
    ])
      expect(() => parseComputerHelperHashes(invalid)).toThrow("must map x64 or arm64")
  })

  test("embeds the verified final host helper bytes before Vite runs", async () => {
    const calls: unknown[] = []
    const environment = { VECTOR_CHANNEL: "beta", PRESERVED: "fixture", VECTOR_COMPUTER_HELPER_PREBUILT: "false" }
    const prepared = await computerHelperBuildEnvironment(
      { channel: "beta", directory: "/fixture/package", environment },
      {
        platform: "win32",
        architecture: "arm64",
        exists: async (file) => {
          calls.push(file)
          return true
        },
        ensure: async (input) => {
          calls.push(input)
          return result({ arm64 })
        },
      },
    )
    expect(calls).toEqual([
      path.resolve("/fixture/package/native/out/win32/arm64/computer-helper.json"),
      {
        platform: "win32",
        architectures: ["arm64"],
        channel: "beta",
        directory: path.resolve("/fixture/package"),
        environment: { ...environment, VECTOR_COMPUTER_HELPER_PREBUILT: "true" },
      },
    ])
    expect(JSON.parse(prepared.VECTOR_COMPUTER_HELPER_SHA256)).toEqual({ arm64 })
    expect(prepared.PRESERVED).toBe("fixture")
    expect(environment.VECTOR_COMPUTER_HELPER_PREBUILT).toBe("false")
  })

  test("keeps an ordinary build available when the optional native output is absent", async () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      const prepared = await computerHelperBuildEnvironment(
        { channel: "dev", environment: {} },
        {
          platform,
          architecture: "x64",
          exists: async () => false,
          ensure: async () => {
            throw new Error("Native verification must not run without requested outputs")
          },
        },
      )
      expect(prepared.VECTOR_COMPUTER_HELPER_SHA256).toBe("{}")
    }
  })

  test("verifies both explicit cross-package pins without overriding the C2 host", async () => {
    const supplied = JSON.stringify({ arm64, x64 })
    const prepared = await computerHelperBuildEnvironment(
      { channel: "prod", environment: { VECTOR_COMPUTER_HELPER_SHA256: supplied } },
      {
        platform: "linux",
        architecture: "x64",
        exists: async () => true,
        ensure: async (input) => {
          expect(input.architectures).toEqual(["x64", "arm64"])
          expect(input).not.toHaveProperty("host")
          expect(input).not.toHaveProperty("hostArchitecture")
          expect(input.environment.VECTOR_COMPUTER_HELPER_PREBUILT).toBe("true")
          return result({ x64, arm64 })
        },
      },
    )
    expect(JSON.parse(prepared.VECTOR_COMPUTER_HELPER_SHA256)).toEqual({ x64, arm64 })
  })

  test("refuses stale supplied pins, incomplete verification and missing explicit output", async () => {
    const input = { channel: "prod" as const, environment: { VECTOR_COMPUTER_HELPER_SHA256: JSON.stringify({ x64 }) } }
    await expect(
      computerHelperBuildEnvironment(input, {
        platform: "win32",
        exists: async () => true,
        ensure: async () => result({ x64: arm64 }),
      }),
    ).rejects.toThrow("differs from the verified final")
    await expect(
      computerHelperBuildEnvironment(input, {
        platform: "win32",
        exists: async () => true,
        ensure: async () => result({}),
      }),
    ).rejects.toThrow("does not cover")
    await expect(
      computerHelperBuildEnvironment(input, { platform: "win32", exists: async () => false }),
    ).rejects.toThrow("manifest is missing")
    await expect(
      computerHelperBuildEnvironment(input, {
        platform: "win32",
        exists: async () => true,
        ensure: async () => ({ ...result({ x64 }), skipped: true }),
      }),
    ).rejects.toThrow("does not cover")
  })

  test("a skip can only disable Hands in an explicit dev build", async () => {
    const environment = { VECTOR_COMPUTER_HELPER: "skip", VECTOR_COMPUTER_HELPER_SHA256: JSON.stringify({ x64 }) }
    expect((await computerHelperBuildEnvironment({ channel: "dev", environment })).VECTOR_COMPUTER_HELPER_SHA256).toBe(
      "{}",
    )
    for (const channel of ["beta", "prod"] as const)
      await expect(computerHelperBuildEnvironment({ channel, environment })).rejects.toThrow("Only an explicit dev")
    await expect(
      computerHelperBuildEnvironment({ channel: "dev", environment: { VECTOR_COMPUTER_HELPER: "false" } }),
    ).rejects.toThrow("only accepts")
  })
})
