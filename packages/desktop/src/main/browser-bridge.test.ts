import { describe, expect, test } from "bun:test"
import { MAX_RESEARCH_BROWSERS, parseBrowserAgentInput, parseResearchBrowserInput } from "./browser-bridge-input"

describe("browser bridge input", () => {
  test("accepts a bounded engine command", () => {
    expect(parseBrowserAgentInput({ contextId: "session-1", command: "click", selector: "#submit" })).toEqual({
      contextId: "session-1",
      command: "click",
      selector: "#submit",
      url: undefined,
      text: undefined,
      key: undefined,
      credentialId: undefined,
      allowExternal: undefined,
      visible: undefined,
      milliseconds: undefined,
      deltaY: undefined,
    })
  })

  test("rejects unknown commands and oversized context ids", () => {
    expect(() => parseBrowserAgentInput({ contextId: "session-1", command: "executeJavaScript" })).toThrow()
    expect(() => parseBrowserAgentInput({ contextId: "x".repeat(300), command: "observe" })).toThrow()
  })

  test("accepts the visible browser's reading commands and ref handles from observe", () => {
    for (const command of ["readPage", "observePage", "clickRef"])
      expect(parseBrowserAgentInput({ contextId: "ses_1", command, ref: "ref_12" })).toMatchObject({
        command,
        ref: "ref_12",
      })
    for (const ref of ["ref_", "ref_12345", "#submit", "ref_1; alert(1)", 12])
      expect(() => parseBrowserAgentInput({ contextId: "ses_1", command: "clickRef", ref })).toThrow(
        "Invalid browser ref.",
      )
  })

  test("an empty ref or tab is no handle, so a model that fills every field still opens a page (B19)", () => {
    expect(
      parseBrowserAgentInput({
        contextId: "ses_1",
        command: "openUrl",
        url: "http://localhost:3000",
        ref: "",
        tabId: "",
      }),
    ).toMatchObject({ command: "openUrl", url: "http://localhost:3000", ref: undefined, tabId: undefined })
    expect(
      parseBrowserAgentInput({ contextId: "ses_1", command: "click", selector: "#go", ref: "" }).ref,
    ).toBeUndefined()
    expect(() => parseBrowserAgentInput({ contextId: "ses_1", command: "clickRef", ref: " " })).toThrow(
      "Invalid browser ref.",
    )
  })

  test("accepts the tab, form, hover and log commands with their bounded fields", () => {
    expect(
      parseBrowserAgentInput({
        contextId: "ses_1",
        command: "selectOption",
        ref: "ref_4",
        values: ["eu-west", "Frankfurt"],
        expectOrigin: "http://localhost:3000",
        settle: false,
      }),
    ).toMatchObject({
      command: "selectOption",
      ref: "ref_4",
      values: ["eu-west", "Frankfurt"],
      expectOrigin: "http://localhost:3000",
      settle: false,
    })
    expect(
      parseBrowserAgentInput({
        contextId: "ses_1",
        command: "clickRef",
        ref: "ref_2",
        expectOrigin: "https://shop.example.com",
        expectLabel: "Pay now",
      }),
    ).toMatchObject({ expectOrigin: "https://shop.example.com", expectLabel: "Pay now" })
    for (const command of ["switchTab", "closeTab"])
      expect(parseBrowserAgentInput({ contextId: "ses_1", command, tabId: "tab_12" })).toMatchObject({
        command,
        tabId: "tab_12",
      })
    expect(
      parseBrowserAgentInput({ contextId: "ses_1", command: "typeRef", ref: "ref_3", text: "heat pumps" }),
    ).toMatchObject({ command: "typeRef", ref: "ref_3", text: "heat pumps" })
    for (const command of ["hover", "listTabs", "openTab", "readLogs"])
      expect(parseBrowserAgentInput({ contextId: "ses_1", command }).command).toBe(command)
  })

  test("rejects a bad tab handle, oversized values and overlong expectations", () => {
    for (const tabId of ["tab_", "tab_12345", "ref_1", "tab_1 ", 3])
      expect(() => parseBrowserAgentInput({ contextId: "ses_1", command: "switchTab", tabId })).toThrow(
        "Invalid browser tab.",
      )
    for (const values of ["eu-west", Array(33).fill("a"), ["x".repeat(1_025)], [7], [null]])
      expect(() =>
        parseBrowserAgentInput({ contextId: "ses_1", command: "selectOption", ref: "ref_1", values }),
      ).toThrow("Invalid browser values.")
    expect(
      parseBrowserAgentInput({ contextId: "ses_1", command: "selectOption", values: Array(32).fill("a") }).values,
    ).toHaveLength(32)
    expect(() =>
      parseBrowserAgentInput({ contextId: "ses_1", command: "click", selector: "#a", expectOrigin: "x".repeat(2_049) }),
    ).toThrow("Invalid browser expectOrigin.")
    expect(() =>
      parseBrowserAgentInput({ contextId: "ses_1", command: "click", selector: "#a", expectLabel: "x".repeat(301) }),
    ).toThrow("Invalid browser expectLabel.")
    expect(() =>
      parseBrowserAgentInput({ contextId: "ses_1", command: "click", selector: "#a", settle: "no" }),
    ).toThrow("Invalid browser settle.")
  })

  test("JavaScript evaluation stays an unknown command, whatever fields come with it", () => {
    for (const command of ["executeJavaScript", "evaluate", "runScript"])
      expect(() =>
        parseBrowserAgentInput({ contextId: "ses_1", command, text: "document.cookie", tabId: "tab_1", settle: false }),
      ).toThrow("Unknown browser command.")
  })

  test("a research command sent as a visible-browser command fails", () => {
    expect(() =>
      parseBrowserAgentInput({ contextId: "run_1:ses_researcher", command: "research.read", runID: "run_1" }),
    ).toThrow("Unknown browser command.")
  })
})

describe("research browser input", () => {
  const valid = {
    command: "research.open",
    runID: "run_01J9ZK",
    sessionID: "ses_researcher_2",
    rootID: "ses_lead",
    agent: "researcher",
    max: 3,
    images: false,
    provenance: ["https://journal.example/study"],
    typed: ["https://typed.example/"],
    url: "https://journal.example/study",
  }

  test("accepts a bounded research command", () => {
    expect(parseResearchBrowserInput(valid)).toEqual(valid)
    expect(
      parseResearchBrowserInput({
        command: "research.type",
        runID: "r",
        sessionID: "s",
        agent: "research",
        max: 1,
        ref: "ref_3",
        text: "heat pumps",
      }),
    ).toEqual({
      command: "research.type",
      runID: "r",
      sessionID: "s",
      agent: "research",
      max: 1,
      ref: "ref_3",
      text: "heat pumps",
    })
  })

  test("a visible-browser command sent as a research command fails", () => {
    expect(() => parseResearchBrowserInput({ ...valid, contextId: "ses_lead" })).toThrow(
      "Research browser commands take no contextId.",
    )
    expect(() => parseResearchBrowserInput({ contextId: "ses_lead", command: "openUrl", url: valid.url })).toThrow()
    expect(() => parseResearchBrowserInput({ ...valid, command: "openUrl" })).toThrow(
      "Unknown research browser command.",
    )
    expect(() => parseResearchBrowserInput({ ...valid, command: "inspectPageHtml" })).toThrow(
      "Unknown research browser command.",
    )
    expect(() => parseResearchBrowserInput({ ...valid, selector: "#q" })).toThrow(
      "Research browser commands take no selector.",
    )
  })

  test("takes the run and the session as plain IDs only", () => {
    for (const id of ["", "run:1", "run 1", "../run", "r".repeat(65), "ses_1\n", 7]) {
      expect(() => parseResearchBrowserInput({ ...valid, runID: id })).toThrow("Invalid research browser runID.")
      expect(() => parseResearchBrowserInput({ ...valid, sessionID: id })).toThrow(
        "Invalid research browser sessionID.",
      )
      expect(() => parseResearchBrowserInput({ ...valid, rootID: id })).toThrow("Invalid research browser rootID.")
    }
    expect(() => parseResearchBrowserInput({ ...valid, runID: undefined })).toThrow("Invalid research browser runID.")
  })

  test("bounds the agent, the run's count, its addresses and every text", () => {
    expect(() => parseResearchBrowserInput({ ...valid, agent: "build" })).toThrow("Invalid research browser agent.")
    for (const max of [0, MAX_RESEARCH_BROWSERS + 1, 1.5, "3"])
      expect(() => parseResearchBrowserInput({ ...valid, max })).toThrow("Invalid research browser count.")
    for (const provenance of [
      ["file:///etc/passwd"],
      ["javascript:alert(1)"],
      [7],
      "https://a.example/",
      Array(5_001).fill("https://a.example/"),
    ])
      expect(() => parseResearchBrowserInput({ ...valid, provenance })).toThrow("Invalid research browser provenance.")
    expect(() => parseResearchBrowserInput({ ...valid, typed: ["data:text/html,hi"] })).toThrow(
      "Invalid research browser typed.",
    )
    expect(() => parseResearchBrowserInput({ ...valid, text: "x".repeat(2_001) })).toThrow("Invalid browser text.")
    expect(() => parseResearchBrowserInput({ ...valid, ref: "#q" })).toThrow("Invalid browser ref.")
    expect(parseResearchBrowserInput({ ...valid, ref: "" })).not.toHaveProperty("ref")
    expect(() => parseResearchBrowserInput({ ...valid, images: "yes" })).toThrow("Invalid browser images.")
    expect(() => parseResearchBrowserInput({ ...valid, generation: "a b" })).toThrow(
      "Invalid research browser generation.",
    )
    expect(() => parseResearchBrowserInput([valid])).toThrow("Invalid research browser command.")
  })

  test("a search takes its words, a period, a count and the engines it may reach, and nothing else", () => {
    const search = { command: "research.search", runID: "r", sessionID: "s", agent: "researcher", max: 3 }
    expect(
      parseResearchBrowserInput({
        ...search,
        query: "heat pumps site:nature.com",
        recency: "week",
        limit: 8,
        engines: ["duckduckgo", "google"],
      }),
    ).toEqual({
      ...search,
      query: "heat pumps site:nature.com",
      recency: "week",
      limit: 8,
      engines: ["google", "duckduckgo"],
    })
    // No address: the desktop builds the results page itself.
    expect(() => parseResearchBrowserInput({ ...search, query: "x", page: "https://evil.example/" })).toThrow(
      "Research browser commands take no page.",
    )
    expect(() => parseResearchBrowserInput({ ...search, query: "x".repeat(601) })).toThrow("Invalid browser query.")
    for (const recency of ["hour", 1])
      expect(() => parseResearchBrowserInput({ ...search, recency })).toThrow("Invalid research browser recency.")
    for (const limit of [0, 21, 2.5, "8"])
      expect(() => parseResearchBrowserInput({ ...search, limit })).toThrow("Invalid research browser limit.")
    for (const engines of [[], ["bing"], ["google", "google"], "google"])
      expect(() => parseResearchBrowserInput({ ...search, engines })).toThrow("Invalid research browser engines.")
  })
})
