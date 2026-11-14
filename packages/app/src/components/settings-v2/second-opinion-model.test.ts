import { describe, expect, test } from "bun:test"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { SECOND_OPINION_DESCRIPTION, secondOpinionOffered } from "./second-opinion-model"

// WP A35: Settings offers Second opinion only when vectordev.ai's status lists it for the account's plan (H1).

const status = (overrides: Partial<ModelPlanStatus.Status>): ModelPlanStatus.Status => ({
  signedIn: true,
  enabled: true,
  access: true,
  purchased: { bought: false },
  empty: false,
  low: false,
  ...overrides,
})

describe("secondOpinionOffered", () => {
  test("shown when the plan includes it and it is listed", () => {
    expect(secondOpinionOffered(status({ listed: ["second-opinion"], entitlements: { secondOpinion: true } }))).toBe(
      true,
    )
  })

  test("hidden when unlisted, not included, signed out, unreadable or unknown", () => {
    // publicEntitlements leaves the flag out while the perk is not listed.
    expect(secondOpinionOffered(status({ entitlements: {} }))).toBe(false)
    expect(secondOpinionOffered(status({ entitlements: { secondOpinion: false } }))).toBe(false)
    expect(secondOpinionOffered(status({ signedIn: false, entitlements: { secondOpinion: true } }))).toBe(false)
    expect(
      secondOpinionOffered(status({ error: "Vector could not read your plan.", entitlements: { secondOpinion: true } })),
    ).toBe(false)
    expect(secondOpinionOffered(undefined)).toBe(false)
  })

  test("the row's copy promises nothing it cannot keep", () => {
    expect(SECOND_OPINION_DESCRIPTION).toContain("another lab")
    expect(SECOND_OPINION_DESCRIPTION).not.toMatch(/\$|\d|every|guarantee|exclusive|free/i)
  })
})
