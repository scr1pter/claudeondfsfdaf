import { describe, expect, test } from "bun:test"
import { SKILL_ID, chipLabel, learnedFrom, record, watchLearned } from "./learned"

describe("what Vector learned, for the chip under a reply", () => {
  test("keeps each event's entries under the message it learned from, once however often the stream replays it", () => {
    record({ sessionID: "ses_a", messageID: "msg_user", entryIDs: ["m1", "m2"] })
    record({ sessionID: "ses_a", messageID: "msg_user", entryIDs: ["m2"] })
    record({ sessionID: "ses_a", messageID: "msg_reply", entryIDs: ["m3"] })
    record({ sessionID: "ses_b", messageID: "msg_user", entryIDs: ["m9"] })
    // A request's chip shows what its typed words taught and what its reply's plan card did.
    expect(learnedFrom("ses_a", ["msg_user", "msg_reply"])).toEqual(["m1", "m2", "m3"])
    expect(learnedFrom("ses_a", ["msg_user"])).toEqual(["m1", "m2"])
    expect(learnedFrom("ses_a", ["msg_other", undefined])).toEqual([])
    expect(learnedFrom("ses_none", ["msg_user"])).toEqual([])
  })

  test("ignores an event that names no message or no entries", () => {
    record({ sessionID: "ses_c", entryIDs: ["m1"] })
    record({ sessionID: "ses_c", messageID: "msg_user", entryIDs: [] })
    expect(learnedFrom("ses_c", ["msg_user"])).toEqual([])
  })

  test("listens to one directory's events once", () => {
    const listeners: ((event: {
      properties: { sessionID: string; messageID?: string; entryIDs: string[] }
    }) => void)[] = []
    const events = {
      on: (_type: "memory.learned", listener: (typeof listeners)[number]) => {
        listeners.push(listener)
        return () => undefined
      },
    }
    watchLearned(events)
    watchLearned(events)
    expect(listeners).toHaveLength(1)
    listeners[0]!({ properties: { sessionID: "ses_d", messageID: "msg_user", entryIDs: ["m4"] } })
    expect(learnedFrom("ses_d", ["msg_user"])).toEqual(["m4"])
  })

  test("says one item in full and more as a count, and which wait for review", () => {
    expect(chipLabel([{ text: "Always use tables.", status: "active", typed: true }])).toBe(
      'Learned from what you typed: "Always use tables."',
    )
    expect(chipLabel([{ text: "Prefer nature.com.", status: "active", typed: false }])).toBe(
      'Learned from your plan card: "Prefer nature.com."',
    )
    expect(chipLabel([{ text: "I prefer tabs.", status: "proposed", typed: true }])).toBe(
      'Saved from what you typed for your review: "I prefer tabs."',
    )
    expect(
      chipLabel([
        { text: "a", status: "active", typed: true },
        { text: "b", status: "active", typed: true },
      ]),
    ).toBe("Learned 2 things")
    expect(
      chipLabel([
        { text: "a", status: "active", typed: true },
        { text: "b", status: "proposed", typed: true },
        { text: "c", status: "quarantined", typed: true },
      ]),
    ).toBe("Learned 3 things, 2 waiting for your review")
  })

  test("names a drafted skill, and says whether it waits for review", () => {
    expect(chipLabel([{ text: "learned-bun-typecheck-src", status: "proposed", typed: false, skill: true }])).toBe(
      "Drafted a skill for your review: learned-bun-typecheck-src",
    )
    expect(chipLabel([{ text: "learned-bun-typecheck-src", status: "active", typed: false, skill: true }])).toBe(
      "Learned a skill: learned-bun-typecheck-src",
    )
    expect(
      chipLabel([
        { text: "learned-bun-test", status: "proposed", typed: false, skill: true },
        { text: "Use tables.", status: "active", typed: true },
      ]),
    ).toBe("Learned 2 things, 1 waiting for your review")
  })

  test("tells a skill's id from a memory entry's", () => {
    expect(SKILL_ID.test("s4k2q7m")).toBe(true)
    expect(SKILL_ID.test("m4k2q")).toBe(false)
    expect(SKILL_ID.test("s4k2q7mx")).toBe(false)
  })
})
