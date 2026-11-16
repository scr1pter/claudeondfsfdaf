import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "../../src/cross-spawn-spawner"
import { LayerNode } from "../../src/effect/layer-node"
import { ProcessIsolation } from "../../src/process-isolation"

// A separate process keeps the irreversible production isolation switch out of unrelated tests.
ProcessIsolation.requireIsolation()
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* spawner
      .string(
        ChildProcess.make(
          process.execPath,
          ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", process.argv[2]!],
          {
            env: { LD_PRELOAD: "refused-test-loader" },
          },
        ),
      )
      .pipe(
        Effect.match({
          onSuccess: () => ({ refused: false, message: "" }),
          onFailure: (error) => ({
            refused: true,
            module: error.reason.module,
            method: error.reason.method,
            message: error.reason.cause instanceof Error ? error.reason.cause.message : "",
          }),
        }),
      )
  }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)), Effect.scoped),
)
console.log(JSON.stringify(result))
