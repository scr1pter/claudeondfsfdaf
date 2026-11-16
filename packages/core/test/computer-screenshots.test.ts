import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { ComputerScreenshots } from "../src/util/computer-screenshots"

const image = "data:image/png;base64,cHJpdmF0ZS1zY3JlZW4="
const file = { type: "file", mime: "image/png", uri: image }
const text = { type: "text", text: "Observed the approved app" }

function part(tool: string) {
  return {
    type: "tool",
    tool,
    state: { status: "completed", metadata: { action: "screenshot" }, attachments: [file], output: "Observed" },
  }
}

test("computer attachment projection leaves ordinary tool attachments and stored history unchanged", () => {
  const computer = part("computer")
  const ordinary = part("read")
  const stored = [{ parts: [computer, ordinary] }]
  const view = ComputerScreenshots.stripPayload(stored)
  expect(view[0].parts[0].state.attachments).toBeUndefined()
  expect(view[0].parts[0].state.output).toBe("Observed")
  expect(view[0].parts[1]).toEqual(ordinary)
  expect(computer.state.attachments).toEqual([file])
})

for (const status of ["running", "completed", "error"]) {
  test(`native ${status} computer output drops every retained media envelope`, () => {
    const stored = {
      type: "tool",
      name: "computer",
      state: {
        status,
        input: { action: "screenshot" },
        attachments: [file],
        content: [text, file],
        structured: { attachments: [file], detail: "Observed" },
        result: { type: "json", value: { content: [text, file, { type: "image", data: image }], attachments: [file] } },
      },
    }
    const view = ComputerScreenshots.stripPayload(stored)
    expect(JSON.stringify(view)).not.toContain(image)
    expect(view.state.content).toEqual([text])
    expect(Object.entries(view.state.structured)).toEqual([["detail", "Observed"]])
    expect(view.state.result.value.content).toEqual([text])
    expect(view.state.input).toEqual(stored.state.input)
    expect(stored.state.content).toEqual([text, file])
  })
}

test("decoded DateTime and other branded objects retain their identity", () => {
  const created = DateTime.makeUnsafe(100)
  const bytes = new Uint8Array([1, 2, 3])
  const stored = { time: { created }, bytes, parts: [part("computer")] }
  const view = ComputerScreenshots.stripPayload(stored)
  expect(view.time.created).toBe(created)
  expect(DateTime.toEpochMillis(view.time.created)).toBe(100)
  expect(view.bytes).toBe(bytes)
  expect(view.parts[0].state.attachments).toBeUndefined()
})

test("event envelopes and public screenshot previews receive the same computer-only projection", () => {
  const stored = {
    payload: { syncEvent: { type: "message.part.updated.1", data: { part: part("computer") } } },
    preview: { type: "tool", name: "computer", status: "completed", screenshots: [{ url: image }] },
    ordinary: { type: "attachment", url: image },
  }
  const view = ComputerScreenshots.stripPayload(stored)
  expect(view.payload.syncEvent.data.part.state.attachments).toBeUndefined()
  expect(view.preview.screenshots).toBeUndefined()
  expect(view.ordinary).toEqual(stored.ordinary)
})

test("empty computer result media preserves required record fields", () => {
  const stored = {
    type: "tool",
    name: "computer",
    state: { status: "completed", structured: { type: "image", data: image }, content: [file] },
  }
  const view = ComputerScreenshots.stripPayload(stored)
  expect(Object.keys(view.state.structured)).toEqual([])
  expect(view.state.content).toEqual([])
})
