import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { SessionArchive } from "@vectordevai/core/share/archive"

// A learned skill's steps stay out of public shares (section 5.4): the transcript keeps a placeholder, and the public
// archive carries the placeholder for a learned skill's output whatever the transcript holds.

const PROCEDURE = "## Steps\n\n1. Run `bun typecheck` in packages/core, the owner's private procedure."

function archive(output: string, metadata: Record<string, unknown>) {
  const base = { sessionID: "ses_learned", messageID: "msg_2" }
  return Schema.decodeUnknownSync(SessionArchive.Legacy)({
    info: {
      id: "ses_learned",
      slug: "learned",
      projectID: "global",
      directory: "/tmp/repo",
      title: "Fix the types",
      version: "1.99.113",
      time: { created: 1, updated: 2 },
    },
    messages: [
      {
        info: {
          id: "msg_1",
          sessionID: "ses_learned",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "p", modelID: "m" },
        },
        parts: [
          { id: "prt_1", sessionID: "ses_learned", messageID: "msg_1", type: "text", text: "Fix the type error" },
        ],
      },
      {
        info: {
          id: "msg_2",
          sessionID: "ses_learned",
          role: "assistant",
          time: { created: 2, completed: 3 },
          parentID: "msg_1",
          modelID: "m",
          providerID: "p",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp/repo", root: "/tmp/repo" },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            ...base,
            id: "prt_2",
            type: "tool",
            callID: "call_1",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "learned-bun-typecheck-packages-core" },
              output,
              title: "Loaded skill",
              metadata,
              time: { start: 2, end: 3 },
            },
          },
        ],
      },
    ],
  })
}

const outputOf = (local: SessionArchive.Local) => {
  const part = SessionArchive.publicArchive(local).messages[1]!.parts[0]!
  return part.type === "tool" ? part.output : ""
}

describe("public archive of a learned skill", () => {
  const learned = {
    name: "learned-bun-typecheck-packages-core",
    dir: "",
    remote: false,
    learned: "s0a1b2c",
    version: 3,
    "vector.memory.skill": { id: "s0a1b2c", version: 3 },
  }
  const placeholder = BrainSkill.placeholder("learned-bun-typecheck-packages-core", 3)

  test("carries the placeholder, never the procedure, even when a transcript holds the procedure", () => {
    expect(placeholder).toBe(
      "Loaded learned skill learned-bun-typecheck-packages-core (version 3). Vector fills in its procedure for each request.",
    )
    expect(outputOf(archive(placeholder, learned))).toBe(placeholder)
    const leaked = outputOf(
      archive(
        BrainSkill.content({
          version: 3,
          entryID: "s0a1b2c",
          name: "learned-bun-typecheck-packages-core",
          description: "d",
          procedure: PROCEDURE,
          checks: ["bun typecheck"],
          commands: [],
          actor: "agent",
          reason: "learned",
          createdAt: 1,
        }),
        learned,
      ),
    )
    expect(leaked).toBe(placeholder)
    expect(JSON.stringify(SessionArchive.publicArchive(archive(PROCEDURE, learned)))).not.toContain("private procedure")
  })

  test("leaves a skill from disk as it was loaded", () => {
    expect(
      outputOf(
        archive('<skill_content name="docs">Write docs</skill_content>', {
          name: "docs",
          dir: "/tmp/skills/docs",
          remote: false,
        }),
      ),
    ).toBe('<skill_content name="docs">Write docs</skill_content>')
  })
})
