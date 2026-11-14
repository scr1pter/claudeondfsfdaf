import { describe, expect, test } from "bun:test"
import type { Config } from "@vectordevai/sdk/v2/client"
import { NATIVE_SPECIALISTS } from "@vectordevai/core/agent/specialists"
import { GENERAL_SUBAGENT_ID, SUBAGENT_IDENTITIES } from "@vectordevai/session-ui/subagent-identity"
import {
  COMMAND_ROOTS,
  SPECIALIST_IDS,
  agentEnabled,
  agentSwitchPatch,
  commandRoots,
  createAgentSwitchSaver,
  nothingRunning,
  runningWork,
  stopWorkDescription,
} from "./subagent-switches"

describe("runningWork", () => {
  const helpers: Record<string, string> = {
    review: "Vectorscope review",
    security: "Vectorscope review",
    type: "Autocomplete",
  }
  const helperOf = (sessionID: string) => helpers[sessionID]

  test("counts every session that is not idle", () => {
    expect(runningWork({}, helperOf)).toEqual({ sessions: 0, helpers: [] })
    expect(runningWork({ a: { type: "idle" } }, helperOf)).toEqual({ sessions: 0, helpers: [] })
    expect(
      runningWork({ a: { type: "idle" }, b: { type: "busy" }, c: { type: "retry" }, d: undefined }, helperOf),
    ).toEqual({ sessions: 2, helpers: [] })
  })

  test("names Vector's running helpers instead of counting them as sessions", () => {
    expect(
      runningWork(
        { b: { type: "busy" }, review: { type: "busy" }, security: { type: "busy" }, type: { type: "idle" } },
        helperOf,
      ),
    ).toEqual({ sessions: 1, helpers: ["Vectorscope review"] })
  })
})

describe("stopWorkDescription", () => {
  // A save reloads each folder once its turns and subagents end (global-lifecycle.ts): nothing stops that work, so the
  // dialog never says it does, nor that the new setting applies from the next message.
  test("says how many sessions are working, and that they finish with the current setting", () => {
    expect(stopWorkDescription({ sessions: 1, helpers: [] })).toBe(
      "1 session is working right now. That work keeps the current setting until it ends; the new setting applies after that.",
    )
    const four = stopWorkDescription({ sessions: 4, helpers: [] })
    expect(four).toContain("4 sessions are working right now, subagents included")
    for (const text of [stopWorkDescription({ sessions: 1, helpers: [] }), four]) {
      expect(text).not.toContain("stops")
      expect(text).not.toContain("next message")
    }
  })

  test("names Vector's helpers, never calling them sessions", () => {
    const helpersOnly = stopWorkDescription({ sessions: 0, helpers: ["Vectorscope review"] })
    expect(helpersOnly).toBe(
      "One of Vector's helpers is working right now (Vectorscope review). That work keeps the current setting until it ends; the new setting applies after that.",
    )
    expect(helpersOnly).not.toContain("session")
    expect(stopWorkDescription({ sessions: 0, helpers: ["Vectorscope review", "Autocomplete"] })).toBe(
      "Vector's helpers are working right now (Vectorscope review, Autocomplete). That work keeps the current setting until it ends; the new setting applies after that.",
    )
    expect(stopWorkDescription({ sessions: 1, helpers: ["Vectorscope review", "Autocomplete"] })).toBe(
      "1 session is working right now. Vector's helpers are working too (Vectorscope review, Autocomplete). That work keeps the current setting until it ends; the new setting applies after that.",
    )
  })
})

// A save reloads every folder, which stops background commands too (5.H), and they run in idle conversations.
describe("background commands", () => {
  test("count as running work, so the page asks before a save stops them", () => {
    expect(nothingRunning({ sessions: 0, helpers: [] })).toBe(true)
    expect(nothingRunning({ sessions: 0, helpers: [], commands: 0 })).toBe(true)
    expect(nothingRunning({ sessions: 0, helpers: [], commands: 1 })).toBe(false)
    expect(stopWorkDescription({ sessions: 0, helpers: [], commands: 1 })).toBe(
      "1 background command is running. Changing this setting stops it, and the new setting applies from your next message.",
    )
    expect(stopWorkDescription({ sessions: 0, helpers: [], commands: 2 })).toBe(
      "2 background commands are running. Changing this setting stops them, and the new setting applies from your next message.",
    )
    // A working session holds its folder's reload, so only the commands stop at once.
    expect(stopWorkDescription({ sessions: 1, helpers: [], commands: 2 })).toBe(
      "1 session is working right now. 2 background commands are running. Changing this setting stops the background commands. Other work keeps the current setting until it ends; the new setting applies after that.",
    )
  })

  test("are asked of the recent conversations the app has seen work, never of subagents or Vector's helpers", () => {
    const sessions: Record<
      string,
      { id: string; directory: string; parentID?: string; internal?: string; time: { updated: number } }
    > = {
      old: { id: "old", directory: "/a", time: { updated: 1 } },
      recent: { id: "recent", directory: "/b", time: { updated: 9 } },
      child: { id: "child", directory: "/a", parentID: "old", time: { updated: 10 } },
      review: { id: "review", directory: "/a", internal: "vectorscope", time: { updated: 11 } },
    }
    const roots = commandRoots(
      { old: { type: "idle" }, recent: { type: "idle" }, child: { type: "busy" }, review: { type: "busy" }, gone: {} },
      (id) => sessions[id],
      (session) => session.internal !== undefined,
    )
    expect(roots.map((session) => session.id)).toEqual(["recent", "old"])
    const many = Object.fromEntries(
      Array.from({ length: COMMAND_ROOTS + 5 }, (_, index) => [
        `s${index}`,
        { id: `s${index}`, directory: "/a", time: { updated: index } },
      ]),
    )
    const picked = commandRoots(
      many,
      (id) => many[id],
      () => false,
    )
    expect(picked).toHaveLength(COMMAND_ROOTS)
    expect(picked[0]?.id).toBe(`s${COMMAND_ROOTS + 4}`)
  })
})

describe("agentEnabled", () => {
  test("is on when the config says nothing about the agent", () => {
    expect(agentEnabled({}, "general")).toBe(true)
    expect(agentEnabled({ agent: {} }, "review")).toBe(true)
    expect(agentEnabled({ agent: { general: {} } }, "general")).toBe(true)
  })

  test("is on when the agent is explicitly not disabled", () => {
    expect(agentEnabled({ agent: { general: { disable: false } } }, "general")).toBe(true)
  })

  test("is off only when that agent is disabled", () => {
    const config: Config = { agent: { explore: { disable: true }, reviewer: { disable: true } } }
    expect(agentEnabled(config, "explore")).toBe(false)
    expect(agentEnabled(config, "general")).toBe(true)
    expect(agentEnabled(config, "review")).toBe(true)
  })
})

describe("SPECIALIST_IDS", () => {
  // The engine checks NATIVE_SPECIALISTS against the agents it ships, so a specialist added there fails here until it
  // has an identity, and with it a switch.
  test("are the specialists that ship with Vector, and nothing else", () => {
    expect(SPECIALIST_IDS.toSorted()).toEqual([...NATIVE_SPECIALISTS])
    expect(Object.keys(SUBAGENT_IDENTITIES).toSorted()).toEqual([GENERAL_SUBAGENT_ID, ...NATIVE_SPECIALISTS].toSorted())
  })
})

describe("agentSwitchPatch", () => {
  test("touches only the picked agents' disable flags", () => {
    expect(agentSwitchPatch({ general: false })).toEqual({ agent: { general: { disable: true } } })
    expect(agentSwitchPatch({ general: true })).toEqual({ agent: { general: { disable: false } } })
    expect(agentSwitchPatch({ review: false, test: true })).toEqual({
      agent: { review: { disable: true }, test: { disable: false } },
    })
  })

  test("round-trips through the reader", () => {
    expect(agentEnabled(agentSwitchPatch({ general: false }), "general")).toBe(false)
    expect(agentEnabled(agentSwitchPatch({ general: true }), "general")).toBe(true)
  })
})

// An engine stand-in for the saver: each save is one config update, and so one engine reload. It deep-merges the
// patch the way the global config update does, and a save can be held open or made to fail.
function engine() {
  const state = { config: {} as Config, saves: [] as Config[], hold: false, fail: false }
  const held: Array<() => void> = []
  const save = (patch: Config) => {
    state.saves.push(patch)
    const settle = () => {
      if (state.fail) throw new Error("config write failed")
      state.config = { ...state.config, agent: { ...state.config.agent, ...patch.agent } }
    }
    if (!state.hold) return Promise.resolve().then(settle)
    return new Promise<void>((resolve, reject) => held.push(() => Promise.resolve().then(settle).then(resolve, reject)))
  }
  return {
    state,
    save,
    saved: (id: string) => agentEnabled(state.config, id),
    release: () => held.splice(0).forEach((settle) => settle()),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("createAgentSwitchSaver", () => {
  test("rapid flips end in one save with the final state", async () => {
    const fake = engine()
    const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 5 })
    saver.pick({ general: false })
    saver.pick({ general: true })
    saver.pick({ general: false })
    expect(saver.enabled("general")).toBe(false)
    await settle()

    expect(fake.state.saves).toEqual([{ agent: { general: { disable: true } } }])
    expect(saver.enabled("general")).toBe(false)
  })

  test("flipping off and back on saves nothing", async () => {
    const fake = engine()
    const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 5 })
    saver.pick({ review: false })
    saver.pick({ review: true })
    await settle()

    expect(fake.state.saves).toEqual([])
    expect(saver.enabled("review")).toBe(true)
  })

  test("flips during a save go out in one more save, and the switch never flicks back", async () => {
    const fake = engine()
    fake.state.hold = true
    const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 5 })
    saver.pick({ general: false })
    await settle()
    expect(fake.state.saves).toHaveLength(1)

    saver.pick({ general: true })
    saver.pick({ general: false })
    saver.pick({ general: true })
    expect(saver.enabled("general")).toBe(true)
    await settle()
    // Nothing more goes out while the first save is in flight.
    expect(fake.state.saves).toHaveLength(1)

    fake.state.hold = false
    fake.release()
    await settle()
    expect(fake.state.saves).toEqual([
      { agent: { general: { disable: true } } },
      { agent: { general: { disable: false } } },
    ])
    expect(saver.enabled("general")).toBe(true)
    expect(fake.saved("general")).toBe(true)
  })

  test("a failed save puts the switch back and names it", async () => {
    const fake = engine()
    fake.state.fail = true
    const failures: string[][] = []
    const saver = createAgentSwitchSaver({
      saved: fake.saved,
      save: fake.save,
      onError: (_, ids) => failures.push(ids),
      delay: 5,
    })
    saver.pick({ security: false })
    expect(saver.enabled("security")).toBe(false)
    await settle()

    expect(failures).toEqual([["security"]])
    expect(saver.enabled("security")).toBe(true)
  })

  test("each specialist switch writes its own agent.<id>.disable", async () => {
    for (const id of SPECIALIST_IDS) {
      const fake = engine()
      const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 1 })
      saver.pick({ [id]: false })
      await saver.flush()

      expect(fake.state.saves).toEqual([{ agent: { [id]: { disable: true } } }])
      expect(SPECIALIST_IDS.filter((other) => !fake.saved(other))).toEqual([id])
      expect(fake.saved("general")).toBe(true)
    }
  })

  test("the all-specialists switch saves every specialist in one update and nothing else", async () => {
    const fake = engine()
    const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 5 })
    saver.pick(Object.fromEntries(SPECIALIST_IDS.map((id) => [id, false])))
    await settle()

    expect(fake.state.saves).toHaveLength(1)
    expect(Object.keys(fake.state.saves[0]?.agent ?? {}).toSorted()).toEqual(SPECIALIST_IDS.toSorted())
    for (const id of ["build", "plan", "general", "quick", "autocomplete", "compaction", "title", "summary"]) {
      expect(fake.state.saves[0]?.agent?.[id]).toBeUndefined()
    }
    expect(SPECIALIST_IDS.every((id) => !saver.enabled(id))).toBe(true)

    saver.pick(Object.fromEntries(SPECIALIST_IDS.map((id) => [id, true])))
    await settle()
    expect(fake.state.saves).toHaveLength(2)
    expect(SPECIALIST_IDS.every((id) => fake.saved(id))).toBe(true)
  })
})
