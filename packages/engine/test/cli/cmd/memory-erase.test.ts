import { describe, expect, test } from "bun:test"
import { eraseWarning, erasedMessage } from "@/cli/cmd/memory"

// `vector memory erase` goes through BrainErase, as Settings > Memory does (packages/core/test/research/store.test.ts
// covers what it takes); here, what it says before and after.

describe("vector memory erase", () => {
  test("asks first, naming the Deep research a repository's erase and an erase of everything take", () => {
    expect(eraseWarning("repository")).toBe(
      "This erases what Vector learned in this repository, its failure memory, skills, workflow insights and Deep research runs included. Run it again with --yes to confirm.",
    )
    expect(eraseWarning("all")).toBe(
      "This erases everything Vector learned, in every repository and about you, and every Deep research run. Run it again with --yes to confirm.",
    )
    // Research is the repository's: erasing what Vector learned about you leaves it.
    expect(eraseWarning("personal")).toBe("This erases what Vector learned about you. Run it again with --yes to confirm.")
  })

  test("says how many entries went, and how many research runs when any did", () => {
    expect(erasedMessage({ entries: 0, runs: 0 })).toBe("Erased 0 entries")
    expect(erasedMessage({ entries: 1, runs: 0 })).toBe("Erased 1 entry")
    expect(erasedMessage({ entries: 3, runs: 1 })).toBe("Erased 3 entries and 1 research run")
    expect(erasedMessage({ entries: 0, runs: 2 })).toBe("Erased 0 entries and 2 research runs")
  })
})
