import { describe, expect, test } from "bun:test"
import { releaseCaveatEntry, requiresReaskCaveat } from "./release-caveat"

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

describe("unversioned Hands preview notes", () => {
  const published = { ...entry("Published desktop notes without Hands."), tag: "v1.99.112" }
  const document = { releases: [published] }
  const draft = entry("macOS may ask you to grant access again after a helper update.")
  const environment = {
    RELEASE_DRY_RUN: "true",
    REQUESTED_UNSIGNED: "true",
    RELEASE_PRERELEASE: "false",
    VECTOR_CHANNEL: "prod",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/hands",
    GITHUB_REPOSITORY: "fixture/repo",
    EVENT_REPOSITORY: "fixture/repo",
  }

  test("normal releases still require the caveat in their exact versioned desktop notes", () => {
    const selected = releaseCaveatEntry(document, "v1.99.112")
    expect(selected).toBe(published)
    expect(requiresReaskCaveat(true, selected)).toBe(true)
    expect(() => releaseCaveatEntry(document, "v1.99.113")).toThrow("exactly one")
    expect(() => releaseCaveatEntry({ releases: [published, published] }, "v1.99.112")).toThrow("exactly one")
  })

  test("only an explicit unsigned same-repository stable Hands preview can use the unversioned draft", () => {
    const selected = releaseCaveatEntry(document, "v1.99.112", { entry: draft, environment })
    expect(selected).toBe(draft)
    expect(requiresReaskCaveat(true, selected)).toBe(false)
    for (const changed of [
      { RELEASE_DRY_RUN: "false" },
      { RELEASE_DRY_RUN: "" },
      { REQUESTED_UNSIGNED: "false" },
      { RELEASE_PRERELEASE: "true" },
      { RELEASE_PRERELEASE: "" },
      { VECTOR_CHANNEL: "beta" },
      { VECTOR_CHANNEL: "dev" },
      { GITHUB_EVENT_NAME: "push" },
      { GITHUB_REF: "refs/heads/main" },
      { GITHUB_REF: "refs/tags/v1.99.112" },
      { EVENT_REPOSITORY: "fork/repo" },
      { GITHUB_REPOSITORY: "" },
    ])
      expect(() =>
        releaseCaveatEntry(document, "v1.99.112", { entry: draft, environment: { ...environment, ...changed } }),
      ).toThrow("artifacts-only dispatch")
    expect(() => releaseCaveatEntry(document, "v1.99.112", { entry: draft, environment: {} })).toThrow(
      "artifacts-only dispatch",
    )
    expect(() => releaseCaveatEntry({ releases: [] }, "v1.99.112", { entry: draft, environment })).toThrow(
      "exactly one",
    )
  })
})
