import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerEvent } from "@vectordevai/schema/computer-event"
import { Event } from "@vectordevai/schema/event"
import { EventManifest } from "@vectordevai/schema/event-manifest"
import { QuestionV1 } from "@vectordevai/schema/question-v1"
import { SessionID } from "@vectordevai/schema/session-id"

const state: Computer.ComputerState = {
  phase: "working",
  backend: "local-macos",
  mode: "foreground",
  apps: [],
  queue: [],
  escStops: true,
  stopChord: "Command+Shift+Escape",
  lease: 7,
  reduceMotion: false,
}

describe("computer state event", () => {
  test("the compatibility manifest retains one canonical definition without adding a current event", () => {
    const definitions = EventManifest.Definitions.filter((definition) => definition.type === "computer.state")
    expect(definitions).toEqual([ComputerEvent.State])
    expect(EventManifest.Latest.get("computer.state")).toBe(ComputerEvent.State)
    expect(EventManifest.ServerDefinitions.some((definition) => String(definition.type) === "computer.state")).toBe(
      false,
    )
    expect(ComputerEvent.State.durable).toBeUndefined()
  })

  test("encodes the session and validates the desktop state", () => {
    const value = {
      id: Event.ID.create(),
      type: "computer.state" as const,
      data: { sessionID: SessionID.make("ses_computer"), state },
    }
    expect(Schema.decodeUnknownSync(ComputerEvent.State)(Schema.encodeSync(ComputerEvent.State)(value))).toEqual(value)
    expect(() =>
      Schema.decodeUnknownSync(ComputerEvent.State)({
        ...value,
        data: { ...value.data, state: { ...state, lease: -1 } },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ComputerEvent.State)({
        ...value,
        data: { ...value.data, state: { ...state, phase: "hidden" } },
      }),
    ).toThrow()
  })
})

describe("computer question metadata", () => {
  const request = {
    id: QuestionV1.ID.make("que_computer"),
    sessionID: SessionID.make("ses_computer"),
    questions: [
      { question: "Keep going?", header: "Computer", options: [{ label: "Stop", description: "End the task" }] },
    ],
  }

  test("handoff and check-in metadata survive request encoding", () => {
    for (const metadata of [
      { computer: { kind: "handoff", app: "Notes", reason: "credential" } },
      { computer: { kind: "check_in", actions: 300, minutes: 45 } },
    ] as const) {
      const value = { ...request, metadata }
      expect(Schema.decodeUnknownSync(QuestionV1.Request)(Schema.encodeSync(QuestionV1.Request)(value))).toEqual(value)
      expect(Schema.decodeUnknownSync(QuestionV1.Event.Asked.data)(value)).toEqual(value)
    }
  })

  test("ordinary questions omit absent metadata and invalid computer metadata is refused", () => {
    expect(Schema.encodeSync(QuestionV1.Request)({ ...request, metadata: undefined })).not.toHaveProperty("metadata")
    for (const metadata of [
      { computer: { kind: "handoff", reason: "unknown" } },
      { computer: { kind: "check_in", actions: -1, minutes: 45 } },
      { computer: { kind: "check_in", actions: 300, minutes: 0.5 } },
    ]) {
      expect(() => Schema.decodeUnknownSync(QuestionV1.Request)({ ...request, metadata })).toThrow()
    }
  })
})

test("control waits distinguish pointer tickets from the lease pause", () => {
  const request = {
    v: Computer.PROTOCOL,
    rootSessionID: "ses_computer",
    sessionID: "ses_computer",
    directory: "/workspace/example",
    command: "awaitControl",
    lease: 7,
  } as const
  expect(Schema.decodeUnknownSync(Computer.BridgeCommands.awaitControl.request)(request)).toEqual(request)
  expect(
    Schema.decodeUnknownSync(Computer.BridgeCommands.awaitControl.request)({ ...request, waitId: "pointer_1" }),
  ).toEqual({
    ...request,
    waitId: "pointer_1",
  })
  expect(() =>
    Schema.decodeUnknownSync(Computer.BridgeCommands.awaitControl.request)({ ...request, waitId: "" }),
  ).toThrow()
})

test("act app restrictions carry only bounded canonical identities", () => {
  const request = {
    v: Computer.PROTOCOL,
    rootSessionID: "ses_computer",
    sessionID: "ses_computer",
    directory: "/workspace/example",
    command: "act",
    lease: 7,
    steps: [{ kind: "wait", ms: 1 }],
    settleMs: 0,
  } as const
  const decode = Schema.decodeUnknownSync(Computer.BridgeCommands.act.request)
  expect(decode(request)).toEqual(request)
  expect(decode({ ...request, allowedApps: [] }).allowedApps).toEqual([])
  expect(decode({ ...request, allowedApps: ["app:macos:com.example.notes"] }).allowedApps).toEqual([
    "app:macos:com.example.notes",
  ])
  expect(() => decode({ ...request, allowedApps: ["Notes"] })).toThrow()
  expect(() =>
    decode({ ...request, allowedApps: Array(Computer.LIMITS.batchSteps + 1).fill("app:macos:com.example.notes") }),
  ).toThrow()
  const approvals = [
    { index: 0, requestID: "per_app" },
    { index: 0, requestID: "per_sensitive" },
  ]
  expect(decode({ ...request, approvals }).approvals).toEqual(approvals)
  // Each step can carry one app proof, twelve non-provider reasons and three provider checks.
  const full = Array.from({ length: 16 * Computer.LIMITS.batchSteps }, (_, index) => ({
    index: Math.floor(index / 16),
    requestID: `per_proof_${index}`,
  }))
  const batch = { ...request, steps: Array.from({ length: Computer.LIMITS.batchSteps }, () => ({ kind: "wait", ms: 1 })) }
  expect(decode({ ...batch, approvals: full }).approvals).toEqual(full)
  expect(() =>
    decode({ ...batch, approvals: [...full, { index: 0, requestID: "per_overflow" }] }),
  ).toThrow()
})
