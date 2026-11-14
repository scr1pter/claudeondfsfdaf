import { expect, test } from "bun:test"
import type { TextPart } from "@vectordevai/sdk/v2"
import { hostedJobNote } from "./hosted-job-note"

const part: TextPart = { id: "prt_result", sessionID: "ses_parent", messageID: "msg_result", type: "text",
  synthetic: true, text: "A returned report", metadata: { hostedJobNotification: { jobID: `jb_${"a".repeat(26)}`, state: "reported" } } }

test("only an explicitly marked finished hosted report is displayed among synthetic text", () => {
  expect(hostedJobNote(part)).toBe(true)
  expect(hostedJobNote({ ...part, synthetic: false })).toBe(false)
  expect(hostedJobNote({ ...part, metadata: {} })).toBe(false)
  expect(hostedJobNote({ ...part, metadata: { "vector.memory.recall": { text: "hidden context" } } })).toBe(false)
  expect(hostedJobNote({ ...part, metadata: { hostedJobNotification: { jobID: `jb_${"a".repeat(26)}`, state: "running" } } })).toBe(false)
  expect(hostedJobNote({ ...part, metadata: { hostedJobNotification: { jobID: "../other", state: "reported" } } })).toBe(false)
  expect(hostedJobNote(undefined)).toBe(false)
})
