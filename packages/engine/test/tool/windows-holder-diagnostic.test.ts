import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { coldHolderScript, startupTimeline } from "../../script/diagnose-windows-holder"
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
