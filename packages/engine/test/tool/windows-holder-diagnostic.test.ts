import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { PassThrough, Writable } from "node:stream"
import { coldHolderScript, observeHolder, startupTimeline } from "../../script/diagnose-windows-holder"
import { WindowsHolder } from "../../src/tool/shell/windows-holder"

const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../../../.github/workflows/windows-containment.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, { "runs-on": string; steps: { run?: string }[] }> }

test("the first containment probe has its own Windows host and never warms the native integration runner", () => {
  const jobs = Object.values(workflow.jobs)
  const diagnostic = jobs.find((job) => job.steps.some((step) => step.run?.includes("diagnose-windows-holder")))
  const integration = jobs.find((job) => job.steps.some((step) => step.run?.includes("shell-windows-process.test")))
  expect(diagnostic).toBeDefined()
  expect(integration).toBeDefined()
  expect(diagnostic).not.toBe(integration)
  expect(diagnostic!["runs-on"]).toBe("windows-latest")
  expect(integration!["runs-on"]).toBe("windows-latest")
})

test("the cold probe adds only fixed phase writes to the production holder and fits the command line", () => {
  const script = coldHolderScript()
  const removeMarkers =
    /\[Console\]::Error\.WriteLine\('VECTOR_HOLDER_PHASE [a-z-]+'\); |Console\.Error\.WriteLine\("VECTOR_HOLDER_PHASE [a-z-]+"\); /g
  expect(script.match(removeMarkers)).toHaveLength(8)
  expect(script.replace(removeMarkers, "")).toBe(WindowsHolder.script)
  expect(script).not.toContain("Get-Command")
  expect(Buffer.from(script, "utf16le").toString("base64").length).toBeLessThanOrEqual(32_000)
  const stages = [
    "host-entered",
    "utility-loaded",
    "compiler-returned",
    "reading-config",
    "config-decoded",
    "job-configured",
    "creating-payload",
    "payload-created",
    "ready",
  ] as const
  const timeline = startupTimeline()
  expect(timeline.add("ready", 0)).toBe(false)
  expect(timeline.add("arbitrary process text", 0)).toBe(false)
  for (let i = 0; i < stages.length; i++) expect(timeline.add(stages[i], 2.1 * i)).toBe(true)
  expect(timeline.phases).toEqual(stages.map((phase, i) => ({ phase, elapsedMs: Math.round(2.1 * i) })))
  expect(timeline.add("ready", 120)).toBe(false)
})

function fakeLaunch() {
  let now = 0
  let killed = 0
  let written: (() => void) | undefined
  const writes: string[] = []
  const timers = new Map<number, () => void>()
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString())
        written = callback
      },
    }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      killed++
    },
  })
  const config = '{"file":"fixture-private-command"}\n'
  const timeline = startupTimeline()
  const result = observeHolder(
    () => {
      now = 43
      return child
    },
    () => config,
    timeline,
    {
      now: () => now,
      schedule(run, delay) {
        const at = now + delay
        timers.set(at, run)
        return () => {
          timers.delete(at)
        }
      },
    },
  )
  return {
    child,
    config,
    result,
    timeline,
    timers,
    writes,
    completedWrite: () => written?.(),
    killed: () => killed,
    at: (time: number, run: () => void) => {
      now = time
      run()
    },
  }
}

test("a cold timeout with no pipe bytes preserves launch and cleanup timings", async () => {
  const probe = fakeLaunch()
  probe.at(57, () => probe.child.emit("spawn"))
  probe.at(76, probe.completedWrite)
  expect([...probe.timers.keys()]).toEqual([15_000, 20_043])
  probe.at(15_000, probe.timers.get(15_000)!)
  probe.at(15_081, () => probe.child.emit("exit"))
  probe.at(15_104, () => probe.child.emit("close"))
  const result = await probe.result
  expect(result).toEqual({
    phase: "spawn",
    ready: false,
    closed: true,
    proven: false,
    timedOut: true,
    timedOutAtMs: 15_000,
    delivery: {
      launchReturnedMs: 40,
      spawnEventMs: 60,
      configWrittenMs: 80,
      watchdogMs: 15_000,
      exitMs: 15_080,
      closeMs: 15_100,
    },
  })
  expect(probe.writes).toEqual([probe.config])
  expect(probe.killed()).toBe(1)
  expect(probe.timers.size).toBe(0)
})

test("stderr bytes and the first complete startup marker have separate timings", async () => {
  const probe = fakeLaunch()
  probe.at(60, probe.completedWrite)
  probe.at(217, () => probe.child.stderr.write('VECTOR_SHELL/1 {"type":"startup",'))
  probe.at(353, () => probe.child.stderr.write('"step":1}\nVECTOR_HOLDER_PHASE host-entered\n'))
  probe.at(15_000, probe.timers.get(15_000)!)
  probe.at(15_063, () => probe.child.emit("close"))
  const result = await probe.result
  expect(result).toMatchObject({
    phase: "host-entered",
    timedOut: true,
    ready: false,
    delivery: { firstStderrMs: 220, firstMarkerMs: 350, watchdogMs: 15_000, closeMs: 15_060 },
  })
  expect(probe.timeline.phases).toEqual([{ phase: "host-entered", elapsedMs: 353 }])
  expect(JSON.stringify(result)).not.toContain("fixture-private-command")
  expect(probe.writes).toEqual([probe.config])
})
