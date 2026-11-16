import { expect, test } from "bun:test"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { ComputerEntities } from "@/computer/entities"
import { SessionMemory } from "@/session/memory"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_entities")
const messageID = MessageID.make("msg_entities")
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }

function user(text: string, options: Partial<SessionV1.TextPart> = {}): SessionV1.WithParts {
  return {
    info: { id: messageID, sessionID, role: "user", time: { created: 1 }, agent: "build", model },
    parts: [{ id: PartID.make("prt_user"), sessionID, messageID, type: "text", text, ...options }],
  }
}

function observed(tool = "computer"): SessionV1.WithParts {
  return {
    info: {
      id: messageID,
      parentID: MessageID.make("msg_user"),
      sessionID,
      role: "assistant",
      time: { created: 2 },
      agent: "build",
      mode: "build",
      ...model,
      path: { cwd: "/project", root: "/project" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: PartID.make("prt_screen"),
        sessionID,
        messageID,
        type: "tool",
        tool,
        callID: "screen",
        state: {
          status: "completed",
          input: { action: "read_ui" },
          output: "Screen mentions outside@example.test",
          metadata: {},
          title: "Read app",
          time: { start: 2, end: 3 },
        },
      },
    ],
  }
}

test("an address the user never supplied remains unvouched after observing the screen", () => {
  expect(ComputerEntities.unvouched("outside@example.test", [user("Send the report"), observed()])).toEqual([
    { kind: "email", value: "outside@example.test" },
  ])
  expect(ComputerEntities.unvouched("outside@example.test", [user("Use outside@example.test"), observed()])).toEqual([])
})

test("destination checks begin with outside content and persist after later local tool results", () => {
  expect(ComputerEntities.unvouched("outside@example.test", [user("Send the report")])).toEqual([])
  expect(ComputerEntities.unvouched("outside@example.test", [observed(), observed("read")])).toHaveLength(1)
  expect(ComputerEntities.unvouched("outside@example.test", [observed("browser")])).toHaveLength(1)
})

test("a live observation checks new destinations before its tool result reaches history", () => {
  expect(ComputerEntities.unvouched("outside@example.test", [user("Send the report")], true)).toEqual([
    { kind: "email", value: "outside@example.test" },
  ])
  expect(ComputerEntities.unvouched("outside@example.test", [user("Use outside@example.test")], true)).toEqual([])
  expect(
    ComputerEntities.unvouched("outside@example.test", [user("outside@example.test", { synthetic: true })], true),
  ).toHaveLength(1)
})

for (const [name, options] of [
  ["synthetic notes", { synthetic: true }],
  ["ignored text", { ignored: true }],
  ["outside web text", { metadata: { [BrainSchema.OUTSIDE]: "web" } }],
  ["attached file text", { metadata: { [BrainSchema.OUTSIDE]: "file" } }],
] as const) {
  test(`${name} cannot vouch for a screen destination`, () => {
    expect(
      ComputerEntities.unvouched("outside@example.test", [user("outside@example.test", options), observed()]),
    ).toHaveLength(1)
  })
}

test("assistant text and attachment URLs cannot vouch for a screen destination", () => {
  const assistant = { ...observed(), parts: user("outside@example.test").parts }
  const attachment = user("")
  attachment.parts = [
    {
      id: PartID.make("prt_file"),
      sessionID,
      messageID,
      type: "file",
      mime: "text/plain",
      filename: "outside@example.test",
      url: "https://example.test/outside@example.test",
    },
  ]
  expect(ComputerEntities.unvouched("outside@example.test", [assistant, attachment, observed()])).toHaveLength(1)
})

test("the user's pasted address counts, while only their slash-command arguments count", () => {
  const address = "outside@example.test"
  expect(
    ComputerEntities.unvouched(address, [
      user(address, {
        metadata: { [BrainSchema.PASTED]: [{ start: 0, end: address.length }] },
      }),
      observed(),
    ]),
  ).toEqual([])
  expect(
    ComputerEntities.unvouched(address, [
      user(address, {
        metadata: { [SessionMemory.COMMAND]: { name: "send", arguments: "the report" } },
      }),
      observed(),
    ]),
  ).toHaveLength(1)
  expect(
    ComputerEntities.unvouched(address, [
      user("Send the report", {
        metadata: { [SessionMemory.COMMAND]: { name: "send", arguments: address } },
      }),
      observed(),
    ]),
  ).toEqual([])
})

test("destination extraction includes each required kind without overlapping or duplicate entities", () => {
  expect(
    ComputerEntities.extract(
      [
        "person@example.test",
        "https://example.test/report",
        "+44 20 7946 0958",
        "GB82 WEST 1234 5698 7654 32",
        "4111 1111 1111 1111",
        "0x52908400098527886E0F7030069857D2E4169EE7",
        "person@example.test",
      ].join("\n"),
    ),
  ).toEqual([
    { kind: "email", value: "person@example.test" },
    { kind: "url", value: "https://example.test/report" },
    { kind: "phone", value: "+44 20 7946 0958" },
    { kind: "iban", value: "GB82 WEST 1234 5698 7654 32" },
    { kind: "card", value: "4111 1111 1111 1111" },
    { kind: "crypto", value: "0x52908400098527886E0F7030069857D2E4169EE7" },
  ])
})

test("formatting is normalized while URL paths, queries and destinations stay exact", () => {
  const history = [
    user("PERSON@example.test https://EXAMPLE.test/report +442079460958 GB82WEST12345698765432"),
    observed(),
  ]
  expect(
    ComputerEntities.unvouched(
      "person@example.test https://example.test/report +44 (20) 7946-0958 GB82 WEST 1234 5698 7654 32",
      history,
    ),
  ).toEqual([])
  for (const destination of [
    "other@example.test",
    "https://sub.example.test/report",
    "https://example.test/Report",
    "https://example.test/report?to=outside@example.test",
  ])
    expect(ComputerEntities.unvouched(destination, history)).toHaveLength(1)
  expect(ComputerEntities.extract("https://example.test/report?to=outside@example.test")).toEqual([
    { kind: "url", value: "https://example.test/report?to=outside@example.test" },
  ])
})

test("bare destinations retain their query and fragment when compared with user evidence", () => {
  const history = [user("https://example.test/"), observed()]
  for (const destination of ["example.test?account=new", "example.test#new"])
    expect(ComputerEntities.unvouched(destination, history)).toEqual([{ kind: "url", value: destination }])
  const value = "new.example.test?to=person@example.test"
  expect(ComputerEntities.unvouched(value, [user("person@example.test"), observed()])).toEqual([{ kind: "url", value }])
  const nested = "example.test?next=https://another.test/"
  expect(ComputerEntities.unvouched(nested, history)).toEqual([{ kind: "url", value: nested }])
})

test("phone numbers with common separators remain destinations", () => {
  const history = [user("Send the report"), observed()]
  for (const value of ["+1.415.555.1212", "+44\u00a020\u00a07946\u00a00958", "+44\u202f20\u202f7946\u202f0958"])
    expect(ComputerEntities.unvouched(value, history)).toEqual([{ kind: "phone", value }])
  expect(ComputerEntities.unvouched("+1.415.555.1212", [user("+14155551212"), observed()])).toEqual([])
})

test("adjacent account and phone destinations are checked separately", () => {
  const known = "GB82 WEST 1234 5698 7654 32"
  const next = "FR14 2004 1010 0505 0001 3M02 606"
  expect(ComputerEntities.unvouched(`${known} ${next}`, [user(known), observed()])).toEqual([
    { kind: "iban", value: next },
  ])
  expect(ComputerEntities.unvouched("4155551212 2125551212", [user("4155551212"), observed()])).toEqual([
    { kind: "phone", value: "2125551212" },
  ])
  for (const value of ["415 555 1212 212 555 1212", "4155551212 212 555 1212"])
    expect(ComputerEntities.unvouched(value, [user("4155551212"), observed()])).toEqual([{ kind: "phone", value }])
})

test("unlisted IBAN country formats still require destination review", () => {
  for (const value of [
    "OM230000123456789012345",
    "DJ2700000000000000000000000",
    "SD1800000000000000",
    "YE3000000000000000000000000000",
  ])
    expect(ComputerEntities.unvouched(value, [observed()])).toEqual([{ kind: "iban", value }])
})

test("email punctuation is part of the destination rather than evidence for another mailbox", () => {
  for (const value of [
    "+person@example.test",
    "!person@example.test",
    "_person@example.test",
    "person+new@example.test",
  ])
    expect(ComputerEntities.unvouched(value, [user("person@example.test"), observed()])).toEqual([
      { kind: "email", value },
    ])
  expect(ComputerEntities.extract("person@example.test.")).toEqual([{ kind: "email", value: "person@example.test" }])
})

test("ordinary text, dates and short numeric values do not become destinations", () => {
  expect(ComputerEntities.extract("Save the notes for 2026-10-28. The total is 125.50 and the count is 42.")).toEqual(
    [],
  )
})
