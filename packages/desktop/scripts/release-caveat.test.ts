import { describe, expect, test } from "bun:test"
import { requiresReaskCaveat } from "./release-caveat"

const entry = (description: unknown, source = "desktop") => ({
  highlights: [{ source, items: [{ title: "Hands", description }] }],
})

describe("measured helper release caveat", () => {
  test("an unchanged measured identity creates no new caveat requirement", () => {
    expect(requiresReaskCaveat(false, undefined)).toBe(false)
    expect(requiresReaskCaveat(false, entry("Ordinary release notes."))).toBe(false)
  })

  test("a changed helper requires an explicit access re-ask sentence in desktop notes", () => {
    expect(
      requiresReaskCaveat(
        true,
        entry("Ad-hoc macOS builds are Preview, and macOS may ask you to grant access again after a helper update."),
      ),
    ).toBe(false)
    expect(requiresReaskCaveat(true, entry("macOS may ask you to grant\naccess again after a helper update."))).toBe(
      false,
    )
    for (const value of [
      undefined,
      {},
      entry(undefined),
      entry("Hands adds computer control."),
      entry("macOS never asks for access again."),
      entry("macOS may ask you to grant access again after a helper update.", "web"),
    ])
      expect(requiresReaskCaveat(true, value)).toBe(true)
  })
})
