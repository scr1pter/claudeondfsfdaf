import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Hands } from "@vectordevai/schema/hands"
import { cliIt } from "../lib/cli-process"

describe("vector mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, vector }) =>
      Effect.gen(function* () {
        const result = yield* vector.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        vector.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(path.join(home, ".config", "vector", "vector.json")).json())
        expect(config.mcp.github).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, vector }) =>
      Effect.gen(function* () {
        const result = yield* vector.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        vector.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(path.join(home, ".config", "vector", "vector.json")).json())
        expect(config.mcp.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "refuses a server named computer, in any letter case, before writing the config",
    ({ home, vector }) =>
      Effect.gen(function* () {
        const result = yield* vector.spawn(["mcp", "add", "Computer", "--", "node", "server.js"])
        vector.expectExit(result, 1)
        expect(result.stderr).toContain('MCP server "Computer" cannot be used')
        expect(result.stderr).toContain(Hands.NAME)

        const file = Bun.file(path.join(home, ".config", "vector", "vector.json"))
        const config = (yield* Effect.promise(() => file.exists())) ? yield* Effect.promise(() => file.json()) : {}
        expect(config.mcp?.Computer).toBeUndefined()
      }),
    60_000,
  )
})
