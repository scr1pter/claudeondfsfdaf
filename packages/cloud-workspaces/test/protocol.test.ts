import { expect, test } from "bun:test"
import { Connect } from "@vectordevai/schema/connect"
import { parseCommand, parsePublicWorkspace } from "../src/protocol"
import { signWorkspaceRequest, verifyWorkspaceRequest } from "../src/signing"

const id = "f0b91863-7c08-409d-bbfa-81452f5f3a65"
const account = "8f06e070-6586-48e2-b473-5bdd151d0534"
const secret = "service-secret-".repeat(4)

test("closed commands reject URL, ref and engine routing/permission substitutions", () => {
  expect(parseCommand({ action: "create", repository: "vector/example", idempotencyKey: id })).toMatchObject({
    branch: "main",
  })
  for (const patch of [
    { repository: "https://github.com/vector/example" },
    { branch: "--upload-pack=bad" },
    { branch: "../other" },
    { directory: "/etc" },
    { ownerId: account },
    { idempotencyKey: "repeat" },
  ])
    expect(() =>
      parseCommand({ action: "create", repository: "vector/example", idempotencyKey: id, ...patch }),
    ).toThrow()
  for (const path of [
    "//other/session",
    "/session?directory=/other",
    "/session?workspace=x",
    "/session/%2e%2e/config",
    "/config",
    "/auth/provider",
    "/provider?roots=true",
    "/session?limit=1000",
    "/session?limit=1&limit=2",
  ])
    expect(() => parseCommand({ action: "engine", workspaceId: id, path, method: "GET" })).toThrow()
  expect(() =>
    parseCommand({
      action: "engine",
      workspaceId: id,
      path: "/permission/per_example/reply",
      method: "POST",
      body: { reply: "always" },
    }),
  ).toThrow()
  expect(
    parseCommand({
      action: "engine",
      workspaceId: id,
      path: "/permission/per_example/reply",
      method: "POST",
      body: { reply: "once" },
    }),
  ).toMatchObject({ body: { reply: "once" } })
  // Dot segments: the engine would see the normalized path while service.ts keys the session on the raw one (CW-24).
  const prompt = {
    messageID: "msg_0123456789abABCDEFGHIJKLMN",
    parts: [{ type: "text", text: "Make this change" }],
  }
  const engine = (method: "GET" | "POST", path: string, body?: unknown) => ({
    action: "engine" as const,
    workspaceId: id,
    path,
    method,
    ...(body === undefined ? {} : { body }),
  })
  for (const command of [
    engine("POST", "/session/ses_A/../ses_B/prompt_async", prompt),
    engine("POST", "/session/ses_A/../ses_B/message_id", { requestID: id }),
    engine("POST", "/session/ses_A/./abort"),
    engine("GET", "/session/./status"),
    engine("GET", "/session/ses_A/message/.."),
    engine("GET", "/./session?roots=true"),
    engine("POST", "/provider/../session"),
  ])
    expect(() => parseCommand(command)).toThrow("The workspace request contains unsupported or invalid fields.")
  for (const command of [
    engine("POST", "/session/ses_example/prompt_async", prompt),
    engine("POST", "/session/ses_B/message_id", { requestID: id }),
    engine("POST", "/session/ses_A/abort"),
    engine("GET", "/session/status"),
    engine("GET", "/session?roots=true"),
    engine("POST", "/session"),
  ])
    expect(parseCommand(command)).toEqual(command)
})

test("forwards explicit once confirmation without widening the permission reply body", () => {
  const command = {
    action: "engine",
    workspaceId: id,
    path: "/permission/per_example/reply",
    method: "POST",
  } as const
  for (const body of [{ reply: "once" }, { reply: "once", confirm: true }, { reply: "reject" }])
    expect(parseCommand({ ...command, body })).toEqual({ ...command, body })
  for (const body of [
    { confirm: true },
    { reply: "once", confirm: false },
    { reply: "once", confirm: "true" },
    { reply: "once", confirm: undefined },
    { reply: "reject", confirm: true },
    { reply: "always", confirm: true },
    { reply: "once", confirm: true, sessionID: "ses_other" },
  ])
    expect(() => parseCommand({ ...command, body })).toThrow()
})

test("a forwarded turn requires a stable message identity, bounded text and the hosted provider", () => {
  const command = {
    action: "engine",
    workspaceId: id,
    path: "/session/ses_example/prompt_async",
    method: "POST",
    body: {
      messageID: "msg_0123456789abABCDEFGHIJKLMN",
      parts: [{ type: "text", text: "Make this change" }],
      model: { providerID: "vector-cloud", modelID: "example-model" },
    },
  } as const
  expect(parseCommand(command)).toEqual(command)
  for (const body of [
    { ...command.body, messageID: undefined },
    { ...command.body, permission: [{ action: "allow" }] },
    { ...command.body, model: { providerID: "external", modelID: "any" } },
    { ...command.body, parts: [{ type: "file", url: "file:///etc/passwd" }] },
    { ...command.body, parts: [{ type: "text", text: "x".repeat(100001) }] },
  ])
    expect(() => parseCommand({ ...command, body })).toThrow()
})

test("connected tools reach the engine only as a conversation's reads, a run's cancel and a background review (CW-24b)", () => {
  const engine = (method: "GET" | "POST", path: string, body?: unknown) => ({
    action: "engine" as const,
    workspaceId: id,
    path,
    method,
    ...(body === undefined ? {} : { body }),
  })
  const refused = "The workspace request contains unsupported or invalid fields."
  const run = "cr_0123456789abABCDEFGHIJKLMN"
  const start = "/experimental/session/ses_example/connect"
  const review = { to: "vectorscope", target: { kind: "uncommitted" }, background: true }
  for (const command of [
    engine("GET", "/experimental/connect?sessionID=ses_example"),
    engine("GET", "/experimental/connect/runs?sessionID=ses_example"),
    engine("GET", `/experimental/connect/runs/${run}`),
    engine("POST", `/experimental/connect/runs/${run}/cancel`),
    engine("POST", `/experimental/connect/runs/${run}/cancel`, {}),
    engine("POST", start, review),
    engine("POST", start, { ...review, target: { kind: "staged" } }),
    engine("POST", start, { ...review, target: { kind: "branch" } }),
    ...["main", "origin/main", "release/2.0", "HEAD~2", "a".repeat(40), "x".repeat(256)].map((base) =>
      engine("POST", start, { ...review, target: { kind: "branch", base } }),
    ),
  ])
    expect(parseCommand(command)).toEqual(command)

  for (const command of [
    // The two lists need exactly one conversation id, and nothing else.
    ...["/experimental/connect", "/experimental/connect/runs"].flatMap((path) => [
      engine("GET", path),
      ...["other_example", "ses_", "ses_a-b", "ses_a+b", "", `ses_${"a".repeat(81)}`].map((session) =>
        engine("GET", `${path}?sessionID=${session}`),
      ),
      engine("GET", `${path}?sessionID`),
      engine("GET", `${path}?sessionID=ses_example&sessionID=ses_example`),
      ...["limit=1", "roots=true", "directory=/other", "workspace=x"].map((extra) =>
        engine("GET", `${path}?sessionID=ses_example&${extra}`),
      ),
      engine("GET", `${path}?sessionid=ses_example`),
      engine("GET", `${path}?sessionID=ses_example`, {}),
      engine("POST", path),
      engine("POST", `${path}?sessionID=ses_example`),
    ]),
    // One run is read and cancelled by its id alone.
    engine("GET", `/experimental/connect/runs/${run}?sessionID=ses_example`),
    engine("GET", `/experimental/connect/runs/${run}`, {}),
    engine("POST", `/experimental/connect/runs/${run}`),
    ...["run_0123", "cr_", "cr_a-b", `cr_${"a".repeat(62)}`].flatMap((other) => [
      engine("GET", `/experimental/connect/runs/${other}`),
      engine("POST", `/experimental/connect/runs/${other}/cancel`),
    ]),
    engine("GET", `/experimental/connect/runs/${run}/cancel`),
    engine("POST", `/experimental/connect/runs/${run}/cancel?sessionID=ses_example`),
    ...[{ sessionID: "ses_example" }, [], "x", null].map((body) =>
      engine("POST", `/experimental/connect/runs/${run}/cancel`, body),
    ),
    // No other spelling reaches these routes, including dot segments that land on one.
    ...[
      "/experimental/connect/",
      "/experimental/connect/runs/?sessionID=ses_example",
      "/experimental//connect?sessionID=ses_example",
      "/experimental/connect/./runs?sessionID=ses_example",
      `/experimental/connect/runs/${run}/`,
      `/experimental/connect/runs/cr_other/../${run}`,
      `/session/../experimental/connect/runs/${run}`,
    ].map((path) => engine("GET", path)),
    ...[
      `${start}/`,
      "/experimental/session/ses_other/../ses_example/connect",
      `/experimental/connect/runs/${run}/../../review`,
      "/session/../experimental/connect/review",
      `/experimental/connect/runs/${run}/cancel/`,
    ].map((path) => engine("POST", path, review)),
    engine("GET", start),
    engine("GET", start, review),
    engine("POST", `${start}?directory=/other`, review),
    engine("POST", "/experimental/session/other_example/connect", review),
    engine("POST", "/experimental/session/ses_a-b/connect", review),
    // Fixes, findings, dismissals, the sessionless folder review and every other experimental route stay refused.
    engine("POST", "/experimental/connect/review", { ...review, requestKey: id }),
    engine("POST", "/experimental/connect/findings", {}),
    engine("POST", `/experimental/connect/runs/${run}/dismiss`, {}),
    engine("GET", "/experimental/capabilities"),
    engine("GET", "/experimental/session/ses_example/tasks"),
    engine("POST", "/experimental/session/ses_example/stop", { helpers: false }),
    engine("POST", "/experimental/session/ses_example/review", { target: { kind: "uncommitted" } }),
  ])
    expect(() => parseCommand(command)).toThrow(refused)

  for (const body of [
    undefined,
    [],
    "review",
    null,
    { ...review, action: "review" },
    { ...review, action: "fix" },
    ...["github-agent", "VectorScope", " vectorscope", undefined].map((to) => ({ ...review, to })),
    { target: review.target, background: true },
    ...[false, "true", undefined].map((background) => ({ ...review, background })),
    { to: "vectorscope", background: true },
    ...[
      undefined,
      null,
      "uncommitted",
      { kind: "task", task: "ses_example" },
      { kind: "fix" },
      {},
      { kind: "uncommitted", base: "main" },
      { kind: "staged", extra: true },
      { kind: "branch", base: "main", since: run },
      ...["-x", "--upload-pack=x", "", "a b", "a\tb", "a\nb", "a b", "a\u007fb", "x".repeat(257), 1, null].map(
        (base) => ({ kind: "branch", base }),
      ),
    ].map((target) => ({ ...review, target })),
    ...["security", "budget", "since", "passkey", "model", "requestKey", "findings"].map((key) => ({
      ...review,
      [key]: key === "security" ? true : "x",
    })),
  ])
    expect(() => parseCommand(engine("POST", start, body))).toThrow(refused)
})

// The same inputs as the copies of these rules in desktop remote-routes.test.ts and phone client.test.ts and
// model.test.ts, so each copy is checked against the schema rather than against another copy.
const REFS = [
  "main",
  "origin/main",
  "release/2.0",
  "HEAD~2",
  "HEAD^",
  "v1.0.0",
  "a:b",
  "a..b",
  "\u00e9",
  "0123abc",
  "a".repeat(40),
  "x".repeat(256),
  "\u{1f642}".repeat(128),
  "x".repeat(257),
  "\u{1f642}".repeat(129),
  "",
  "-x",
  "--upload-pack=x",
  "a b",
  "a\tb",
  "a\nb",
  "a\u0000b",
  "a\u001fb",
  "a\u007fb",
  "a\u00a0b",
  "a\u2028b",
]
const RUNS = [
  "cr_1",
  "cr_a-b",
  "cr_a_b",
  `cr_${"a".repeat(61)}`,
  "cr_",
  `cr_${"a".repeat(62)}`,
  "CR_1",
  "run_1",
  "cr_a.b",
]

test("the connect checks agree with Connect.Ref and admit every Connect.RunID the engine makes", () => {
  const engine = (method: "GET" | "POST", path: string, body?: unknown) => ({
    action: "engine" as const,
    workspaceId: id,
    path,
    method,
    ...(body === undefined ? {} : { body }),
  })
  const refused = "The workspace request contains unsupported or invalid fields."
  for (const base of REFS) {
    const command = engine("POST", "/experimental/session/ses_example/connect", {
      to: "vectorscope",
      target: { kind: "branch", base },
      background: true,
    })
    if (Connect.Ref.makeOption(base)._tag === "Some") expect(parseCommand(command)).toEqual(command)
    else expect(() => parseCommand(command)).toThrow(refused)
  }
  const reads = (run: string) => [
    engine("GET", `/experimental/connect/runs/${run}`),
    engine("POST", `/experimental/connect/runs/${run}/cancel`),
  ]
  // Letters and digits only: every id RunID.create() makes, and nothing that is not a Connect.RunID.
  const admitted = ["cr_1", `cr_${"a".repeat(61)}`]
  for (const run of [...admitted, ...Array.from({ length: 50 }, () => Connect.RunID.create())]) {
    expect(Connect.RunID.makeOption(run)._tag).toBe("Some")
    for (const command of reads(run)) expect(parseCommand(command)).toEqual(command)
  }
  for (const run of RUNS.filter((run) => !admitted.includes(run)))
    for (const command of reads(run)) expect(() => parseCommand(command)).toThrow(refused)
})

test("public workspace decoding refuses private fields and coerced states", () => {
  const value = {
    id,
    repository: "vector/example",
    branch: "main",
    title: "Example",
    state: "running",
    createdAt: 100,
    updatedAt: 101,
    revision: 1,
  } as const
  expect(parsePublicWorkspace(value)).toEqual(value)
  for (const patch of [
    { state: ["running"] },
    { enginePassword: "secret" },
    { runtimeId: "container" },
    { updatedAt: 99 },
    { revision: 0 },
  ])
    expect(() => parsePublicWorkspace({ ...value, ...patch })).toThrow()
})

test("public workspace usage is optional and carries only whole percentages from 0 to 100", () => {
  const value = {
    id,
    repository: "vector/example",
    branch: "main",
    title: "Example",
    state: "running",
    createdAt: 100,
    updatedAt: 101,
    revision: 1,
  } as const
  for (const usage of [
    { model: 0, time: 0 },
    { model: 25, time: 50 },
    { model: 100, time: 100 },
  ]) {
    const parsed = parsePublicWorkspace({ ...value, usage })
    expect(parsed).toEqual({ ...value, usage })
    expect(parsed.usage).not.toBe(usage)
  }
  expect("usage" in parsePublicWorkspace(value)).toBe(false)
  expect("usage" in parsePublicWorkspace({ ...value, usage: undefined })).toBe(false)
  for (const usage of [
    { model: 101, time: 0 },
    { model: 0, time: 101 },
    { model: -1, time: 0 },
    { model: 0, time: -1 },
    { model: 25.5, time: 0 },
    { model: 0, time: 0.5 },
    { model: Number.NaN, time: 0 },
    { model: Infinity, time: 0 },
    { model: "25", time: 0 },
    { model: null, time: 0 },
    { model: 25 },
    { time: 0 },
    {},
    null,
    [25, 50],
    25,
    "25%",
    true,
    { model: 25, time: 0, modelCalls: 1 },
    { model: 25, time: 0, runningSince: 1 },
    { model: 25, time: 0, maxCalls: 4 },
  ])
    expect(() => parsePublicWorkspace({ ...value, usage })).toThrow()
})

test("host signatures bind actor, exact bytes, route, verb and current timestamp", () => {
  const input = {
    secret,
    accountId: account,
    method: "POST",
    path: "/workspaces",
    body: '{"title":"example"}',
    now: 1780000000000,
    nonce: id,
  }
  const headers = new Headers(signWorkspaceRequest(input))
  expect(verifyWorkspaceRequest({ ...input, headers })).toMatchObject({ accountId: account, nonce: id })
  for (const patch of [
    { method: "GET" },
    { path: "/workspaces/other" },
    { body: '{"title":"changed"}' },
    { now: input.now + 60001 },
  ])
    expect(() => verifyWorkspaceRequest({ ...input, headers, ...patch })).toThrow()
  headers.set("x-vector-account", id)
  expect(() => verifyWorkspaceRequest({ ...input, headers })).toThrow()
  // The signature covers the id as sent; the verified id is lower-case, as the store and the account fence keep it.
  const upper = new Headers(signWorkspaceRequest({ ...input, accountId: account.toUpperCase() }))
  expect(verifyWorkspaceRequest({ ...input, headers: upper }).accountId).toBe(account.toLowerCase())
  upper.set("x-vector-account", account.toLowerCase())
  expect(() => verifyWorkspaceRequest({ ...input, headers: upper })).toThrow()
})
