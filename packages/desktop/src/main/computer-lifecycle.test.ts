import { expect, test } from "bun:test"
import { createComputerLifecycle } from "./computer-lifecycle"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("quit during startup disposes the late runtime without publishing it", async () => {
  const ready = deferred<{ stop(): Promise<void> }>()
  const stopped = deferred<void>()
  const published: unknown[] = []
  let stops = 0
  const owner = createComputerLifecycle((runtime) => published.push(runtime))
  const starting = owner.start(() => ready.promise)
  const closing = owner.stop()
  ready.resolve({
    stop() {
      stops++
      return stopped.promise
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(published).toEqual([undefined])
  let finished = false
  void closing.then(() => {
    finished = true
  })
  await Promise.resolve()
  expect(finished).toBe(false)
  stopped.resolve()
  await closing
  expect(await starting).toBeUndefined()
  expect(stops).toBe(1)
  expect(
    await owner.start(async () => {
      throw new Error("closed factory ran")
    }),
  ).toBeUndefined()
})

test("engine failure and quit revoke the exact runtime synchronously and dispose once", async () => {
  const pending = deferred<void>()
  const events: string[] = []
  const runtime = {
    stop() {
      events.push("stop")
      return pending.promise
    },
  }
  const owner = createComputerLifecycle<typeof runtime>((next) => events.push(next ? "publish" : "detach"))
  await owner.start(async () => runtime)
  const retired = owner.retire(runtime)
  expect(events).toEqual(["publish", "detach", "stop"])
  const closing = owner.stop()
  expect(events.filter((event) => event === "stop")).toHaveLength(1)
  pending.resolve()
  await Promise.all([retired, closing])
})
