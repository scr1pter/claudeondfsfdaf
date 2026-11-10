import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Redacted } from "effect"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { ServerAuth } from "@vectordevai/server/auth"

// packages/server keeps its own copy of the auth config, which its routes and
// authorization middleware use, so the earlier-username guarantees are checked there too.
function loadConfig(input: Record<string, string>) {
  return Effect.runPromise(
    ServerAuth.Config.pipe(
      Effect.provide(ServerAuth.Config.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))),
    ),
  )
}

describe("@vectordevai/server auth", () => {
  test("accepts the earlier default username with the owner password while no username is configured", async () => {
    const config = await loadConfig({ VECTOR_SERVER_PASSWORD: "secret" })
    for (const username of ["vector", legacyName!])
      expect(ServerAuth.identity({ username, password: Redacted.make("secret") }, config)).toBe("owner")
    expect(ServerAuth.identity({ username: legacyName!, password: Redacted.make("wrong") }, config)).toBeUndefined()
    expect(ServerAuth.identity({ username: "unrelated", password: Redacted.make("secret") }, config)).toBeUndefined()
  })

  test("a configured username is the only owner username", async () => {
    const config = await loadConfig({ VECTOR_SERVER_PASSWORD: "secret", VECTOR_SERVER_USERNAME: "alice" })
    expect(ServerAuth.identity({ username: "alice", password: Redacted.make("secret") }, config)).toBe("owner")
    for (const username of ["vector", legacyName!])
      expect(ServerAuth.identity({ username, password: Redacted.make("secret") }, config)).toBeUndefined()
  })

  test("does not hint a different username to a client sending the earlier default", async () => {
    const config = await loadConfig({ VECTOR_SERVER_PASSWORD: "secret" })
    expect(ServerAuth.unauthorizedMessage({ username: legacyName!, password: Redacted.make("wrong") }, config)).toBe(
      "Authentication required",
    )
    expect(ServerAuth.unauthorizedMessage({ username: "unrelated", password: Redacted.make("secret") }, config)).toBe(
      "Authentication required. Use the configured server username: vector.",
    )
  })
})

describe("workflow route ownership", () => {
  test("saved and validation require owner identity before the general GET allowance", () => {
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/workflow/saved")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/workflow/validate")).toBe(true)
  })
  test("start and resume require owner identity while reads remain accessible to allowed guests", () => {
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/session/:sessionID/workflow")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/session/:sessionID/workflow/:runID/resume")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/session/:sessionID/workflow")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/session/:sessionID/workflow/:runID")).toBe(false)
  })
})
