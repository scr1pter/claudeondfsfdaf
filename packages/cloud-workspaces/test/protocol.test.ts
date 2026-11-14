import { expect, test } from "bun:test"
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
})
