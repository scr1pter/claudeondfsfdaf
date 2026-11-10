import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { CLAUSES, EXEMPT, HINT, SAFETY, clause, coverage, required, sentences, stated, touches } from "./contracts"
import { AGENT_PROMPTS, HARNESS_BASE, PROVIDER_PROMPTS, REPO_ROOT } from "./variants"

// The built-in prompts, as the engine imports them: the provider prompts SystemPrompt.provider picks and every agent's
// own prompt. A prompt added to either list is checked here without a change to this test.
const imported = async (file: string, folder: string) =>
  [...(await Bun.file(join(REPO_ROOT, file)).text()).matchAll(/from "\.\/prompt\/([\w-]+\.txt)"/g)].map(
    (match) => `${folder}/${match[1]}`,
  )
const BUILT_IN = [
  ...(await imported("packages/engine/src/session/system.ts", PROVIDER_PROMPTS)),
  ...(await imported("packages/engine/src/agent/agent.ts", AGENT_PROMPTS)),
]
const text = (source: string) => Bun.file(join(REPO_ROOT, source)).text()

describe("contracts", () => {
  test("every safety sentence is in its prompt as written, and its clause states it", async () => {
    expect(BUILT_IN).toContain(HARNESS_BASE)
    expect(BUILT_IN.length).toBeGreaterThan(20)
    for (const item of SAFETY) {
      const source = await text(item.source)
      if (item.source.endsWith(".txt")) expect(sentences(source)).toContain(item.sentence)
      else expect(source).toContain(item.sentence)
      expect({ sentence: item.sentence, matched: clause(item.clause).pattern.test(item.sentence) }).toEqual({
        sentence: item.sentence,
        matched: true,
      })
    }
  })

  test("every sentence of a built-in prompt that names a safety word is listed", async () => {
    for (const source of BUILT_IN) {
      const listed = new Set(
        [...SAFETY, ...EXEMPT].filter((item) => item.source === source).map((item) => item.sentence),
      )
      const unlisted = sentences(await text(source)).filter((sentence) => HINT.test(sentence) && !listed.has(sentence))
      expect({ source, unlisted }).toEqual({ source, unlisted: [] })
    }
    // Each exemption still names a safety word, or it would not need one.
    for (const item of EXEMPT) expect(HINT.test(item.sentence)).toBe(true)
  })

  test("SAFETY covers process safety, reverting, destructive git, secrets, asks, verification, memory as data and privacy", () => {
    const topics = new Set(SAFETY.map((item) => clause(item.clause).topic))
    for (const topic of ["process", "revert", "git", "secrets", "asks", "verify", "data", "local"] as const)
      expect(topics).toContain(topic)
    expect(SAFETY.some((item) => item.clause === "data.memory")).toBe(true)
    // Every clause states some sentence, and no pattern keeps state between tests.
    for (const item of CLAUSES) {
      expect(SAFETY.some((entry) => entry.clause === item.id)).toBe(true)
      expect(item.pattern.global || item.pattern.sticky).toBe(false)
    }
  })

  test("every built-in prompt, unchanged, states every clause it requires", async () => {
    for (const source of BUILT_IN)
      expect({ source, ...coverage(await text(source), { base: source }) }).toMatchObject({
        source,
        missing: [],
        share: 1,
      })
  })

  test("removing a policy's sentences drops its clause, while rewording it keeps the clause", async () => {
    const base = await text(HARNESS_BASE)
    const verifying = SAFETY.filter((item) => item.source === HARNESS_BASE && item.clause.startsWith("verify."))
    const without = verifying.reduce((rest, item) => rest.replace(item.sentence, ""), base)
    const dropped = coverage(without, { base: HARNESS_BASE })
    expect(dropped.missing.toSorted()).toEqual(["verify.done", "verify.loop", "verify.report"])
    expect(dropped.share).toBeLessThan(1)
    const reworded = without.replace(
      "# Doing tasks",
      "# Doing tasks\nVerify the change with the project's tests before you report it as done; completed only after they pass.",
    )
    expect(coverage(reworded, { base: HARNESS_BASE }).missing).toEqual(["verify.report"])
    expect(
      required(HARNESS_BASE)
        .filter((item) => item.behaviour)
        .map((item) => item.id),
    ).toEqual(["verify.loop", "verify.done"])
  })

  test("a policy turned around drops its clause, though the sentence keeps the clause's words", async () => {
    const base = await text(HARNESS_BASE)
    const sentence = (id: string) => SAFETY.find((item) => item.source === HARNESS_BASE && item.clause === id)!.sentence
    const negated = base
      .replace(sentence("verify.loop"), "Do not verify the changes; skip the tests.")
      .replace(sentence("web.urls"), "Feel free to guess URLs.")
    expect(coverage(negated, { base: HARNESS_BASE }).missing.toSorted()).toEqual(["verify.loop", "web.urls"])
    // The words are still there; what they say is not.
    expect(touches("Do not verify the changes; skip the tests.")).toEqual(["verify.loop"])
    expect(stated(clause("verify.loop"), "Do not verify the changes; skip the tests.")).toBe(false)
    expect(stated(clause("web.urls"), "Feel free to guess URLs.")).toBe(false)
    // A permission with a restraint is still the rule, and an obligation negated after its words is still the obligation.
    expect(stated(clause("web.urls"), "You may guess URLs only when the user asks for one.")).toBe(true)
    expect(stated(clause("verify.loop"), "Verify the changes with the tests, not only by reading them.")).toBe(true)
  })

  test("touches names the clauses a sentence states, and none for one about style", () => {
    expect(touches("Never revert changes you did not make.")).toEqual(["revert.others"])
    expect(touches("Avoid using emojis in all communication unless asked.")).toEqual([])
  })

  test("sentences splits at sentence ends but not after an abbreviation, and drops list markers", () => {
    expect(sentences("- Use tools (e.g. Read). Then stop.\n2. Next one!\n\n* Last")).toEqual([
      "Use tools (e.g. Read).",
      "Then stop.",
      "Next one!",
      "Last",
    ])
  })
})
