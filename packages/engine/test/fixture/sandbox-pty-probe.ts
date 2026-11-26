import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Config } from "@vectordevai/core/config"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Location } from "@vectordevai/core/location"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { Project } from "@vectordevai/core/project"
import { Pty } from "@vectordevai/core/pty"
import { AbsolutePath } from "@vectordevai/core/schema"
import { Effect, Layer, References } from "effect"
import { descriptorReceipt, inspectOwnDescriptorMetadata } from "./sandbox-fd-observation"

export async function probePtyDescriptors(syntheticProof: string) {
  if (process.env.BUN_PTY_LIB !== undefined || process.env.NODE_PATH !== undefined)
    throw new Error("The PTY fixture requires its staged runtime without loader overrides")
  const root = path.dirname(fileURLToPath(import.meta.url))
  const bun = !!process.versions.bun
  const native = bun
    ? "rust-pty/target/release/librust_pty.so"
    : "node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node"
  if (!(await fs.lstat(path.join(root, native))).isFile()) throw new Error("The staged PTY adapter is missing")

  const directory = AbsolutePath.make(process.cwd())
  const layer = AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of({ directory, project: { id: Project.ID.global, directory } }),
      ),
    ],
  ])
  const code = `
    if (!process.stdout.isTTY) process.exit(7);
    const receipt = (${inspectOwnDescriptorMetadata})(${JSON.stringify(syntheticProof)});
    process.stdout.write(JSON.stringify(receipt));
  `
  const guard = EgressGuard.installStrict()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const terminal = yield* Pty.Service
        const info = yield* Effect.acquireRelease(
          terminal.create({
            command: process.execPath,
            args: [...(bun ? ["--no-install"] : []), "-e", code],
            cwd: directory,
          }),
          (info) => terminal.remove(info.id).pipe(Effect.ignore),
        )
        for (;;) {
          const result = yield* terminal.read(info.id, { limit: 512 })
          if (result.info.status === "exited") {
            if (result.info.exitCode !== 0 || result.cursor !== result.end)
              throw new Error("The staged PTY child did not complete with bounded output")
            const receipt: unknown = yield* Effect.try({
              try: () => JSON.parse(result.output.trim()),
              catch: () => new Error("The staged PTY child did not report descriptor metadata"),
            })
            if (!descriptorReceipt(receipt, false))
              throw new Error("The actual PTY did not exclude the synthetic proof")
            return
          }
          yield* Effect.sleep("25 millis")
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(layer),
        Effect.provideService(References.MinimumLogLevel, "None"),
        Effect.timeout("8 seconds"),
      ),
    )
    if (guard.attempts().some((attempt) => !attempt.allowed))
      throw new Error("The PTY fixture attempted external access")
  } finally {
    guard.uninstall()
  }
}
