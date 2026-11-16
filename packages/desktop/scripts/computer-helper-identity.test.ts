import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { legacyName } from "@vectordevai/core/flag/legacy"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { Hands } from "@vectordevai/schema/hands"
import { readBlocklist } from "../test/computer/fake-desktop"
import { APP_IDS, EXECUTABLE_NAMES } from "./channel-ids"
import {
  BLOCKLIST_FILE,
  IDENTITY_FILE,
  generateBlocklist,
  generateIdentitySources,
  readIdentity,
  renderBlocklist,
} from "./computer-helper-identity"

// C1: the shared helper inputs. identity.json and the generated blocklist.json are the single sources both native
// helpers build from; these tests keep them in step with the shared constants and the app table.

async function inTemp<T>(run: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "vector-computer-identity-"))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const SUFFIX: Record<Hands.Channel, string> = { prod: "", beta: " Beta", dev: " Dev" }

describe("blocklist.json", () => {
  test("the committed file equals a fresh render, byte for byte", () =>
    inTemp(async (dir) => {
      const file = path.join(dir, "blocklist.json")
      const text = generateBlocklist(file)
      expect(await Bun.file(file).text()).toBe(text)
      expect(await Bun.file(BLOCKLIST_FILE).text()).toBe(text)
      // Deterministic: no timestamps, the same order every time.
      expect(renderBlocklist()).toBe(text)
    }))

  test("keeps the table's entries and order, with never entries first", () => {
    const file = readBlocklist(JSON.parse(renderBlocklist())).file
    expect(file.entries.map((entry) => entry.key)).toEqual(ComputerApps.TABLE.map((entry) => entry.key))
    expect(file.never).toEqual([...ComputerApps.NEVER])
    expect(file.noAlways).toEqual([...ComputerApps.NO_ALWAYS])
    expect(file.clickOnly).toEqual([...ComputerApps.CLICK_ONLY])
    const firstOther = file.entries.findIndex((entry) => entry.list !== "never")
    expect(file.entries.slice(firstOther).some((entry) => entry.list === "never")).toBe(false)
    expect(file.rules.map((rule) => rule.id)).toEqual([
      "never",
      "child-shell",
      "system-ui",
      "system",
      "listed",
      "enforce",
      "click-only",
    ])
  })

  // Disk Utility, Find My and Migration Assistant are Apple platform binaries, yet the user can unblock them (E0.5),
  // so they must never become permanent never entries.
  test("default-blocked entries stay removable and outside never; never entries are not removable", () => {
    const file = readBlocklist(JSON.parse(renderBlocklist())).file
    const defaults = file.entries.filter((entry) => entry.list === "default-blocked")
    expect(defaults.map((entry) => entry.key)).toEqual(ComputerApps.DEFAULT_BLOCKED.map((entry) => entry.key))
    expect(defaults.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["Disk Utility", "Find My", "Migration Assistant"]),
    )
    for (const entry of defaults) {
      expect(entry.removable).toBe(true)
      expect(file.never).not.toContain(entry.category)
    }
    const never = file.entries.filter((entry) => entry.list === "never")
    expect(never.length).toBeGreaterThan(0)
    for (const entry of never) {
      expect(entry.removable).toBe(false)
      expect(file.never).toContain(entry.category)
    }
    for (const entry of file.entries.filter((item) => item.list !== "never" && item.list !== "default-blocked"))
      expect(entry.removable).toBeUndefined()
  })

  test("each never category reports the reason builtinRule gives", () => {
    const file = readBlocklist(JSON.parse(renderBlocklist())).file
    expect(Object.keys(file.reasons).toSorted()).toEqual([...ComputerApps.NEVER].toSorted())
    for (const entry of ComputerApps.TABLE.filter((item) => ComputerApps.isNever(item.category)))
      for (const bundleId of entry.macos ?? []) {
        const rule = ComputerApps.builtinRule({
          platform: "macos",
          bundleId: bundleId.replace(/\*$/, "x"),
          apple: false,
          system: false,
          verified: true,
          name: entry.name,
        })
        expect(file.reasons[entry.category]).toBe(rule!.reason)
      }
  })
})

describe("identity.json", () => {
  test("decodes strictly and agrees with the shared constants", () => {
    const identity = readIdentity()
    expect(identity.displayName).toBe(Hands.NAME)
    expect(identity.bundleIdSuffix).toBe(ComputerApps.HELPER_SUFFIX)
    expect(identity.protocol).toEqual({ min: Computer.PROTOCOL, max: Computer.PROTOCOL })
    // Identity-bearing names stay `computer` (section 2.1): renaming one resets every user's macOS grants.
    expect(identity.mac).toEqual({
      bundle: "VectorComputer.app",
      executable: "VectorComputer",
      minimumSystemVersion: "14.0",
    })
    expect(identity.windows).toEqual({ executable: "vector-computer.exe", minimumBuild: 19041 })
    expect(Object.values(APP_IDS).toSorted()).toEqual([...ComputerApps.VECTOR_APP_IDS].toSorted())
    expect([...ComputerApps.VECTOR_WINDOWS_BINARIES].toSorted()).toEqual(
      [...Object.values(EXECUTABLE_NAMES).map((name) => `${name}.exe`), identity.windows.executable].toSorted(),
    )
  })

  test("displayName plus the channel suffix is the helper's name on every channel", () => {
    const identity = readIdentity()
    for (const channel of Hands.CHANNELS)
      expect(`${identity.displayName}${SUFFIX[channel]}`).toBe(Hands.helperName(channel))
  })

  test("rejects a field the contract does not define", () =>
    inTemp(async (dir) => {
      const file = path.join(dir, "identity.json")
      await Bun.write(file, JSON.stringify({ ...(await Bun.file(IDENTITY_FILE).json()), helperId: "x" }))
      expect(() => readIdentity(file)).toThrow()
    }))
})

test("the former product name appears in neither shared file", async () => {
  expect(legacyName).toBeTruthy()
  for (const file of [BLOCKLIST_FILE, IDENTITY_FILE])
    expect((await Bun.file(file).text()).toLowerCase()).not.toContain(legacyName!)
})

describe("generated sources", () => {
  test("name every channel id, helper id and Electron helper id, and embed blocklist.json verbatim", () =>
    inTemp(async (dir) => {
      const committed = await Bun.file(BLOCKLIST_FILE).text()
      const files = generateIdentitySources(dir)
      expect(files.map((file) => path.basename(file))).toEqual(["Identity.swift", "identity.h", "blocklist.h"])
      const [swift, identity, blocklist] = await Promise.all(files.map((file) => Bun.file(file).text()))
      for (const source of [swift!, identity!]) {
        expect(source).toContain("Do not edit.")
        for (const appId of ComputerApps.VECTOR_APP_IDS) {
          expect(source).toContain(`"${appId}"`)
          expect(source).toContain(`"${Hands.helperBundleId(appId)}"`)
          for (const suffix of ComputerApps.ELECTRON_HELPER_SUFFIXES) expect(source).toContain(`"${appId}.${suffix}"`)
        }
        for (const channel of Hands.CHANNELS) expect(source).toContain(`"${Hands.helperName(channel)}"`)
        for (const binary of ComputerApps.VECTOR_WINDOWS_BINARIES) expect(source).toContain(`"${binary}"`)
      }
      expect(swift!).toContain(`#"""\n${committed}\n"""#`)
      const parts = [...blocklist!.matchAll(/R"json\(([\s\S]*?)\)json"/g)].map((match) => match[1]!)
      expect(parts.length).toBeGreaterThan(1)
      expect(parts.every((part) => Buffer.byteLength(part) <= 8192)).toBe(true)
      expect(parts.join("")).toBe(committed)
      // Rendering never rewrites the committed file, and renders the same bytes again.
      expect(await Bun.file(BLOCKLIST_FILE).text()).toBe(committed)
      const again = await inTemp(async (other) =>
        Promise.all(generateIdentitySources(other).map((file) => Bun.file(file).text())),
      )
      expect(again).toEqual([swift, identity, blocklist])
    }))

  test("refuse a stale blocklist.json instead of building against it", () =>
    inTemp(async (dir) => {
      const stale = path.join(dir, "blocklist.json")
      const committed = await Bun.file(BLOCKLIST_FILE).text()
      expect(committed).toContain('"com.apple.Terminal"')
      await Bun.write(stale, committed.replace('"com.apple.Terminal"', '"com.apple.Terminal.old"'))
      expect(() => generateIdentitySources(path.join(dir, "out"), { blocklist: stale })).toThrow(/stale/)
      expect(await Bun.file(path.join(dir, "out", "Identity.swift")).exists()).toBe(false)
    }))

  // The display name must be the shared name exactly: a prefix such as "Vector" would ship a helper whose
  // displayName disagrees with every helperName next to it.
  test("refuse an identity.json that disagrees with the shared constants, writing nothing", () =>
    inTemp(async (dir) => {
      const committed = await Bun.file(IDENTITY_FILE).json()
      const cases = [
        [{ displayName: "Vector" }, /displayName/],
        [{ displayName: `${Hands.NAME.slice(0, -1)}` }, /displayName/],
        [{ displayName: `${Hands.NAME} Beta` }, /displayName/],
        [{ bundleIdSuffix: "helper" }, /bundleIdSuffix/],
        [{ protocol: { min: Computer.PROTOCOL + 1, max: Computer.PROTOCOL + 2 } }, /protocol/],
        [{ windows: { ...committed.windows, executable: "vector-helper.exe" } }, /VECTOR_WINDOWS_BINARIES/],
      ] as const
      for (const [index, [change, message]] of cases.entries()) {
        const file = path.join(dir, `identity-${index}.json`)
        await Bun.write(file, JSON.stringify({ ...committed, ...change }))
        const out = path.join(dir, `out-${index}`)
        expect(() => generateIdentitySources(out, { identity: file })).toThrow(message)
        for (const name of ["Identity.swift", "identity.h", "blocklist.h"])
          expect(await Bun.file(path.join(out, name)).exists()).toBe(false)
      }
    }))
})
