// CI-only entrypoint coverage: the published CLI gate must also stay silent, before the status handler runs.
import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

const network = NetworkGuard.use()

for (const command of ["codium", "credits"]) {
  cliIt.live(
    `Actions ${command} reads no account status and prints nothing through the real CLI gate`,
    ({ vector, llm }) =>
      Effect.gen(function* () {
        const calls: string[] = []
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                calls.push(new URL(request.url).pathname)
                return new Response("Unexpected account request", { status: 500 })
              },
            }),
          ),
          (server) =>
            Effect.sync(() => {
              server.stop(true)
            }),
        )
        const result = yield* vector.actionsStep([command], {
          env: {
            VECTOR_CLI: "1",
            GITHUB_ACTIONS: "true",
            VECTOR_CLI_TOKEN: "synthetic-status-credential",
            VECTOR_SITE_URL: `http://127.0.0.1:${server.port}`,
            VECTOR_DISABLE_USAGE: "1",
          },
          timeoutMs: 25_000,
        })
        vector.expectExit(result, 0, command)
        expect(result.stdout).toBe("")
        expect(result.stderr).toBe("")
        expect(calls).toEqual([])
        expect(yield* llm.calls).toBe(0)
        expect(network.outside()).toEqual([])
      }),
    30_000,
  )
}
