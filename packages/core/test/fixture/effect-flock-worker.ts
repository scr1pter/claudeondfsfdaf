import fs from "fs/promises"
import os from "os"
import { Cause, Effect, Exit } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { Global } from "@vectordevai/core/global"

type Msg = {
  key: string
  dir: string
  holdMs?: number
  ready?: string
  active?: string
  done?: string
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

const msg: Msg = JSON.parse(process.argv[2])

const testGlobal = Global.layerWith({
  home: os.homedir(),
  data: os.tmpdir(),
  cache: os.tmpdir(),
  config: os.tmpdir(),
  state: os.tmpdir(),
  bin: os.tmpdir(),
  log: os.tmpdir(),
})

const testLayer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, testGlobal]])

async function job() {
  if (msg.ready) await fs.writeFile(msg.ready, String(process.pid))
  if (msg.active) await fs.writeFile(msg.active, String(process.pid), { flag: "wx" })

  try {
    if (msg.holdMs && msg.holdMs > 0) await sleep(msg.holdMs)
    if (msg.done) await fs.appendFile(msg.done, "1\n")
  } finally {
    if (msg.active) await fs.rm(msg.active, { force: true })
  }
}

const exit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    yield* flock.withLock(
      Effect.promise(() => job()),
      msg.key,
      msg.dir,
    )
  }).pipe(Effect.provide(testLayer)),
)

// Report every error and defect in the cause, with nested system errors (code, syscall, path); the tests print it
// when a worker exits non-zero. exitCode is set first so the worker still exits 1 if the process exits before the
// write callback runs.
if (Exit.isFailure(exit)) {
  process.exitCode = 1
  process.stderr.write(
    `effect-flock-worker ${process.pid} failed at ${new Date().toISOString()}\n${Cause.pretty(exit.cause)}\n`,
    () => process.exit(1),
  )
}
