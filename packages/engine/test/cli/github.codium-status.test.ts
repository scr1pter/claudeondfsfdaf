import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { codiumStatus } from "../../src/cli/cmd/codium"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mock(Auth.Service, {}))

it.effect("Actions status returns before reading account credentials or fetching plan usage", () =>
  Effect.gen(function* () {
    // The empty Auth mock defects on every method. Reaching it would fail this test before any status fetch.
    expect(yield* codiumStatus({ GITHUB_ACTIONS: "true", VECTOR_CLI_TOKEN: "synthetic-private" })).toBeUndefined()
  }),
)
