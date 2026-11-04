import { describe, expect, test } from "bun:test"
import { TaskSize } from "../src/task-size"

const tier = (text: string, input: Partial<TaskSize.Input> = {}) => TaskSize.classify({ text, ...input }).tier

describe("TaskSize.classify", () => {
  test("a social message is a direct reply", () => {
    for (const text of [
      "hi",
      "hii",
      "Hello!",
      "hello :)",
      "hi there",
      "hey vector",
      "hey hey",
      "hello again",
      "good morning",
      "hi there, how are you?",
      "hey, how are you doing today?",
      "hey vector what's up",
      "hello, can you help me?",
      "thanks",
      "thanks!",
      "thank you so much",
      "ok thanks",
      "thanks, that works",
      "Thanks! That works great",
      "thanks for the help",
      "thanks for the fix!",
      "thank you for the update",
      "thanks a ton for the help",
      "it works now, thanks",
      "bye",
      "ok thanks bye",
      "see you tomorrow",
      "great job",
      "👍",
      "what can you do?",
      "who are you",
      "what model are you?",
      "which model is this?",
      "what is vector?",
      "who made vector?",
      "how do I use vector?",
      // Common wordings of a thanks, an acknowledgement with one, and answers to the agent's own courtesy.
      "got it, thanks",
      "sounds great, thanks",
      "brilliant, thanks",
      "good, thanks",
      "thanks, you're the best",
      "thank u",
      "thankyou",
      "thnx",
      "np",
      "no problem",
      "you too",
      "that's great",
      "bye for now",
      "hi claude",
      "great, thanks!",
      "i'm good, you?",
      // A thanks for one thing: a short noun phrase or an -ing phrase that ends the sentence.
      "thanks for the quick fix to the parser",
      "thanks for all the help today",
      "thanks for your help",
      "thanks for fixing that",
      "thanks for looking into it",
      "thank you for taking care of it",
      "thanks for everything",
    ]) {
      const result = TaskSize.classify({ text })
      expect(result.tier, text).toBe("chat")
      expect(TaskSize.effort(result.tier), text).toBe("off")
    }
  })

  test("only a message whose every clause is social is a direct reply", () => {
    for (const text of [
      "thanks, now fix the other one",
      "thanks for that, now add tests",
      "thanks for the help can you also add tests",
      "thanks but it's still broken",
      "hi, can you fix the login bug?",
      "hello, deploy it",
      "how do I normalize a vector?",
      "hi `foo`",
      // Replies to the work are never social: they continue it, which only the history can say.
      "yes",
      "no thanks",
      "continue",
      "looks good",
      // An agreement alone may mean "go ahead".
      "sounds good",
    ])
      expect(tier(text), text).toBe("standard")
    // A thanks with a request after it and no comma between them is still a request: the owner's "ship to vercel"
    // included. Each would have gone to the quick lane.
    for (const text of [
      "thanks for the update ship it to vercel",
      "thanks for the fix ship it",
      "thanks for that run the tests",
      "thanks for that push it",
      "thanks for this commit it",
      "thanks for the review fix them all",
      "thank you for the plan go ahead",
      "thanks for the fix what about tests?",
      "thanks for the fix why is it slow",
      "thanks for that what changed",
      "thanks for that fix the header too",
      "thank you for fixing the build now add docs",
    ])
      expect(TaskSize.classify({ text }), text).toMatchObject({ tier: "standard", reasons: ["work"] })
    expect(tier("hi", { files: 1 })).toBe("standard")
    expect(tier("hi", { images: 1 })).toBe("standard")
  })

  test("a bare acknowledgement is a direct reply unless a plan or a question waits on it", () => {
    for (const text of ["ok", "OK.", "okay", "k", "ok!", "got it", "gotcha", "cool", "nice", "thanks"]) {
      expect(TaskSize.classify({ text }), text).toMatchObject({ tier: "chat" })
      expect(tier(text, { previous: "standard" }), text).toBe("chat")
    }
    expect(TaskSize.classify({ text: "ok" }).reasons).toEqual(["ack"])
    // After a plan from Plan mode it is never a bare reply ("ok" carries the plan out), and while the agent's question
    // waits it answers it.
    for (const text of ["ok", "okay"])
      expect(TaskSize.classify({ text, previous: "thorough", plan: true }), text).toMatchObject({
        tier: "thorough",
        source: "inherited",
      })
    for (const text of ["ok", "okay", "got it"]) {
      expect(tier(text, { previous: "thorough", plan: true }), text).not.toBe("chat")
      expect(tier(text, { previous: "standard", open: true }), text).toBe("standard")
    }
    // An acknowledgement with an ask is the ask.
    for (const text of ["ok, now add tests", "got it, ship it", "ok do it"]) expect(tier(text), text).toBe("standard")
  })

  test("asking whether it works asks the agent to check, so it is work, not a report that it works", () => {
    for (const text of [
      "fixed?",
      "working?",
      "works?",
      "it works now?",
      "it's fixed?",
      "it worked?",
      "the tests passed?",
      "the build passes?",
      "everything works?",
      "that fixed it?",
    ])
      expect(TaskSize.classify({ text }), text).toMatchObject({ tier: "standard", reasons: ["work"] })
    // Told, not asked, it is still a report.
    expect(tier("it works now")).toBe("chat")
    expect(tier("thanks, the tests passed")).toBe("chat")
  })

  test("a log pasted under a greeting or a help is work", () => {
    for (const text of [
      "hi\nnpm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree",
      "help\nnpm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree",
      "help\nCaused by: java.lang.NullPointerException",
      "hey\n[2026-10-18 10:00:00] ERROR worker crashed: connection refused",
      "hi\n2026-10-18T10:00:00Z ERROR db connection refused\n2026-10-18T10:00:01Z ERROR retrying",
      "thanks\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ])
      expect(tier(text), text).toBe("standard")
    // A greeting on two lines of its own is still a greeting.
    expect(tier("hi\nhow are you?")).toBe("chat")
  })

  test("a message that answers or follows up open work is never a direct reply", () => {
    // The agent asked or offered something, or its run did not finish: even a thanks or a greeting answers that work.
    for (const text of ["thanks", "hi", "thanks, that works", "no", "no thanks", "ok"]) {
      const result = TaskSize.classify({ text, previous: "thorough", open: true })
      expect(result, text).toMatchObject({ tier: "thorough", source: "inherited" })
      expect(tier(text, { previous: "standard", open: true }), text).toBe("standard")
    }
    // A greeting reply that offered work has no work to inherit, so the answer is Work with the history.
    expect(TaskSize.classify({ text: "yes", open: true })).toMatchObject({ tier: "standard", source: "auto" })
  })

  test("everything else is Work at the provider's default effort, whatever words it uses", () => {
    for (const text of [
      "ship to vercel",
      "fix the typo in README",
      "run the tests",
      "switch to typescript",
      "switch the codebase to Go",
      "migrate the app to the new router across 40 files",
      "rewrite the entire backend in Rust",
      "what does this function do?",
      "why does this deadlock?",
      "review the auth module",
      "open a pr for #123",
      "add OAuth login with tests",
      // Style words shape the answer, never the tools or the effort.
      "keep it simple",
      "quick question: why does this deadlock?",
      "add OAuth login with tests, keep it simple",
      "don't overthink it, fix the race condition in the scheduler",
      "don't overengineer it, add a caching layer to the api",
      "just tell me why the build fails",
      "briefly, what does parseArgs do?",
    ]) {
      const result = TaskSize.classify({ text })
      expect(result.tier, text).toBe("standard")
      expect(TaskSize.effort(result.tier), text).toBe("default")
    }
  })

  test("Thorough only when the user asks for it in the request", () => {
    for (const text of [
      "be thorough",
      "be very thorough: migrate the auth module",
      "please be thorough and fix the login bug",
      "review this thoroughly",
      "use subagents to review this",
      "refactor auth with subagents",
      "can you use subagents for this?",
      "run the judge on this",
      "have the judge check it",
      "fix the header and judge the work",
      "use llm-as-a-judge",
      "fix it, ultrathink",
      "do a deep dive into the session runner",
      "use subagents",
      "run the judge",
      "use subagents for this",
      "use subagents to port each package",
      "do this properly with subagents",
      "thorough review of the auth module please",
      "be very careful",
      "thorough please",
      "I want this done thoroughly",
      "I'd like this done thoroughly",
    ]) {
      const result = TaskSize.classify({ text })
      expect(result, text).toMatchObject({ tier: "thorough", source: "user" })
      expect(TaskSize.effort(result.tier), text).toBe("high")
    }
    // A mention of the same words is not an ask.
    for (const text of [
      "fix the bug with subagents not starting",
      "llm as a judge launches on hi, fix it",
      "how would you judge this approach?",
      "why are the subagents so slow?",
      "I tested it thoroughly but it still fails",
      "should I use subagents for this?",
      "do you use subagents for this?",
      // Requests about the judge and subagents themselves, which this repository builds.
      "use the judge only for large tasks",
      "have the judge skip greetings",
      "run the judge only after thorough runs",
      "run the judge tests",
      "run the judge test suite in packages/engine",
      "use the judge agent's prompt from the docs",
      "run subagents.test.ts",
      "use subagents in background mode by default",
      "start the subagents service on boot",
      "take your time parameter is wrong in the scheduler",
      // "full" is about scope, not an ask for Thorough.
      "do a full review of the auth module",
      "run a full audit of the deps",
    ])
      expect(TaskSize.classify({ text }), text).toMatchObject({ tier: "standard", reasons: ["work"] })
  })

  test("the user's own negations: no subagents and don't be thorough keep Work, skip the judge turns it off", () => {
    expect(tier("don't use subagents, be thorough")).toBe("standard")
    expect(tier("dont be thorough, just fix it")).toBe("standard")
    expect(tier("no need to go deep, rewrite the entire backend")).toBe("standard")
    expect(TaskSize.classify({ text: "be thorough but skip the judge" })).toMatchObject({
      tier: "thorough",
      judge: false,
    })
    expect(TaskSize.classify({ text: "add OAuth login" }).judge).toBe(true)
    // Inside Thorough work they take the subagents away, never the tools.
    expect(tier("no subagents please", { previous: "thorough" })).toBe("standard")
    expect(tier("no subagents, finish the migration", { previous: "thorough", open: true })).toBe("standard")
    // The cap is recorded, so nothing (escalate included) takes the request past Work.
    for (const text of [
      "migrate the app to the new router across 40 files, no subagents",
      "don't be thorough, just migrate the app to the new router across 40 files",
      "don't use subagents, be thorough",
    ])
      expect(TaskSize.classify({ text }).reasons, text).toContain("capped")
    expect(TaskSize.classify({ text: "migrate the app to the new router across 40 files" }).reasons).toEqual(["work"])
  })

  test("Thorough ends with its run: after it finishes, a new message is sized fresh, whatever it changed", () => {
    // After a migration, a review or an analysis alike: none of these carries the Thorough work on.
    for (const text of [
      "ship to vercel",
      "fix the typo in README",
      "what does parseArgs do?",
      "run the tests",
      "commit this",
      "add a test for the parser",
      "yes",
      "build it",
      "looks good",
      "no, keep the old routes working",
      "also update the docs",
      "keep it simple",
      "quick question: what does parseArgs do?",
      "now add a dark mode toggle to the settings page and write tests for it please",
      "add a settings page with a dark mode toggle, tests for the parser and a new billing flow",
    ])
      expect(TaskSize.classify({ text, previous: "thorough" }), text).toMatchObject({
        tier: "standard",
        source: "auto",
        reasons: ["work"],
      })
    // A social message after finished work is a direct reply, a bare acknowledgement included.
    for (const text of ["thanks", "hi", "thanks, that works", "perfect", "ok", "got it"])
      expect(tier(text, { previous: "thorough" }), text).toBe("chat")
    // A greeting before a message is not work it could continue.
    expect(TaskSize.classify({ text: "continue", previous: "chat" }).source).toBe("auto")
  })

  test("only an explicit carry-on continues finished Thorough work", () => {
    for (const text of [
      "continue",
      "continue where you left off",
      "continue with phase 2",
      "please continue",
      "go on",
      "keep going",
      "carry on with the views",
      "proceed",
      "do the rest of the files",
      "the rest",
      "finish the rest",
    ])
      expect(TaskSize.classify({ text, previous: "thorough" }), text).toMatchObject({
        tier: "thorough",
        source: "inherited",
        reasons: ["continue"],
      })
    // Continuing Work is Work: Light and Standard behave the same.
    expect(TaskSize.classify({ text: "continue", previous: "light" })).toMatchObject({
      tier: "standard",
      source: "inherited",
    })
  })

  test("after a plan from Plan mode, an approval or an ask to build it carries the plan out at its size", () => {
    for (const text of [
      "yes",
      "yes, start with phase 1",
      "approved",
      "approved, but skip the billing part",
      "ok",
      "go ahead",
      "looks good",
      "lgtm",
      "build it",
      "build the app",
      "implement the migration",
      "implement the plan",
      "ok build the app",
      "ok, build it",
      "Great plan! Please go ahead and implement phases 1 and 2, but skip the billing part for now.",
      "Please go ahead with the plan, but use postgres instead of sqlite and keep the migrations in packages/db",
      "Let's do it, but keep the old routes working until the end of the migration please",
      "The plan looks good to me, go ahead with all three phases and keep the old api for now",
      "Perfect, implement it exactly like that but put the new files under packages/tui-rs instead",
    ])
      expect(TaskSize.classify({ text, previous: "thorough", plan: true }), text).toMatchObject({
        tier: "thorough",
        source: "inherited",
      })
    // A request of its own after a plan is still sized fresh.
    for (const text of ["ship to vercel", "fix the typo in README", "what does parseArgs do?"])
      expect(tier(text, { previous: "thorough", plan: true }), text).toBe("standard")
  })

  test("while the reply asks the user a question, any message answers it at the work's size", () => {
    for (const text of ["ship to vercel", "no, keep the old routes", "option 2", "yes"])
      expect(TaskSize.classify({ text, previous: "thorough", open: true }), text).toMatchObject({
        tier: "thorough",
        source: "inherited",
        reasons: ["answer"],
      })
  })

  test("the sender's choice and the off switch win", () => {
    expect(tier("hi", { choice: "thorough" })).toBe("thorough")
    expect(tier("migrate everything across 50 files", { choice: "light" })).toBe("light")
    expect(tier("hi", { choice: "auto" })).toBe("chat")
    expect(tier("hi", { auto: false })).toBe("thorough")
    expect(tier("hi", { auto: false, choice: "chat" })).toBe("chat")
    expect(TaskSize.classify({ text: "hi", choice: "standard" }).source).toBe("user")
  })

  test("structured output and named subagents are never a bare reply", () => {
    expect(tier("hi", { structured: true })).toBe("standard")
    expect(tier("hi", { choice: "chat", structured: true })).toBe("standard")
    const named = TaskSize.classify({ text: "hi", agents: ["explore"] })
    expect(named.tier).toBe("standard")
    expect(named.agents).toEqual(["explore"])
  })
})

describe("TaskSize helpers", () => {
  test("effort: off for a greeting, the provider's default for Work, high for Thorough", () => {
    expect(TaskSize.effort("chat")).toBe("off")
    expect(TaskSize.effort("light")).toBe("default")
    expect(TaskSize.effort("standard")).toBe("default")
    expect(TaskSize.effort("thorough")).toBe("high")
  })

  test("Work withholds only subagents, and Light also the to-do list", () => {
    expect([...TaskSize.withheld("standard")].toSorted()).toEqual(["task", "task_manage"])
    expect([...TaskSize.withheld("light")].toSorted()).toEqual(["task", "task_manage", "todowrite"])
    expect(TaskSize.withheld("thorough").size).toBe(0)
    // A subagent the user named keeps the task tool.
    expect(TaskSize.withheld("standard", 1).has("task")).toBe(false)
  })

  test("asks: a reply asks the user something when its last paragraph has a question", () => {
    for (const text of [
      "I can publish a preview. Shall I deploy?",
      "Migrated the router. Do you want me to keep the old API for compatibility?",
      "Migrated 30 routes. Should I also migrate the tests?",
      "Done. Want me to also add tests?",
      "Fixed. Should I commit it?",
      // A question that names work is not a pleasantry.
      "Here is the plan in three phases. What would you like me to do first?",
      // A question that is not the reply's last sentence still asks (the verifier's four closings).
      "Should I also remove the old API? I'll wait for your answer.",
      "Should I also remove the old API? Once you confirm, I'll proceed.",
      "Which do you prefer for the old API: remove it or keep a shim? I'd go with the shim.",
      "Do you want me to keep the old API?\n\n**Summary of changes:**\n- router.ts\n- app.ts",
      // Courtesy, an emoji or an aside after the question does not hide it.
      "Migrated the router. Should I also remove the old API? Let me know!",
      "Should I also remove the old API?\n\nLet me know!",
      "Should I also remove the old API?\n\nLet me know if this works for you.",
      "Want me to proceed with phase 2? 🙂",
      "Shall I continue with the input layer? Just say the word.",
      "Should I keep the old API, or remove it? (I'd lean toward removing it.)",
      "**Should I also migrate the tests?**",
      "Should I also migrate the tests? Anything else?",
      "Which approach do you prefer?\n\n1. Keep the shim\n2. Remove the old API",
    ])
      expect(TaskSize.asks(text), text).toBe(true)
    for (const text of [
      "Done. I fixed the typo in README.md.",
      // An offer or a closing line without a question mark asks nothing.
      "Here is the plan. Let me know if it looks right.",
      "I can also add tests for this if you want.",
      "Migrated all 40 routes. I can also update the docs if you want.",
      "The migration is complete. Next, I would update the docs if you'd like.",
      "Done. Let me know if this works for you.",
      "Done. Let me know if you'd like me to make any other changes.",
      "Done. Let me know how it goes.",
      "Done. Let me know if anything looks off.",
      "Done. Happy to adjust if needed.",
      "Done. I'd suggest running the e2e suite before merging.",
      "Done. I recommend running `bun test` locally to confirm.",
      "Done. You can confirm by running `bun dev`.",
      "Done. Hope this helps!",
      "Deployed. Visit https://x.vercel.app?ref=1",
      // A closing pleasantry offers nothing to answer.
      "Done. Anything else?",
      "Fixed the typo. Is there anything else you'd like me to help with?",
      "Fixed the typo. Let me know if you need anything else.",
      "Hi! How can I help you today?",
      "Done! Anything else I can help with? 🙂",
      "Migrated all 40 files. Let me know if you'd like any changes.",
      // A question in an earlier paragraph is not where the reply ends.
      "Why did it fail? The config was missing.\n\nI added it and all tests pass.",
      "Migrated the router (and its tests).",
      "Summary:\n- a.ts\n- b.ts\n\nAll green.",
    ])
      expect(TaskSize.asks(text), text).toBe(false)
  })

  test("notes stay short and Standard tracks substantial milestones rather than routine steps", () => {
    for (const tier of ["light", "standard", "thorough"] as const)
      expect(TaskSize.note(tier, { escalate: true, judge: true })!.length).toBeLessThan(340)
    expect(TaskSize.note("light", { escalate: true, judge: false })).toContain("without a to-do list")
    expect(TaskSize.note("standard", { escalate: true, judge: false })).toContain(
      "Track only substantial milestones or a user-requested plan",
    )
    expect(TaskSize.note("standard", { escalate: true, judge: false })).not.toContain("multi-step work")
    expect(TaskSize.note("thorough", { escalate: false, judge: false })).toContain("plan with the to-do list")
    expect(TaskSize.note("chat", { escalate: true, judge: true })).toBeUndefined()
  })
})
