import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Computer } from "@vectordevai/schema/computer"
import { SessionTaskSize } from "../../src/session/task-size"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

// The history fold on its own: which request a message belongs to, and what size each request is sent at.

const sessionID = SessionID.make("ses_task-size-history")
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
let clock = 1_000

function user(
  text: string,
  extra: { synthetic?: boolean; judge?: SessionV1.User["judge"]; at?: number; agent?: string } = {},
) {
  const id = MessageID.ascending()
  clock = extra.at ?? clock + 1_000
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: clock },
      agent: extra.agent ?? "build",
      model,
      ...(extra.judge ? { judge: extra.judge } : {}),
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text, synthetic: extra.synthetic }],
  } as SessionV1.WithParts
}

function assistant(
  text: string,
  finish = "stop",
  tools: { tool: string; metadata?: Record<string, unknown> }[] = [],
  agent = "build",
) {
  const id = MessageID.ascending()
  clock += 1_000
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: id,
      mode: agent,
      agent,
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID,
      providerID: model.providerID,
      time: { created: clock, completed: clock },
      finish,
    },
    parts: [
      { id: PartID.ascending(), sessionID, messageID: id, type: "text", text },
      ...tools.map((item) => ({
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "tool",
        callID: "call",
        tool: item.tool,
        state: {
          status: "completed",
          input: {},
          output: "",
          title: "",
          metadata: item.metadata ?? {},
          time: { start: 1, end: 2 },
        },
      })),
    ],
  } as SessionV1.WithParts
}

const size = (messages: SessionV1.WithParts[], caching = false, lifetime = 60_000) =>
  SessionTaskSize.size({ messages, caching, lifetime })

// A reply that wrote a file, as a completed write call.
function wrote(file: string, text = "Wrote it.", finish = "tool-calls") {
  const message = assistant(text, finish, [{ tool: "write" }])
  const part = message.parts.find((item) => item.type === "tool")
  if (part?.type === "tool" && part.state.status === "completed") part.state.input = { filePath: file }
  return message
}

// Vector's judge run, as the task card it records on an assistant message.
function judgedBy(verdict: string, workSize?: string) {
  const message = assistant(`VERDICT: ${verdict}`, verdict === "FAIL" ? "tool-calls" : "stop", [{ tool: "task" }])
  const part = message.parts.find((item) => item.type === "tool")
  if (part?.type === "tool") part.metadata = { judge: { round: 1, verdict, ...(workSize ? { size: workSize } : {}) } }
  return message
}

// The compaction marker a summary answers, with what the runner recorded of the request it summarised.
function marker(carried?: SessionTaskSize.Carried) {
  const message = user("")
  message.parts = [
    { id: PartID.ascending(), sessionID, messageID: message.info.id, type: "compaction", auto: true },
    ...(carried
      ? [
          {
            id: PartID.ascending(),
            sessionID,
            messageID: message.info.id,
            type: "text" as const,
            text: "recorded",
            synthetic: true,
            ignored: true,
            metadata: { [SessionTaskSize.CARRIED]: carried },
          },
        ]
      : []),
  ]
  return message
}

function recorded(part: SessionV1.Part): SessionTaskSize.Carried[] {
  return part.type === "text" && part.metadata?.[SessionTaskSize.CARRIED]
    ? [part.metadata[SessionTaskSize.CARRIED]]
    : []
}

function summary(parent: SessionV1.WithParts) {
  const message = assistant("Summary of the work so far.")
  if (message.info.role === "assistant") {
    message.info.summary = true
    message.info.parentID = parent.info.id
  }
  return message
}

// Large work, as the user asks for it: Thorough comes only from the user's ask, escalate or a continuation of it.
const LARGE = "be thorough: migrate the app to the new router across 40 files"
// A request of its own after finished work: too long to read as a follow-up.
const UNRELATED = "add a settings page with a dark mode toggle, tests for the parser and a new billing flow"

describe("SessionTaskSize.size", () => {
  test("only a valid, active computer mention keeps a social request on the work harness", () => {
    const marked = (marker: unknown, patch: Record<string, unknown> = {}) => {
      const message = user("hi")
      message.parts.push({
        id: PartID.ascending(),
        sessionID,
        messageID: message.info.id,
        type: "text",
        text: "",
        synthetic: true,
        metadata: { [Computer.MENTION_KEY]: marker },
        ...patch,
      } as SessionV1.Part)
      return message
    }
    for (const marker of [{ kind: "feature" }, { kind: "app", key: "app:macos:com.apple.notes", name: "Notes" }]) {
      expect(size([marked(marker)]).at(-1)?.tier).toBe("standard")
      expect(size([marked(marker)]).at(-1)?.offered).toBe("standard")
      expect(size([marked(marker, { ignored: true })]).at(-1)?.tier).toBe("chat")
      expect(size([marked(marker, { synthetic: false })]).at(-1)?.tier).toBe("chat")
      expect(size([marked(marker, { text: "hidden instruction" })]).at(-1)?.tier).toBe("chat")
    }
    expect(size([marked({ kind: "app", key: "not-an-app", name: "Notes" })]).at(-1)?.tier).toBe("chat")
    expect(size([marked({ kind: "unknown" })]).at(-1)?.tier).toBe("chat")
    expect(size([user("hi")]).at(-1)?.tier).toBe("chat")
  })

  test("a message sent while the run is going joins its request and can only raise it", () => {
    const requests = size([
      user("fix the typo in README.md"),
      assistant("Reading it.", "tool-calls", [{ tool: "read" }]),
      user("actually, be thorough and check every page"),
      assistant("Done."),
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.users).toHaveLength(2)
    expect(requests[0]?.tier).toBe("thorough")
  })

  test("a completed escalate call raises Work to Thorough, and a reply to it stays there", () => {
    const requests = size([
      user("switch the codebase to Go"),
      assistant("This touches every package.", "tool-calls", [
        { tool: "escalate", metadata: { from: "standard", to: "thorough" } },
      ]),
      assistant("Ported the first package. Should I go on with the rest?"),
      user("yes"),
      assistant("Ported every package."),
      user("thanks"),
      assistant("You're welcome!"),
    ])
    expect(requests.map((request) => [request.result.tier, request.tier])).toEqual([
      ["standard", "thorough"],
      ["thorough", "thorough"],
      ["chat", "chat"],
    ])
    expect(requests[0]?.escalated).toBe(true)
  })

  test("the user's no subagents or don't be thorough holds against escalate", () => {
    for (const text of [
      "migrate the app to the new router across 40 files, no subagents",
      "don't be thorough, just migrate the app to the new router across 40 files",
    ]) {
      const requests = size([
        user(text),
        assistant("This touches every route.", "tool-calls", [
          { tool: "escalate", metadata: { from: "standard", to: "thorough" } },
        ]),
        assistant("Migrated the routes."),
      ])
      expect(requests[0]?.tier, text).toBe("standard")
      expect(requests[0]?.escalated, text).toBe(false)
      expect(SessionTaskSize.capped(requests[0]!.result), text).toBe(true)
    }
  })

  test("Thorough ends with its run: a new request after finished Thorough work is Work of its own", () => {
    const migrated = [
      user(LARGE, { judge: "thorough" }),
      wrote("/r/router.ts"),
      assistant("Migrated all 40 files."),
      judgedBy("PASS", "thorough"),
      user("thanks", { judge: "thorough" }),
      assistant("You're welcome!"),
    ]
    for (const text of [
      "ship to vercel",
      "fix the typo in README",
      "yes",
      "quick question: what does parseArgs do?",
      "no, keep the old routes working",
    ]) {
      const after = MessageID.ascending()
      const requests = size([
        ...migrated,
        user(text, { judge: "thorough" }),
        wrote("/r/vercel.json"),
        assistant("Done."),
      ])
      expect(requests.at(-1)?.result, text).toMatchObject({ tier: "standard", source: "auto" })
      // Work in "Large tasks" mode is not judged, and the migration already has its verdict.
      expect(SessionTaskSize.judgeable(requests, after), text).toBeUndefined()
    }
    // The chain ends there: the next short request after it is Work too.
    const chained = size([
      ...migrated,
      user("ship to vercel"),
      wrote("/r/vercel.json"),
      assistant("Deployed."),
      user("fix the typo in README"),
    ])
    expect(chained.slice(-2).map((request) => request.tier)).toEqual(["standard", "standard"])
    // Only an explicit carry-on continues the migration at its size.
    for (const text of ["continue with phase 2", "keep going", "do the rest of the files"])
      expect(size([...migrated, user(text)]).at(-1)?.result, text).toMatchObject({
        tier: "thorough",
        source: "inherited",
      })
    // An answer to the agent's question continues the work; the request after the answer is sized fresh.
    const answered = size([
      user(LARGE),
      wrote("/r/router.ts"),
      assistant("Migrated the router. Should I also remove the old API?"),
      user("no"),
      assistant("Kept the old API."),
      user("ship to vercel"),
    ])
    expect(answered.map((request) => request.tier)).toEqual(["thorough", "thorough", "standard"])
  })

  test("a closing line or an offer without a question mark leaves nothing open after Thorough work", () => {
    for (const closing of [
      "Migrated the router. Let me know if this works for you.",
      "Migrated the router. Let me know if you'd like me to make any other changes.",
      "Migrated the router. I recommend running the e2e suite before you merge.",
      "Migrated the router. You can confirm by running `bun dev`.",
      "Migrated the router. I can also add tests if you want.",
    ]) {
      const migrated = [user(LARGE, { judge: "thorough" }), wrote("/r/router.ts"), assistant(closing)]
      // The run is judged when it ends: it asked nothing.
      expect(SessionTaskSize.judgeable(size(migrated), migrated[0]!.info.id)?.files, closing).toEqual(["/r/router.ts"])
      const judged = [...migrated, judgedBy("PASS", "thorough")]
      for (const text of ["fix the typo in README", UNRELATED]) {
        const after = MessageID.ascending()
        const requests = size([...judged, user(text, { judge: "thorough" }), wrote("/r/README.md"), assistant("Done.")])
        expect(requests.at(-1)?.result, `${closing} ${text}`).toMatchObject({ tier: "standard", source: "auto" })
        expect(SessionTaskSize.judgeable(requests, after), `${closing} ${text}`).toBeUndefined()
      }
      // A thanks or a greeting after it is a direct reply.
      for (const text of ["thanks", "hi"])
        expect(size([...judged, user(text)]).at(-1)?.tier, `${closing} ${text}`).toBe("chat")
    }
    // An offer with a question mark still waits on the answer.
    const offered = [
      user(LARGE),
      wrote("/r/router.ts"),
      assistant("Migrated the router. Want me to also update the docs?"),
    ]
    expect(size([...offered, user("yes, also update the docs")]).at(-1)?.tier).toBe("thorough")
    expect(size([...offered, user("thanks")]).at(-1)?.tier).toBe("thorough")
  })

  test("after a Thorough review that changed nothing, new requests are Work and the chain ends", () => {
    const reviewed = [
      user("be thorough: review the auth module for security issues", { judge: "thorough" }),
      assistant("Found three issues in the auth module: weak hashing, no rate limit, and a token leak in logs."),
    ]
    const requests = size([
      ...reviewed,
      user("what does parseArgs do?", { judge: "thorough" }),
      assistant("It parses the flags."),
      user("run the tests", { judge: "thorough" }),
      assistant("All tests pass."),
      user("fix the typo in README", { judge: "thorough" }),
      wrote("/r/README.md"),
      assistant("Fixed the typo."),
    ])
    expect(requests.map((request) => request.tier)).toEqual(["thorough", "standard", "standard", "standard"])
    // The typo fix is Work, so "Large tasks" mode does not judge it.
    expect(SessionTaskSize.judgeable(requests, requests.at(-1)!.users[0]!.info.id)).toBeUndefined()
  })

  test("a greeting's reply waits on nothing, so the small talk that answers it stays a direct reply", () => {
    const requests = size([
      user("hey, how are you?"),
      assistant("I'm doing great, thanks for asking! How about you?"),
      user("great, thanks!"),
      assistant("Glad to hear it!"),
    ])
    expect(requests.map((request) => request.tier)).toEqual(["chat", "chat"])
    // A yes to a greeting reply that offered work is still Work with the history.
    const offered = size([user("hi"), assistant("Hi! Want me to look at the failing test?"), user("yes")])
    expect(offered.map((request) => request.tier)).toEqual(["chat", "standard"])
  })

  test("a continue after a thanks exchange continues the work, not the thanks", () => {
    const requests = size([
      user("be thorough and add OAuth login with tests"),
      assistant("Added login."),
      user("thanks"),
      assistant("Anytime!"),
      user("continue"),
    ])
    expect(requests.map((request) => request.tier)).toEqual(["thorough", "chat", "thorough"])
  })

  test("Vector's own follow-ups continue the request they belong to", () => {
    const requests = size([
      user(LARGE),
      assistant("Migrated."),
      user("<vector_judge_verdict>FAIL</vector_judge_verdict>", { synthetic: true }),
      assistant("Repaired."),
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages).toHaveLength(4)
  })

  test("on a caching provider the offered size stays the highest while the cache is warm, and resets once cold", () => {
    const warm = size([user(LARGE), assistant("Done."), user(UNRELATED)], true)
    expect(warm.map((request) => [request.tier, request.offered])).toEqual([
      ["thorough", "thorough"],
      ["standard", "thorough"],
    ])
    const later = clock + 10 * 60_000
    const cold = size([user(LARGE), assistant("Done."), user(UNRELATED, { at: later })], true)
    expect(cold[1]?.offered).toBe("standard")
    // A model without caching always follows the request's own size.
    const free = size([user(LARGE), assistant("Done."), user(UNRELATED)])
    expect(free[1]?.offered).toBe("standard")
  })

  test("the judge setting comes from the prompt, else an older client's policy, else the config", () => {
    expect(size([user("migrate everything", { judge: "changes" })])[0]?.judge).toBe("changes")
    const legacy = user("migrate everything")
    legacy.parts.push({
      id: PartID.ascending(),
      sessionID,
      messageID: legacy.info.id,
      type: "text",
      text: "<vector_verified_completion>LLM-as-a-judge is enabled.",
      synthetic: true,
    })
    expect(size([legacy])[0]?.judge).toBe("thorough")
    expect(
      SessionTaskSize.size({ messages: [user("migrate everything")], caching: false, lifetime: 0, judge: "changes" })[0]
        ?.judge,
    ).toBe("changes")
    expect(size([user("migrate everything")])[0]?.judge).toBe("off")
    // "Skip the judge" in the message wins for that request.
    expect(size([user("be thorough but skip the judge", { judge: "thorough" })])[0]?.judge).toBe("off")
  })

  test("a request whose opening a compaction summarised keeps the size, judge and words it recorded", () => {
    // The opening message is out of view; only the marker, its summary and the continue are left.
    const opening = MessageID.ascending()
    const compaction = marker({
      opened: opening,
      tier: "thorough",
      judge: "thorough",
      text: LARGE,
      files: ["/r/router.ts"],
      agents: [],
    })
    const messages = [
      compaction,
      summary(compaction),
      user("Continue if you have next steps.", { synthetic: true }),
      assistant("Migrated the router."),
    ]
    const requests = size(messages)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tier).toBe("thorough")
    expect(requests[0]?.judge).toBe("thorough")
    expect(SessionTaskSize.requestText(requests[0]!)).toContain("new router")
    // The judge still sees the work the summary replaced.
    expect(SessionTaskSize.judgeable(requests, opening)?.files).toEqual(["/r/router.ts"])
    // A "continue" afterwards continues that work with its size, never as a bare reply.
    const next = size([...messages, user("continue")])
    expect(next.map((request) => request.tier)).toEqual(["thorough", "thorough"])
    // A message that joined the summarised request in the retained tail stays part of it.
    const start = MessageID.ascending()
    const joined = user("also update the docs")
    const reading = assistant("Updating.", "tool-calls", [{ tool: "read" }])
    const later = marker({ ...compaction.parts.flatMap(recorded)[0]!, opened: start })
    const tail = size([later, summary(later), joined, reading])
    expect(tail).toHaveLength(1)
    expect(tail[0]?.users).toHaveLength(1)
    expect(tail[0]?.tier).toBe("thorough")
  })

  test("a continue after a compaction that recorded nothing is work of unknown size, not a bare reply", () => {
    const compaction = marker()
    const requests = size([compaction, summary(compaction), user("continue")])
    expect(requests.at(-1)?.tier).toBe("standard")
    expect(size([compaction, summary(compaction), user("hi")]).at(-1)?.tier).toBe("chat")
  })

  test("the judge checks every request the run answered, and the work a reply continues", () => {
    const since = MessageID.ascending()
    // A message sent during the final step opens its own request after the large one, and continues it: the run had
    // not finished when the user wrote it.
    const large = [user(LARGE, { judge: "thorough" }), wrote("/r/router.ts"), assistant("Migrated the router.")]
    const joined = size([
      ...large,
      user("also fix the typo in README", { judge: "thorough", at: clock - 500 }),
      assistant("Fixed the typo."),
    ])
    expect(joined.map((request) => request.tier)).toEqual(["thorough", "thorough"])
    // Sent after the run finished, the same words are a request of their own.
    expect(size([...large, user("also fix the typo in README")]).at(-1)?.tier).toBe("standard")
    const work = SessionTaskSize.judgeable(joined, since)
    expect(work?.requests).toHaveLength(2)
    expect(work?.files).toEqual(["/r/router.ts"])

    // A yes to the agent's question, in a later run, takes the work it answers to the judge.
    const ask = user(LARGE, { judge: "thorough" })
    const before = [ask, wrote("/r/router.ts"), assistant("Migrated 30 routes. Should I also migrate the tests?")]
    const later = MessageID.ascending()
    const answered = size([...before, user("yes", { judge: "thorough" }), assistant("Migrated the tests.")])
    expect(answered.map((request) => request.tier)).toEqual(["thorough", "thorough"])
    expect(SessionTaskSize.judgeable(answered, later)?.files).toEqual(["/r/router.ts"])
    // A request of its own after finished work is Work, so "thorough" mode does not judge it.
    const done = [ask, wrote("/r/router.ts"), assistant("Migrated all 40 routes.")]
    const next = MessageID.ascending()
    const unrelated = size([...done, user(UNRELATED, { judge: "thorough" }), assistant("Added.")])
    expect(unrelated.map((request) => request.tier)).toEqual(["thorough", "standard"])
    expect(SessionTaskSize.judgeable(unrelated, next)).toBeUndefined()
  })

  test("large work that ended on an offer is judged once the user answers it, and a greeting answers nothing", () => {
    const offer = [
      user(LARGE, { judge: "thorough" }),
      wrote("/r/router.ts"),
      assistant("Migrated all 40 routes and the tests pass. Want me to also update the docs?"),
    ]
    for (const text of ["thanks", "no thanks", "no", "ok thanks"]) {
      const after = MessageID.ascending()
      const requests = size([...offer, user(text, { judge: "thorough" }), assistant("You're welcome!")])
      // Sent while the work waits on the user, it answers that work: never a bare reply.
      expect(requests.at(-1)?.result, text).toMatchObject({ tier: "thorough", source: "inherited" })
      const work = SessionTaskSize.judgeable(requests, after)
      expect(work?.files, text).toEqual(["/r/router.ts"])
      expect(work?.tier, text).toBe("thorough")
      expect(SessionTaskSize.requestText(work!.requests[0]!), text).toContain("new router")
      // The judge sees the offer and the answer, and the work's own report rather than "You're welcome!".
      expect(work?.exchanges, text).toEqual([{ asked: expect.stringContaining("update the docs?"), reply: text }])
      expect(work?.report, text).toContain("Migrated all 40 routes")
    }
    // A greeting answers nothing, so it never brings in the judge; the work waits for the reply that does.
    const greeted = MessageID.ascending()
    expect(
      SessionTaskSize.judgeable(size([...offer, user("hi", { judge: "thorough" }), assistant("Hi!")]), greeted),
    ).toBeUndefined()
    // Once judged, a later thanks has nothing left to judge.
    const judged = [...offer, user("thanks"), assistant("You're welcome!"), judgedBy("PASS", "thorough")]
    const after = MessageID.ascending()
    const done = size([...judged, user("thanks again"), assistant("Anytime!")])
    expect(SessionTaskSize.judgeable(done, after)).toBeUndefined()
  })

  test("a no to the agent's question continues the work at its size, and the judge is told the answer", () => {
    for (const question of [
      "Migrated 20 of 40 routes. Should I convert them to the new loader API?",
      // A yes/no question about the work that reads like an offer is still a question the work turns on.
      "Migrated the router and left the old API in place. Do you want me to keep the old API for compatibility?",
    ]) {
      const later = MessageID.ascending()
      const answered = size([
        user(LARGE, { judge: "thorough" }),
        wrote("/r/router.ts"),
        assistant(question),
        user("no", { judge: "thorough" }),
        wrote("/r/rest.ts"),
        assistant("Done."),
      ])
      expect(answered.at(-1)?.result, question).toMatchObject({ tier: "thorough", source: "inherited" })
      const work = SessionTaskSize.judgeable(answered, later)
      expect(work?.exchanges, question).toEqual([{ asked: question, reply: "no" }])
      expect(work?.files, question).toEqual(["/r/router.ts", "/r/rest.ts"])
    }
  })

  test("an approval or build it after a Thorough plan from Plan mode carries it out at its size", () => {
    for (const text of [
      "build it",
      "build the app",
      "implement the migration",
      "looks good, build it",
      "approved",
      "yes",
    ]) {
      const plan = user("be thorough and plan how to port the TUI to Rust", { judge: "thorough", agent: "plan" })
      const requests = size([
        plan,
        assistant(
          "Here is the plan in three phases: the renderer, the input layer, then the views.",
          "stop",
          [],
          "plan",
        ),
        user(text, { judge: "thorough" }),
        wrote("/r/tui.rs"),
        assistant("Ported the renderer."),
      ])
      expect(
        requests.map((request) => [request.tier, request.result.source]),
        text,
      ).toEqual([
        ["thorough", "user"],
        ["thorough", "inherited"],
      ])
      const work = SessionTaskSize.judgeable(requests, plan.info.id)
      expect(
        work?.requests.map((request) => SessionTaskSize.requestText(request)),
        text,
      ).toEqual(["be thorough and plan how to port the TUI to Rust", text])
    }
    // On the build agent, a plan that asked nothing has ended: "build it" is Work, and the agent can escalate.
    const built = size([
      user("be thorough and plan how to port the TUI to Rust"),
      assistant("Here is the plan in three phases: the renderer, the input layer, then the views."),
      user("build it"),
    ])
    expect(built.at(-1)?.result).toMatchObject({ tier: "standard", source: "auto" })
    // A plan that asked carries on with the answer.
    const asked = size([
      user("be thorough and plan how to port the TUI to Rust"),
      assistant("Here is the plan in three phases. Shall I start with the renderer?"),
      user("build it"),
    ])
    expect(asked.at(-1)?.result).toMatchObject({ tier: "thorough", source: "inherited" })
    // Once Plan mode's plan is carried out, the next request is sized fresh.
    const done = size([
      user("be thorough and plan how to port the TUI to Rust", { agent: "plan" }),
      assistant("Here is the plan.", "stop", [], "plan"),
      user("build it"),
      wrote("/r/tui.rs"),
      assistant("Ported the TUI."),
      user("yes"),
    ])
    expect(done.map((request) => request.tier)).toEqual(["thorough", "thorough", "standard"])
  })

  test("a Chat request the agent escalated is Work: part of what the user asked, and work a reply can continue", () => {
    const requests = size([
      user("thanks for the update"),
      assistant("", "tool-calls", [{ tool: "escalate", metadata: { from: "chat", to: "standard" } }], "quick"),
      wrote("/r/vercel.json"),
      assistant("Deployed. Should I also add a preview alias?"),
      user("thanks"),
    ])
    expect(requests[0]?.result).toMatchObject({ tier: "standard", reasons: ["escalated"] })
    expect(requests[0]?.tier).toBe("standard")
    expect(requests[0]?.escalated).toBe(true)
    // The work asked a question, so the thanks answers it at the work's size.
    expect(requests[1]?.result).toMatchObject({ tier: "standard", source: "inherited" })
    // Without an escalate call a social message stays Chat.
    expect(size([user("thanks for the update"), assistant("You're welcome!", "stop", [], "quick")])[0]?.tier).toBe(
      "chat",
    )
  })

  test("a quick-lane thanks after build work settles it like a thanks on the build agent", () => {
    const after = MessageID.ascending()
    const requests = size([
      user(LARGE, { judge: "thorough" }),
      wrote("/r/router.ts"),
      assistant("Migrated all 40 routes. Want me to also update the docs?"),
      user("thanks", { judge: "thorough", agent: "quick" }),
      assistant("You're welcome!"),
    ])
    const work = SessionTaskSize.judgeable(requests, after)
    expect(work?.files).toEqual(["/r/router.ts"])
    expect(work?.report).toContain("Migrated all 40 routes")
  })

  test("the judge pairs a question with the user's answer, and a greeting is neither an answer nor part of the ask", () => {
    const ask = user(LARGE, { judge: "thorough" })
    const messages = [
      ask,
      wrote("/r/router.ts"),
      assistant("Migrated 20 of 40 routes. Should I convert the rest to the new loader API?"),
      user("hi", { judge: "thorough" }),
      assistant("Hi! Should I convert the rest to the new loader API?"),
      user("thanks", { judge: "thorough" }),
      assistant("You're welcome!"),
      judgedBy("FAIL", "thorough"),
      user("<vector_judge_verdict>FAIL</vector_judge_verdict>", { synthetic: true }),
      wrote("/r/router.ts"),
      assistant("Repaired the router."),
    ]
    const work = SessionTaskSize.judgeable(size(messages), ask.info.id)
    expect(work?.exchanges).toEqual([
      { asked: expect.stringContaining("new loader API?"), reply: "thanks" },
      { asked: expect.stringContaining("new loader API?"), reply: "thanks" },
    ])
    // The thanks answers the agent's question, so it is part of what the user said about the work; the greeting is not.
    expect(work?.requests.map((request) => SessionTaskSize.requestText(request))).toEqual([LARGE, "thanks"])
    expect(work?.tier).toBe("thorough")
    expect(work?.report).toBe("Repaired the router.")
  })

  test("a judge FAIL raises the request it repairs to the size of the work it judged", () => {
    const requests = size([
      user(LARGE, { judge: "thorough" }),
      wrote("/r/router.ts"),
      assistant("Migrated all 40 routes."),
      user("thanks", { judge: "thorough" }),
      assistant("You're welcome!"),
      judgedBy("FAIL", "thorough"),
      user("<vector_judge_verdict>FAIL</vector_judge_verdict>", { synthetic: true }),
    ])
    expect(requests.map((request) => request.tier)).toEqual(["thorough", "thorough"])
    expect(requests[1]?.result.tier).toBe("chat")
  })

  test("a run that did not finish, or a dismissed question, leaves the work open for the next message", () => {
    // Message IDs are ordered, so each message is made in the order it was sent.
    const ask = user(LARGE)
    const interrupted = assistant("Migrating the routes", "tool-calls")
    if (interrupted.info.role === "assistant")
      interrupted.info.error = { name: "MessageAbortedError", data: { message: "Aborted" } }
    const stopped = size([ask, interrupted, user("use the v6 api instead")])
    expect(stopped.map((request) => [request.tier, request.result.source])).toEqual([
      ["thorough", "user"],
      ["thorough", "inherited"],
    ])
    // Even a greeting after unfinished work follows up that work.
    expect(size([user(LARGE), assistant("Migrated 12 of", "length"), user("hi")]).at(-1)?.tier).toBe("thorough")
    const asking = user(LARGE)
    const dismissed = assistant("Which router?", "stop")
    dismissed.parts.push({
      id: PartID.ascending(),
      sessionID,
      messageID: dismissed.info.id,
      type: "tool",
      callID: "question",
      tool: "question",
      state: { status: "error", input: {}, error: "dismissed", time: { start: 1, end: 2 } },
    } as SessionV1.Part)
    expect(size([asking, dismissed, user("the new one")]).at(-1)?.tier).toBe("thorough")
    // A question the user dismissed earlier in the run still leaves the work open.
    const before = user(LARGE)
    const asked = assistant("Asking which router.", "tool-calls")
    asked.parts.push({ ...dismissed.parts.at(-1)!, messageID: asked.info.id } as SessionV1.Part)
    expect(size([before, asked, assistant("Paused."), user("thanks")]).at(-1)?.tier).toBe("thorough")
    // A finished run that asked nothing leaves nothing open: a thanks afterwards is a direct reply.
    expect(size([user(LARGE), assistant("Migrated all 40."), user("thanks")]).at(-1)?.tier).toBe("chat")
  })

  test("a yes to a greeting reply's offer gets the work harness, not the quick lane", () => {
    const requests = size([
      user("hi"),
      assistant("Hi! Should I take a look at the failing tests in this repository?"),
      user("yes"),
    ])
    expect(requests.map((request) => request.tier)).toEqual(["chat", "standard"])
    // A greeting reply's pleasantry offers nothing.
    expect(size([user("hi"), assistant("Hi! How can I help you today?"), user("thanks")]).at(-1)?.tier).toBe("chat")
  })

  test("asking for the judge in the message turns it on for that request; a mention does not", () => {
    expect(size([user("migrate the router, then run the judge")])[0]?.judge).toBe("thorough")
    expect(size([user("use llm-as-a-judge on this change", { judge: "changes" })])[0]?.judge).toBe("changes")
    expect(size([user("llm as a judge launches on hi, fix it")])[0]).toMatchObject({ tier: "standard", judge: "off" })
  })

  test("changed files come from patches and completed edits after the last verdict", () => {
    // Message IDs are ordered, so the user's message is made first.
    const ask = user("migrate the router across 40 files")
    const edit = assistant("Edited.", "tool-calls", [{ tool: "edit" }])
    const editPart = edit.parts.find((part) => part.type === "tool")
    if (editPart?.type === "tool" && editPart.state.status === "completed")
      editPart.state.input = { filePath: "/r/a.ts" }
    const request = size([ask, edit, assistant("Done.")])[0]!
    expect(SessionTaskSize.changedFiles(request)).toEqual(["/r/a.ts"])
    expect(SessionTaskSize.changedFiles(request, request.messages.at(-1)?.info.id)).toEqual([])
  })
})
