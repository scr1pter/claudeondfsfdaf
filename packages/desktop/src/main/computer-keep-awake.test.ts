import { expect, test } from "bun:test"
import { createComputerKeepAwake } from "./keep-awake"

function fixture() {
  const tasks = new Map<number, { at: number; run: () => void }>()
  const calls: string[] = []
  let now = 0
  let next = 0
  const clock = {
    setTimeout(run: () => void, ms: number) {
      const id = ++next
      tasks.set(id, { at: now + ms, run })
      return id
    },
    clearTimeout(id: unknown) {
      tasks.delete(Number(id))
    },
    advance(ms: number) {
      const end = now + ms
      while (true) {
        const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        tasks.delete(due[0])
        due[1].run()
      }
      now = end
    },
  }
  let token = 0
  const hold = createComputerKeepAwake({
    clock,
    blocker: {
      start() {
        const id = token++
        calls.push(`start:${id}`)
        return id
      },
      stop(id) {
        calls.push(`stop:${id}`)
      },
    },
  })
  return { hold, clock, tasks, calls }
}

test("Hands holds its own blocker, including token zero, and policy revokes it immediately", () => {
  const fake = fixture()
  fake.hold.update({ phase: "working", allowed: true })
  fake.hold.update({ phase: "working", allowed: true })
  expect(fake.calls).toEqual(["start:0"])
  fake.hold.update({ phase: "working", allowed: false })
  expect(fake.calls).toEqual(["start:0", "stop:0"])
  fake.hold.close()
  expect(fake.calls).toHaveLength(2)
})

test("continuous waiting ends the display hold at two minutes despite repeated state updates", () => {
  const fake = fixture()
  fake.hold.update({ phase: "working", allowed: true })
  fake.hold.update({ phase: "asking", allowed: true })
  fake.clock.advance(60_000)
  fake.hold.update({ phase: "handoff", allowed: true })
  fake.clock.advance(59_999)
  expect(fake.calls).toEqual(["start:0"])
  fake.clock.advance(1)
  expect(fake.calls).toEqual(["start:0", "stop:0"])
  fake.hold.update({ phase: "waiting", allowed: true })
  expect(fake.calls).toHaveLength(2)
})

test("resumed work cancels an old wait deadline and starts a new hold only when needed", () => {
  const fake = fixture()
  fake.hold.update({ phase: "working", allowed: true })
  fake.hold.update({ phase: "waiting", allowed: true })
  const old = [...fake.tasks.values()][0]!.run
  fake.hold.update({ phase: "working", allowed: true })
  old()
  fake.clock.advance(120_000)
  expect(fake.calls).toEqual(["start:0"])
  fake.hold.update({ phase: "paused", pause: "away", allowed: true })
  expect(fake.calls).toEqual(["start:0", "stop:0"])
  fake.hold.update({ phase: "working", allowed: true })
  expect(fake.calls.at(-1)).toBe("start:1")
  fake.hold.close()
  expect(fake.calls.at(-1)).toBe("stop:1")
})

test("away, lock, suspend and ending release immediately; waiting alone never starts a hold", () => {
  for (const pause of ["away", "locked", "suspend", "secure_desktop"] as const) {
    const fake = fixture()
    fake.hold.update({ phase: "paused", pause, allowed: true })
    expect(fake.calls).toEqual([])
    fake.hold.update({ phase: "working", allowed: true })
    fake.hold.update({ phase: "paused", pause, allowed: true })
    expect(fake.calls).toEqual(["start:0", "stop:0"])
    expect(fake.tasks.size).toBe(0)
  }
  const fake = fixture()
  fake.hold.update({ phase: "working", allowed: true })
  fake.hold.update({ phase: "done", allowed: true })
  expect(fake.calls).toEqual(["start:0", "stop:0"])
})
