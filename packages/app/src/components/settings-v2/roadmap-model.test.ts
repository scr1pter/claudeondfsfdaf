import { describe, expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import {
  ballotLine,
  choiceTitle,
  decodeRoadmap,
  nominationReady,
  refusalText,
  resultsLine,
  roadmapTab,
  ROADMAP_PLANNED,
  totalShare,
} from "./roadmap-model"

// WP A34: Settings > Roadmap vote as the app reads vectordev.ai's answer. The tab shows only when the status lists the
// vote for this plan; the page words refusals, the ballot and the results, and never a date for a feature.

// The Codium status as the desktop decodes vectordev.ai's answer: the newer fields come from the raw body.
function status(entitlements?: Record<string, unknown>, extra: Partial<ModelPlanStatus.Status> = {}) {
  const remote = {
    enabled: true,
    access: true,
    plan: { id: "vector-100", name: "Max", renewsAt: 1_790_000_000_000, cancelAtPeriodEnd: false },
    purchased: { bought: false },
    empty: false,
    low: false,
  }
  const body = { ...remote, ...(entitlements ? { listed: ["vote"], entitlements } : {}) }
  return { ...ModelPlanStatus.fromRemote(remote, body), ...extra }
}

const answer = {
  quarter: "2026-q4",
  ballot: {
    quarter: "2026-q4",
    opensAt: 1_790_000_000_000,
    closesAt: 1_791_000_000_000,
    open: true,
    candidates: [
      { id: "offline-sync", title: "Offline sync for agent sessions" },
      { id: "diff-search", title: "Search inside diffs", detail: "Find a change across open reviews." },
    ],
    choice: "diff-search",
  },
  results: {
    quarter: "2026-q3",
    closedAt: 1_789_000_000_000,
    minimum: 20,
    published: true,
    counted: 25,
    totals: [
      { id: "voice-notes", title: "Voice notes in the composer", votes: 15 },
      { id: "pinned-tabs", title: "Pinned agent tabs", votes: 10 },
    ],
    tied: false,
    winner: { id: "voice-notes", title: "Voice notes in the composer", planned: ROADMAP_PLANNED },
    choice: "pinned-tabs",
  },
  vote: { allowed: true },
  nominate: { allowed: true },
}

describe("the tab", () => {
  test("shows only when the signed-in account's status lists the vote for its plan", () => {
    expect(roadmapTab(status({ vote: true, nominate: false }))).toBe(true)
    expect(roadmapTab(status({ vote: false }))).toBe(false)
    // Not listed: the status carries no vote at all.
    expect(roadmapTab(status())).toBe(false)
    expect(roadmapTab(status({ vote: true }, { signedIn: false }))).toBe(false)
    expect(roadmapTab(status({ vote: true }, { error: "Vector could not load your Codium usage." }))).toBe(false)
    expect(roadmapTab(undefined)).toBe(false)
    // A string or a number is not the flag.
    expect(roadmapTab(status({ vote: "true" }))).toBe(false)
  })
})

describe("decoding vectordev.ai's answer", () => {
  test("keeps the ballot, the results and what this account may do", () => {
    const roadmap = decodeRoadmap(answer)!
    expect(roadmap).toEqual(answer as never)
    expect(choiceTitle(roadmap.results!)).toBe("Pinned agent tabs")
    expect(resultsLine(roadmap.results!)).toBe("Voice notes in the composer: Planned for the next release cycle.")
    expect(totalShare(roadmap.results!.totals![0]!, roadmap.results!.counted)).toBe(60)
  })

  test("drops parts it cannot read instead of failing the page, and reads an unknown refusal as unavailable", () => {
    expect(decodeRoadmap(undefined)).toBeUndefined()
    expect(decodeRoadmap({ quarter: "Q4" })).toBeUndefined()
    const roadmap = decodeRoadmap({
      quarter: "2026-q4",
      ballot: { ...answer.ballot, candidates: [{ id: "x" }] },
      results: { ...answer.results, totals: "many" },
      vote: { allowed: false, reason: "mystery" },
      nominate: { allowed: true, nomination: { title: "Pinned agent tabs", at: 1_790_000_000_000 } },
    })!
    expect(roadmap.ballot).toBeUndefined()
    expect(roadmap.results).toBeUndefined()
    expect(roadmap.vote).toEqual({ allowed: false, reason: "unavailable" })
    // A nomination made means none is left this quarter, whatever the flag says.
    expect(roadmap.nominate).toEqual({
      allowed: false,
      nomination: { title: "Pinned agent tabs", at: 1_790_000_000_000 },
    })
    // A choice that is not on the ballot is not shown as the account's vote.
    expect(
      decodeRoadmap({ ...answer, ballot: { ...answer.ballot, choice: "teleport" } })!.ballot!.choice,
    ).toBeUndefined()
    // A winner without words gets the planned line, never a date.
    const words = decodeRoadmap({
      ...answer,
      results: { ...answer.results, winner: { id: "voice-notes", title: "Voice notes in the composer" } },
    })!
    expect(words.results!.winner!.planned).toBe(ROADMAP_PLANNED)
  })
})

describe("words", () => {
  const date = (time: number) => `day ${time}`

  test("the ballot line says when voting opens or closes, and that the vote can change until then", () => {
    const roadmap = decodeRoadmap(answer)!
    expect(ballotLine(roadmap.ballot!, date)).toBe(
      "Your vote is in. You can change it until voting closes day 1791000000000.",
    )
    const { choice: _choice, ...unvoted } = roadmap.ballot!
    expect(ballotLine(unvoted, date)).toBe("Voting closes day 1791000000000. You can change your vote until then.")
    expect(ballotLine({ ...unvoted, open: false }, date)).toBe("Voting opens day 1790000000000.")
  })

  test("results below the minimum, ties and refusals", () => {
    expect(resultsLine({ quarter: "2026-q3", closedAt: 1, minimum: 20, published: false })).toBe(
      "Fewer than 20 ballots were counted, so no result is published for this vote.",
    )
    expect(resultsLine({ ...decodeRoadmap(answer)!.results!, winner: undefined, tied: true })).toBe(
      "The top features tied. The team will say which goes first.",
    )
    expect(refusalText("plan")).toBe("Voting is part of Vector Codium Max and Ultra.")
    expect(refusalText("payment")).toContain("payment goes through")
    expect(refusalText("hold")).toContain("on hold")
    expect(refusalText(undefined)).toContain("unavailable")
  })

  test("a nomination needs a name of 3 to 80 characters and up to 280 more", () => {
    expect(nominationReady("Pinned agent tabs", "")).toBe(true)
    expect(nominationReady("  ab  ", "")).toBe(false)
    expect(nominationReady("x".repeat(81), "")).toBe(false)
    expect(nominationReady("Pinned agent tabs", "y".repeat(281))).toBe(false)
  })

  test("no line the page shows names a date, a month or a quarter for a feature", () => {
    const lines = [
      ROADMAP_PLANNED,
      resultsLine(decodeRoadmap(answer)!.results!),
      resultsLine({ quarter: "2026-q3", closedAt: 1, minimum: 20, published: false }),
      ...(["plan", "payment", "hold", "unavailable"] as const).map(refusalText),
    ].join("\n")
    expect(lines).not.toMatch(/\b(?:19|20)\d{2}\b|\bq[1-4]\b|soon|guarantee|january|december/i)
  })
})
