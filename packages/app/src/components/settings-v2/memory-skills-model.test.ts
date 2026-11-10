import { describe, expect, test } from "bun:test"
import { UNDO_DAYS } from "./memory-model"
import {
  BADGE_TITLES,
  DRAFTERS,
  LEARNING,
  PENDING_DAYS,
  SKILLS,
  badges,
  expiry,
  fared,
  idle,
  lastUsed,
  sections,
  shareable,
  sharePath,
  undoable,
  versionLabel,
  weight,
  why,
  type SkillEntryView,
  type SkillInfo,
} from "./memory-skills-model"

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 25, 12)

const skill: SkillInfo = {
  key: "bun-typecheck-packages-core",
  name: "learned-bun-typecheck-packages-core",
  description: "When bun typecheck fails in packages/core: steps that made it pass here before.",
  procedure: "## Steps\n1. Run `bun typecheck`.\n2. Read /repo/packages/core/src/a.ts.",
  checks: ["bun typecheck"],
  commands: ["git diff packages/core"],
  failure: "src/a.ts(3,1): error TS2322",
  version: 3,
  drafter: "rules",
  approvedBy: "user",
  proven: 0.95,
  uses: { loads: 4, passes: 2, fails: 1, ignored: 1, reverts: 0 },
  instructionLikeFailure: false,
  fading: false,
}

const entry = (input: Partial<SkillEntryView> = {}): SkillEntryView => ({
  id: "s4k2q7m",
  status: "active",
  stale: false,
  updatedAt: now,
  createdAt: now,
  skill,
  ...input,
})

describe("Settings > Memory > Skills", () => {
  test("offers review first, auto after a second success and off, and the drafter with Vector Local by default", () => {
    expect(LEARNING.map((item) => [item.value, item.label])).toEqual([
      ["review", "Review first"],
      ["auto", "Apply automatically after a second matching success"],
      ["off", "Off"],
    ])
    expect(DRAFTERS.map((item) => item.value)).toEqual(["off", "local-only", "always"])
    expect(DRAFTERS.find((item) => item.value === "local-only")?.label).toBe("Only with Vector Local")
    expect(DRAFTERS.find((item) => item.value === "always")?.label).toContain(
      "sends a run's commands, file names and a short error excerpt to your model provider",
    )
  })

  test("splits skills into drafts to review, skills in use and what was put away", () => {
    const groups = sections([
      entry({ id: "s1", status: "proposed", updatedAt: now - 2 }),
      entry({ id: "s2", status: "quarantined", hold: "web", updatedAt: now - 1 }),
      entry({ id: "s3" }),
      entry({ id: "s4", status: "archived" }),
      entry({ id: "s5", status: "superseded" }),
    ])
    expect(groups.review.map((item) => item.id)).toEqual(["s2", "s1"])
    expect(groups.inUse.map((item) => item.id)).toEqual(["s3"])
    expect(groups.archived.map((item) => item.id)).toEqual(["s4", "s5"])
  })

  test("says why a draft is there, and how long it waits before tidying drops it", () => {
    expect(why({ check: "bun typecheck", sessions: 2, lastAt: now - 3 * DAY }, now)).toBe(
      "Turned `bun typecheck` green in 2 sessions, last 3 days ago",
    )
    expect(why({ check: "bun test", sessions: 0, lastAt: now }, now)).toBe(
      "Turned `bun test` green in 1 session, last today",
    )
    expect(PENDING_DAYS).toBe(60)
    expect(expiry({ createdAt: now - 10 * DAY, updatedAt: now }, now)).toBe("Dropped in 50 days unless you approve it")
    expect(expiry({ createdAt: now - 59 * DAY, updatedAt: now }, now)).toBe("Dropped in 1 day unless you approve it")
    expect(expiry({ createdAt: now - 61 * DAY, updatedAt: now }, now)).toBe(
      "Dropped at the next tidy unless you approve it",
    )
  })

  test("marks a skill Vector approved, one that is fading and one whose files are gone", () => {
    expect(badges(skill)).toEqual([])
    expect(badges({ ...skill, approvedBy: "vector", fading: true }, { stale: true })).toEqual([
      "Approved by Vector",
      "Fading",
      "Its files are gone",
    ])
    for (const badge of ["Approved by Vector", "Fading", "Its files are gone"]) expect(BADGE_TITLES[badge]).toBeTruthy()
    expect(BADGE_TITLES["Approved by Vector"]).toContain("asks you before it loads it")
    expect(SKILLS.instructionLike).toBe("The error text reads like instructions")
  })

  test("weighs a skill by how proven it is and says how its loads fared", () => {
    expect(weight(0.95)).toBe(95)
    expect(weight(-1)).toBe(0)
    expect(weight(2)).toBe(100)
    expect(fared(skill.uses)).toBe("4 loads · 2 passed · 1 failed · 1 check not run · 0 reverted")
    expect(lastUsed({}, now)).toBe("Not loaded yet")
    expect(lastUsed({ lastUsedAt: now - DAY }, now)).toBe("Last loaded yesterday")
  })

  test("offers Undo on the version in use only in its first week", () => {
    expect(undoable(entry({ skill: { ...skill, approvedAt: now - DAY } }), now)).toBe(true)
    expect(undoable(entry({ skill: { ...skill, approvedAt: now - (UNDO_DAYS + 1) * DAY } }), now)).toBe(false)
    expect(undoable(entry({ status: "proposed" }), now)).toBe(false)
  })

  test("shares only a skill the owner approved that is in use, not private, held or stale", () => {
    expect(shareable(entry())).toBe(true)
    expect(shareable(entry({ skill: { ...skill, approvedBy: "vector" } }))).toBe(false)
    expect(shareable(entry({ private: true }))).toBe(false)
    expect(shareable(entry({ hold: "instruction-like" }))).toBe(false)
    expect(shareable(entry({ stale: true }))).toBe(false)
    expect(shareable(entry({ status: "archived" }))).toBe(false)
    expect(sharePath(skill.name)).toBe(".vector/skills/learned-bun-typecheck-packages-core/SKILL.md")
  })

  test("labels versions, and the one in use", () => {
    expect(versionLabel({ version: 2, reason: "rollback", actor: "user", createdAt: now - DAY }, 3, now)).toBe(
      "Version 2: rolled back by you yesterday",
    )
    expect(versionLabel({ version: 3, reason: "learned", actor: "agent", createdAt: now }, 3, now)).toBe(
      "Version 3: learned by Vector today (in use)",
    )
  })

  test("waits for every session of the directory to be idle before it reloads", () => {
    expect(idle({})).toBe(true)
    expect(idle({ a: { type: "idle" }, b: { type: "idle" } })).toBe(true)
    expect(idle({ a: { type: "idle" }, b: { type: "busy" } })).toBe(false)
    expect(idle({ a: { type: "retry" } })).toBe(false)
  })

  test("keeps to the privacy statements, and never promises more", () => {
    expect(SKILLS.privacy).toBe(
      "Learned skills and workflow insights are stored only in brain.db on this computer. Vector sends them nowhere, except that the optional skill drafter, when you set it to Always, sends one run's commands, file names and a short redacted error excerpt to your model provider. By default it runs only with Vector Local on.",
    )
    expect(SKILLS.intro).toContain("A learned skill is guidance the agent may load, never a rule.")
    expect(SKILLS.share).toBe(
      "This changes repository settings. You'll be asked to trust them again when your running sessions finish.",
    )
    expect(SKILLS.shared).toBe(
      "Vector will ask you to trust this repository's new settings when your running sessions finish.",
    )
    for (const text of Object.values(SKILLS)) {
      expect(text.toLowerCase()).not.toContain("project")
      expect(text).not.toMatch(/cannot change its prompts|guarantee/i)
    }
  })
})
