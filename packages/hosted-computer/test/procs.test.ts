import { describe, expect, test } from "bun:test"
import { continueAll, parseStat, parseUid, stopAll, ToolCalls, type Proc, type ProcTable } from "../src/procs"

// WP A54: hostd pauses every agent process during a take-over and while git holds a token, and when a tool call ends
// it kills what the call left running: its process group, and anything started during it that left the agent's tree.

function table(initial: Proc[]) {
  const procs = [...initial]
  const signals: [number, string][] = []
  const fake: ProcTable & { procs: Proc[]; signals: [number, string][] } = {
    procs,
    signals,
    async list() {
      return procs.map((proc) => ({ ...proc }))
    },
    signal(pid, signal) {
      signals.push([pid, signal])
    },
  }
  return fake
}
const proc = (pid: number, ppid: number, extra: Partial<Proc> = {}): Proc => ({ pid, ppid, pgid: pid, uid: 10001, start: pid * 10, state: "S", ...extra })

describe("/proc", () => {
  test("stat lines are read after the command name, whatever it holds", () => {
    const line = "4242 (evil) name (x)) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000 10 18446744073709551615"
    expect(parseStat(line)).toEqual({ state: "S", ppid: 1, pgid: 4242, start: 98765 })
    expect(parseStat("garbage")).toBeUndefined()
    expect(parseUid("Name:\tnode\nUid:\t10001\t10001\t10001\t10001\n")).toBe(10001)
  })
})

describe("pausing the agent", () => {
  test("every process of the agent's user is stopped, including one forked between passes; others are left alone", async () => {
    const fake = table([proc(100, 1), proc(101, 100), proc(50, 1, { uid: 0 }), proc(60, 1, { uid: 10004 })])
    const original = fake.list.bind(fake)
    let passes = 0
    fake.list = async () => {
      passes++
      if (passes === 2) fake.procs.push(proc(102, 101))
      return original()
    }
    expect(await stopAll(fake, 10001)).toBe(3)
    expect(fake.signals).toEqual([
      [100, "SIGSTOP"],
      [101, "SIGSTOP"],
      [102, "SIGSTOP"],
    ])
    fake.signals.length = 0
    await continueAll(fake, 10001)
    expect(fake.signals.map(([pid]) => pid).sort()).toEqual([100, 101, 102])
  })
})

describe("tool calls", () => {
  test("ending a call kills its process group and escaped processes, never the agent or what it keeps", async () => {
    // 100 is the agent; 110 its language server, started before the call.
    const fake = table([proc(100, 1), proc(110, 100)])
    const calls = new ToolCalls(fake, 10001, () => 100)
    await calls.begin("call-1", 200)
    fake.procs.push(
      proc(200, 100, { pgid: 200 }), // the call's shell
      proc(201, 200, { pgid: 200 }), // a background job in the call's group
      proc(300, 1, { pgid: 300 }), // a double fork that left the agent's tree
      proc(120, 100, { pgid: 100 }), // the agent starts another server of its own during the call
      proc(400, 1, { uid: 10004 }), // the browser's process: not the agent's
    )
    expect(await calls.end("call-1")).toBe(3)
    expect(fake.signals.map(([pid, signal]) => `${pid}:${signal}`).sort()).toEqual(["200:SIGKILL", "201:SIGKILL", "300:SIGKILL"])
  })

  test("a reused pid is a new process; unknown calls kill nothing", async () => {
    const fake = table([proc(100, 1), proc(500, 1, { start: 1 })])
    const calls = new ToolCalls(fake, 10001, () => 100)
    await calls.begin("call-2")
    fake.procs[1] = proc(500, 1, { start: 2 })
    expect(await calls.end("call-2")).toBe(1)
    expect(await calls.end("never-began")).toBe(0)
  })
})
