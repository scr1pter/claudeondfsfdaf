import { describe, expect, test } from "bun:test"
import {
  ABOUT,
  ERASE_SESSION,
  FACETS,
  IMPORTED,
  MEMORY_TABS,
  MODEL_LEARNER,
  UNDO_DAYS,
  aboutYou,
  approvable,
  approvableImports,
  cameFrom,
  editable,
  entryText,
  exportName,
  facetOf,
  fileLabel,
  forgettable,
  holdLabel,
  importNotice,
  kindLabel,
  learnedWhen,
  originLabel,
  pinnable,
  rejectable,
  savedNotice,
  summary,
  undoable,
  UNDONE,
  usage,
  type MemoryEntryView,
} from "./memory-model"

const files = {
  memory: "/Users/a/.config/vector/MEMORY.md",
  rules: "/Users/a/.config/vector/RULES.md",
  repository: ["/repo/.vector/RULES.md"],
}

describe("memory page model", () => {
  test("says where each entry comes from", () => {
    expect(originLabel({ origin: "agent", scope: "repository" })).toBe("Vector learned this")
    expect(originLabel({ origin: "user", scope: "personal" })).toBe("You added this")
    expect(originLabel({ origin: "failure-memory", scope: "repository" })).toBe("Failure memory from checks Vector ran")
    expect(originLabel({ origin: "import", scope: "personal" })).toBe("You imported this")
    expect(originLabel({ origin: "file", scope: "personal", source: { file: files.memory } }, files)).toBe(
      "From your MEMORY.md",
    )
    expect(originLabel({ origin: "file", scope: "personal", source: { file: files.rules } }, files)).toBe(
      "From your RULES.md",
    )
    expect(
      originLabel({ origin: "file", scope: "repository", source: { file: "/repo/.vector/RULES.md" } }, files),
    ).toBe("From the repository's .vector/RULES.md")
    expect(originLabel({ origin: "file", scope: "repository", source: { file: "/repo/BRAIN.md" } }, files)).toBe(
      "From the repository's BRAIN.md (read-only)",
    )
  })

  test("only lets the page change what Vector or the user saved, and files stay theirs", () => {
    expect(editable({ origin: "agent" })).toBe(true)
    expect(editable({ origin: "user" })).toBe(true)
    expect(editable({ origin: "file" })).toBe(false)
    expect(editable({ origin: "failure-memory" })).toBe(false)
    expect(forgettable({ origin: "file" })).toBe(false)
    expect(forgettable({ origin: "failure-memory" })).toBe(true)
  })

  test("names files the short way and pins only what pinning changes", () => {
    expect(fileLabel(files.memory, files, "/repo")).toBe("your MEMORY.md")
    expect(fileLabel("/repo/.vector/RULES.md", files, "/repo")).toBe(".vector/RULES.md")
    expect(fileLabel("/elsewhere/BRAIN.md", files, "/repo")).toBe("BRAIN.md")
    expect(pinnable({ kind: "rule", status: "active" })).toBe(false)
    expect(pinnable({ kind: "review", status: "active" })).toBe(false)
    expect(pinnable({ kind: "lesson", status: "active" })).toBe(true)
    expect(pinnable({ kind: "lesson", status: "quarantined" })).toBe(false)
  })

  test("offers approval only where approving can work", () => {
    expect(approvable({ status: "quarantined", origin: "agent", hold: "web" })).toBe(true)
    expect(approvable({ status: "proposed", origin: "agent" })).toBe(true)
    expect(approvable({ status: "active", origin: "agent" })).toBe(false)
    // A repository's memory waits on trusting the repository, and hidden characters on fixing the file.
    expect(approvable({ status: "quarantined", origin: "file", hold: "untrusted-repository" })).toBe(false)
    expect(approvable({ status: "quarantined", origin: "file", hold: "hidden-unicode" })).toBe(false)
    expect(approvable({ status: "quarantined", origin: "file", hold: "instruction-like" })).toBe(true)
    expect(rejectable({ status: "quarantined", origin: "file" })).toBe(false)
    expect(rejectable({ status: "quarantined", origin: "agent" })).toBe(true)
  })

  test("explains every reason memory waits", () => {
    for (const hold of [
      "web",
      "mcp",
      "subagent",
      "untrusted-repository",
      "guest",
      "instruction-like",
      "hidden-unicode",
      "hidden-text",
      "suggested",
      undefined,
    ] as const)
      expect(holdLabel(hold).length).toBeGreaterThan(20)
    // Only an earlier version left proposals, and they wait for the user; a fetching command holds memory like the web.
    expect(holdLabel(undefined)).toContain("An earlier version")
    expect(holdLabel(undefined)).toContain("once you approve it")
    expect(holdLabel(undefined)).not.toContain("later session")
    expect(holdLabel("web")).toContain("reaches outside this computer")
    expect(holdLabel("mcp")).toContain("an MCP server's prompt")
    expect(kindLabel("failure")).toBe("Past failure")
    expect(kindLabel("term")).toBe("Term")
    expect(kindLabel("skill")).toBe("Learned skill")
  })

  test("sums up memory and its cost in plain words", () => {
    expect(summary({ active: 12, review: 2, archived: 0, digestTokens: 148 })).toBe(
      "12 in use · 2 to review · about 148 tokens in every request",
    )
    expect(summary({ active: 0, review: 0, archived: 0, digestTokens: 0 })).toBe(
      "0 in use · nothing added to requests until there is memory",
    )
    const now = Date.UTC(2026, 9, 18)
    expect(usage({ uses: 0 }, now)).toBe("Not used yet")
    expect(usage({ uses: 3, lastUsedAt: now - 2 * 86_400_000 }, now)).toBe("Used 3 times, last 2 days ago")
  })

  test("never says project", () => {
    const strings = [
      ...[
        "web",
        "mcp",
        "subagent",
        "untrusted-repository",
        "guest",
        "instruction-like",
        "hidden-unicode",
        "hidden-text",
        "suggested",
      ].map((hold) => holdLabel(hold as never)),
      UNDONE,
      summary({ active: 1, review: 1, archived: 1, digestTokens: 1 }),
      originLabel({ origin: "file", scope: "repository", source: { file: "/repo/BRAIN.md" } }),
    ]
    for (const text of strings) expect(text.toLowerCase()).not.toContain("project")
  })

  test("after Undo, says Vector will not learn it again and where to bring it back", () => {
    expect(UNDONE).toContain("will not learn it again")
    expect(UNDONE).toContain("restore it from Archived")
  })

  test("after adding, says what the engine kept rather than what was typed", () => {
    const now = 1_760_000_000_000
    expect(savedNotice({ text: "Use pnpm.", status: "active", createdAt: now, updatedAt: now }, "Use pnpm.")).toBe(
      "Saved. Vector will use it when it is relevant.",
    )
    expect(
      savedNotice({ text: "Use pnpm.", status: "active", createdAt: now - 86_400_000, updatedAt: now }, "use pnpm"),
    ).toBe('This was already in memory, and it is in use: "Use pnpm."')
    expect(
      savedNotice(
        { text: "Deploy key is [redacted].", status: "active", createdAt: now, updatedAt: now },
        "Deploy key is ghp_x",
      ),
    ).toBe("Saved without the secret it contained. Vector will use it when it is relevant.")
  })

  test("splits the page into Memory, Skills, About you, Workflow insights, Documents and Research", () => {
    expect(MEMORY_TABS.map((item) => item.label)).toEqual([
      "Memory",
      "Skills",
      "About you",
      "Workflow insights",
      "Documents",
      "Research",
      "Search model",
    ])
    for (const item of MEMORY_TABS) expect(item.label.toLowerCase()).not.toContain("project")
  })

  test("says why a learned or imported entry without a hold waits, in place of the earlier version's words", () => {
    expect(holdLabel(undefined, "import")).toBe(IMPORTED)
    expect(IMPORTED).toBe("Imported items wait for your approval.")
    expect(holdLabel(undefined, "agent")).toContain("once you approve it")
    expect(holdLabel(undefined, "agent")).toContain("longer message")
    // A hold still says its own reason, whoever wrote the entry.
    expect(holdLabel("web", "import")).toBe(holdLabel("web"))
    expect(holdLabel(undefined, "user")).toContain("An earlier version")
  })
})

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 23)

function entry(input: Partial<MemoryEntryView> & Pick<MemoryEntryView, "id">): MemoryEntryView {
  return {
    scope: "personal",
    kind: "preference",
    origin: "agent",
    status: "active",
    pinned: false,
    text: "Use tables for comparisons.",
    paths: [],
    uses: 0,
    stale: false,
    createdAt: now - DAY,
    updatedAt: now - DAY,
    ...input,
  }
}

describe("About you", () => {
  test("groups what Vector learned about you by facet, with a group for every facet", () => {
    const groups = aboutYou([
      entry({ id: "m1", facet: "format", text: "Use tables for comparisons.", createdAt: now - 2 * DAY }),
      entry({ id: "m2", facet: "format", text: "Keep answers short.", createdAt: now - DAY }),
      entry({ id: "m3", kind: "term", facet: "vocabulary", text: "When I say ship it, I mean merge after CI." }),
      entry({ id: "m4", facet: "workflow", text: "Always open a pull request." }),
      entry({ id: "m5", kind: "preference", text: "Prefer short commit messages." }),
      entry({ id: "m6", kind: "fact", text: "Works in Berlin.", origin: "user" }),
      entry({ id: "m7", facet: "sources", status: "proposed", origin: "import", text: "Prefer primary sources." }),
    ])
    expect(groups.map((group) => group.value)).toEqual([
      "format",
      "workflow",
      "vocabulary",
      "tooling",
      "sources",
      "style",
      "other",
    ])
    const by = Object.fromEntries(groups.map((group) => [group.value, group.entries.map((item) => item.id)]))
    // Newest first within a group.
    expect(by.format).toEqual(["m2", "m1"])
    expect(by.workflow).toEqual(["m4"])
    expect(by.vocabulary).toEqual(["m3"])
    expect(by.tooling).toEqual([])
    expect(by.sources).toEqual(["m7"])
    // A preference saved before facets existed is style; a fact no facet covers is with the other things about you.
    expect(by.style).toEqual(["m5"])
    expect(by.other).toEqual(["m6"])
    expect(FACETS.map((facet) => facet.value)).toEqual([
      "format",
      "workflow",
      "vocabulary",
      "tooling",
      "sources",
      "style",
    ])
  })

  test("lists only what Vector learned, the user added or imported about them, in use or waiting", () => {
    const groups = aboutYou([
      entry({ id: "keep" }),
      entry({ id: "repo", scope: "repository" }),
      entry({ id: "rule", kind: "rule", origin: "file" }),
      entry({ id: "file", kind: "fact", origin: "file", source: { file: "/Users/a/.config/vector/MEMORY.md" } }),
      entry({ id: "review", kind: "review" }),
      entry({ id: "failure", kind: "failure", origin: "failure-memory" }),
      entry({ id: "undone", status: "archived" }),
      entry({ id: "old", status: "superseded" }),
      entry({ id: "held", status: "quarantined", hold: "web" }),
    ])
    expect(groups.flatMap((group) => group.entries.map((item) => item.id))).toEqual(["keep", "held"])
    // Nothing outside a facet: no "other" group.
    expect(groups.some((group) => group.value === "other")).toBe(false)
  })

  test("shows a term as what the user means by it", () => {
    expect(
      entryText(
        entry({
          id: "t",
          kind: "term",
          text: "When I say ship it, I mean open a PR, wait for CI, then merge.",
          term: { key: "ship it", meaning: "open a PR, wait for CI, then merge." },
        }),
      ),
    ).toBe('When you say "ship it" you mean: open a PR, wait for CI, then merge.')
    expect(entryText(entry({ id: "p", text: "Use pnpm." }))).toBe("Use pnpm.")
    expect(facetOf({ kind: "term" })).toBe("vocabulary")
    expect(facetOf({ kind: "lesson" })).toBeUndefined()
  })

  test("offers Undo on what Vector learned for 7 days, then Forget", () => {
    expect(UNDO_DAYS).toBe(7)
    expect(undoable(entry({ id: "a", createdAt: now - DAY }), now)).toBe(true)
    expect(undoable(entry({ id: "a", createdAt: now - 7 * DAY }), now)).toBe(true)
    expect(undoable(entry({ id: "a", createdAt: now - 7 * DAY - 1 }), now)).toBe(false)
    // What the user added, imported, or what waits for review is theirs to forget or reject, not undo.
    expect(undoable(entry({ id: "a", origin: "user" }), now)).toBe(false)
    expect(undoable(entry({ id: "a", origin: "import" }), now)).toBe(false)
    expect(undoable(entry({ id: "a", status: "proposed" }), now)).toBe(false)
    expect(forgettable({ origin: "agent" })).toBe(true)
    expect(learnedWhen(entry({ id: "a", createdAt: now - 3 * DAY }), now)).toBe("Vector learned this 3 days ago")
    expect(learnedWhen(entry({ id: "a", origin: "import", createdAt: now }), now)).toBe("You imported this today")
    expect(learnedWhen(entry({ id: "a", origin: "user", createdAt: now - DAY }), now)).toBe("You added this yesterday")
  })

  test("shows the words an item came from only when they say more, and the session it was learned in", () => {
    const item = entry({ id: "q", text: "Use tables for comparisons." })
    expect(cameFrom(item, [{ type: "message", quote: "use tables for comparisons", sessionID: "ses_1" }])).toEqual({
      sessionID: "ses_1",
    })
    expect(
      cameFrom(item, [{ type: "message", quote: "no, I meant put comparisons in a table", sessionID: "ses_2" }]),
    ).toEqual({ quote: "no, I meant put comparisons in a table", sessionID: "ses_2" })
    expect(cameFrom(item, [{ type: "user" }])).toEqual({})
  })

  test("an import lands waiting, and Approve all takes only what waits for nothing but approval", () => {
    const entries = [
      entry({ id: "i1", origin: "import", status: "proposed" }),
      entry({ id: "i2", origin: "import", status: "quarantined", hold: "instruction-like" }),
      entry({ id: "i3", origin: "import", status: "proposed", hold: "hidden-unicode" }),
      entry({ id: "a1", origin: "agent", status: "proposed" }),
      entry({ id: "i4", origin: "import", status: "active" }),
    ]
    expect(approvableImports(entries).map((item) => item.id)).toEqual(["i1"])
    expect(importNotice({ entries: [1, 2], known: 1, refused: 3, over: 0 })).toBe(
      "Imported 2 items. Imported items wait for your approval. 1 was already in memory. 3 were left out: forgotten before, a secret, too long, or past what may wait for review.",
    )
    expect(importNotice({ entries: [], known: 4, refused: 0, over: 0 })).toBe(
      "Nothing new to import. 4 were already in memory.",
    )
    expect(importNotice({ entries: [1], known: 0, refused: 0, over: 7 })).toContain(
      "7 past the 500 one import brings in were left out.",
    )
    expect(exportName("personal", "markdown")).toBe("vector-memory-about-you.md")
    expect(exportName("all", "json")).toBe("vector-memory-all.json")
  })

  test("words its copy as the copy deck does, with no promise it cannot keep", () => {
    expect(ABOUT.title).toBe("What Vector learned about you")
    expect(ABOUT.intro).toContain("Each item shows the words it came from.")
    expect(ABOUT.sensitive).toBe("Vector tries not to keep sensitive personal details.")
    expect(ABOUT.erase).toBe(
      "Erase removes it from the brain and stops Vector using it. The sessions it came from keep their messages until you delete them. A model server you host may keep its own logs.",
    )
    expect(ABOUT.agents).toContain("Sessions with invited guests, and free models that may train on your prompts")
    expect(ABOUT.agents).toContain("Reviews and research see how you work, not facts about you.")
    // Vector Local is in the app as well as the CLI now (Settings > Vector Local), so the copy no longer limits it.
    expect(ABOUT.storage).toBe(
      "Your brain is a file on this computer (brain.db). You can see, change, export or erase everything in it. With Vector Local on, its contents go only to the model servers you list, and the network log shows which requests carried them.",
    )
    const strings = [
      ...Object.values(ABOUT),
      ERASE_SESSION.action,
      ERASE_SESSION.there,
      ERASE_SESSION.confirm,
      ERASE_SESSION.done(0),
      ERASE_SESSION.done(2),
      IMPORTED,
      ...FACETS.flatMap((facet) => [facet.label, facet.description]),
      ...MODEL_LEARNER.map((item) => item.label),
      holdLabel(undefined, "agent"),
    ]
    for (const text of strings) {
      const lower = text.toLowerCase()
      for (const banned of [
        "project",
        "exactly",
        "never exceeds",
        "absolute privacy",
        "controlled only by you",
        "completely in your control",
      ])
        expect(lower).not.toContain(banned)
    }
    expect(ERASE_SESSION.done(1)).toBe("Erased 1 thing Vector learned only in this session.")
    expect(ERASE_SESSION.confirm).toContain("The session keeps its messages until you delete it.")
    // The engine forgets the session's research with what it learned there, so the confirmation says so.
    expect(ERASE_SESSION.confirm).toContain(
      "and does not learn it again. It also forgets the Deep research runs the session started.",
    )
  })
})
