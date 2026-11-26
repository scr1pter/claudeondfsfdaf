import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { coldHolderScript, startupTimeline } from "../../script/diagnose-windows-holder"
import { WindowsHolder } from "../../src/tool/shell/windows-holder"

const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../../../.github/workflows/windows-containment.yml", import.meta.url), "utf8"),
) as {
  jobs: Record<
    string,
    {
      "runs-on"?: string
      needs?: string
      env?: Record<string, string>
      with?: Record<string, unknown>
      steps?: { run?: string; with?: Record<string, unknown> }[]
      strategy?: { "fail-fast"?: boolean; matrix?: { include?: { arch: string; runner: string }[] } }
    }
  >
}

test("the first containment probe stays independent of both native integration runners", () => {
  const { "cold-start": cold, native } = workflow.jobs
  expect(cold["runs-on"]).toBe("windows-latest")
  expect(cold.needs).toBeUndefined()
  expect(cold.steps?.some((step) => step.run?.includes("diagnose-windows-holder"))).toBe(true)
  expect(native.needs).toBe("windows-holder-build")
})

test("both native architectures use the same verified holder build", () => {
  const { "windows-holder-build": producer, native } = workflow.jobs
  expect(producer.with?.targets).toBe("x64,arm64")
  expect(native["runs-on"]).toBe("${{ matrix.runner }}")
  expect(native.strategy).toEqual({
    "fail-fast": false,
    matrix: {
      include: [
        { arch: "x64", runner: "windows-latest" },
        { arch: "arm64", runner: "windows-11-arm" },
      ],
    },
  })
  expect(native.env).toMatchObject({
    VECTOR_WINDOWS_HOLDER_ARCH: "${{ matrix.arch }}",
    VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256: "${{ needs.windows-holder-build.outputs.manifest-digest }}",
  })
  expect(
    native.steps?.some((step) => step.with?.["artifact-ids"] === "${{ needs.windows-holder-build.outputs.artifact-id }}"),
  ).toBe(true)
  expect(native.steps?.find((step) => step.run?.includes("shell-windows-process.test"))?.run).toContain(
    "--preload=./script/windows-holder-ci.ts",
  )
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
