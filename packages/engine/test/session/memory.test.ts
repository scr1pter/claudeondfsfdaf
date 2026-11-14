import { expect, test } from "bun:test"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { BrainLearn } from "@vectordevai/core/brain/learn"
import { Computer } from "@vectordevai/schema/computer"
import { SessionMemory } from "@/session/memory"
import { SessionTaskSize } from "@/session/task-size"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_computer_memory")
const messageID = MessageID.make("msg_computer_memory")

function history(tool: string): SessionV1.WithParts[] {
  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.make("msg_computer_user"),
        agent: "build",
        mode: "build",
        path: { cwd: "/project", root: "/project" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 0 },
      },
      parts: [
        {
          id: PartID.make("prt_computer_memory"),
          sessionID,
          messageID,
          type: "tool",
          tool,
          callID: "call_computer_memory",
          state: {
            status: "completed",
            input: { action: "read_ui" },
            output: "App controls and text",
            title: "Read app controls",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

test("a completed computer part taints the session as web (INV-S11)", () => {
  expect(SessionMemory.taint(history("read"))).toBeUndefined()
  expect(SessionMemory.taint(history("computer"))).toBe("web")
  expect(SessionMemory.taint([...history("computer"), ...history("read")])).toBe("web")
})

test("admission preserves a computer mention as a hint while stripping engine memory claims", () => {
  const marker = { kind: "feature" }
  expect(
    SessionMemory.admitted({
      [Computer.MENTION_KEY]: marker,
      [SessionMemory.RECALL]: { ids: ["claimed"] },
      [SessionMemory.KNOWLEDGE]: { document: "claimed" },
      [SessionMemory.PERSONAL]: ["claimed"],
    }),
  ).toEqual({ [Computer.MENTION_KEY]: marker })
})

test("Brain document intake and learning helpers never read computer screenshot attachments", () => {
  const input = history("computer")
  const part = input[0].parts[0]
  if (part.type !== "tool" || part.state.status !== "completed") throw new Error("Expected completed fixture")
  const screenshot: SessionV1.FilePart = {
    id: PartID.make("prt_private_screenshot"),
    sessionID,
    messageID,
    type: "file",
    mime: "image/png",
    filename: "private-screen.png",
    url: "data:image/png;base64,cHJpdmF0ZS1zY3JlZW4=",
  }
  input[0].parts = [
    { ...part, state: { ...part.state, attachments: [screenshot] } },
    {
      id: PartID.make("prt_screenshot_remember"),
      sessionID,
      messageID,
      type: "text",
      text: "",
      synthetic: true,
      metadata: { [SessionMemory.REMEMBER]: { mode: "keep", part: screenshot.id } },
    },
    { id: PartID.make("prt_reply"), sessionID, messageID, type: "text", text: "Finished the requested task." },
  ]
  const saved = JSON.stringify(input)
  expect(SessionMemory.remember(input[0])).toEqual([])
  expect(SessionMemory.files(input[0])).toEqual([])
  expect(SessionMemory.documents(input)).toEqual([])
  expect(SessionMemory.workingSet(input, "/project")).toEqual([])
  expect(SessionTaskSize.closingText(input)).toBe("Finished the requested task.")
  const learning = BrainLearn.request({ typed: "I prefer concise replies.", reply: SessionTaskSize.closingText(input) })
  expect(learning).not.toContain("cHJpdmF0ZS1zY3JlZW4=")
  expect(learning).not.toContain("private-screen.png")
  expect(SessionMemory.taint(input)).toBe("web")
  expect(JSON.stringify(input)).toBe(saved)
})
