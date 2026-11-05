import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  NATIVE_UNIT_SUITES,
  NativeUnitProgressReader,
  nativeCommandDiagnostic,
  nativeUnitProgress,
  sanitizeNativeUnitSample,
  writeNativeUnitDiagnostic,
} from "./computer-helper-command-diagnostics"

const diagnostic = () => ({
  schemaVersion: 1,
  trigger: "wall-deadline",
  spawned: true,
  exitObserved: false,
  closeObserved: false,
  signaled: false,
  stdoutBytes: 0,
  stderrBytes: 0,
  elapsedMs: 30_000,
  sample: { status: "sampled", suites: ["runProtocolTests"], waits: ["mutex-wait"] },
})

describe("closed native command diagnostics", () => {
  test("retains only known suite frames and fixed waits, never headers, paths or sample payloads", () => {
    const raw = [
      "Command: /private/owner/runAppsTests --typedText secret",
      "Thread names include runCaptureTests",
      "    + 123 VectorComputer.runProtocolTests() throws -> Swift.Int (in VectorComputerTests) + 42 [0x1234]",
      "    + 123 __psynch_mutexwait (in libsystem_kernel.dylib) + 10 [0x9876]",
      "      12 _dispatch_semaphore_wait_slow (in libdispatch.dylib) + 1 [0x9876]",
      "      12 runOwnerPrivateTests typedText-secret [0x1111]",
      "runAppsTests fake no frame",
    ].join("\n")
    expect(sanitizeNativeUnitSample(raw)).toEqual({
      suites: ["runProtocolTests"],
      waits: ["dispatch-wait", "mutex-wait"],
    })
    expect(JSON.stringify(sanitizeNativeUnitSample(raw))).not.toMatch(/private|typedText|secret|0x|Command|owner/i)
    expect(sanitizeNativeUnitSample("1 start [0x1]\n" + "x".repeat(270_000) + "\n1 runAppsTests [0x2]").suites).toEqual(
      [],
    )
  })

  test("catalog is exact and sample output is canonical", async () => {
    expect(NATIVE_UNIT_SUITES).toHaveLength(24)
    expect(new Set(NATIVE_UNIT_SUITES).size).toBe(24)
    const main = await readFile(new URL("../native/computer-helper/macos/Tests/main.swift", import.meta.url), "utf8")
    expect(
      [...main.matchAll(/^\s*(?:_\s*=\s*)?try\s+(run[A-Za-z0-9]+Tests)\(\)\s*$/gm)].map((match) => match[1]),
    ).toEqual([...NATIVE_UNIT_SUITES])
    const value = diagnostic()
    value.sample.suites = ["runAppsTests", "runProtocolTests"]
    expect(nativeCommandDiagnostic(value).sample.suites).toEqual(["runProtocolTests", "runAppsTests"])
  })

  test("rejects extra fields and arbitrary sample/error content at every output level", () => {
    for (const extra of ["argv", "pid", "path", "stderr", "typedText", "imageBytes", "rawSample"]) {
      expect(() => nativeCommandDiagnostic({ ...diagnostic(), [extra]: "private" })).toThrow()
      expect(() =>
        nativeCommandDiagnostic({ ...diagnostic(), sample: { ...diagnostic().sample, [extra]: "private" } }),
      ).toThrow()
    }
    expect(() => nativeCommandDiagnostic({ ...diagnostic(), trigger: "owner-secret" })).toThrow()
    expect(() =>
      nativeCommandDiagnostic({
        ...diagnostic(),
        sample: { status: "sampled", suites: ["runPrivateOwnerTests"], waits: [] },
      }),
    ).toThrow()
    expect(() =>
      nativeCommandDiagnostic({ ...diagnostic(), sample: { status: "sampled", suites: [], waits: ["private-stack"] } }),
    ).toThrow()
    expect(() =>
      nativeCommandDiagnostic({
        ...diagnostic(),
        sample: { status: "failed", suites: ["runProtocolTests"], waits: [] },
      }),
    ).toThrow()
  })

  test("rejects impossible counters, observations and duplicate facts", () => {
    for (const number of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => nativeCommandDiagnostic({ ...diagnostic(), stdoutBytes: number })).toThrow()
      expect(() => nativeCommandDiagnostic({ ...diagnostic(), elapsedMs: number })).toThrow()
    }
    expect(() => nativeCommandDiagnostic({ ...diagnostic(), exitObserved: true })).toThrow()
    expect(() => nativeCommandDiagnostic({ ...diagnostic(), closeObserved: true, closeAfterMs: 1 })).toThrow()
    expect(() =>
      nativeCommandDiagnostic({ ...diagnostic(), spawned: false, exitObserved: true, exitAfterMs: 1 }),
    ).toThrow()
    expect(() =>
      nativeCommandDiagnostic({
        ...diagnostic(),
        sample: { status: "sampled", suites: ["runProtocolTests", "runProtocolTests"], waits: [] },
      }),
    ).toThrow()
    expect(nativeCommandDiagnostic({ ...diagnostic(), exitObserved: true, exitAfterMs: 1 }).closeObserved).toBe(false)
  })

  test("writes only the validated sidecar beside an explicit path and refuses linked files", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "vector-native-unit-diagnostic-"))
    try {
      const report = path.join(scratch, "check.json")
      const sidecar = report + ".unit-diagnostic.json"
      const value = nativeCommandDiagnostic(diagnostic())
      await writeNativeUnitDiagnostic(report, value)
      expect(JSON.parse(await readFile(sidecar, "utf8"))).toEqual(value)
      await expect(writeNativeUnitDiagnostic("relative.json", value)).rejects.toThrow()
      await expect(writeNativeUnitDiagnostic(report, { ...value, argv: "secret" } as typeof value)).rejects.toThrow()
      expect(JSON.parse(await readFile(sidecar, "utf8"))).toEqual(value)
      const original = path.join(scratch, "owned-original.json")
      await writeFile(original, "unchanged")
      await rm(sidecar)
      await link(original, sidecar)
      await expect(writeNativeUnitDiagnostic(report, value)).rejects.toThrow()
      expect(await readFile(original, "utf8")).toBe("unchanged")
      await rm(sidecar)
      await symlink(original, sidecar)
      await expect(writeNativeUnitDiagnostic(report, value)).rejects.toThrow()
      expect(await readFile(original, "utf8")).toBe("unchanged")
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

describe("actual unit stderr progress", () => {
  const line = (value: string) => "vector-unit-progress " + value + "\n"
  const all = () =>
    line("ENTER") +
    NATIVE_UNIT_SUITES.map((suite) => line("BEGIN " + suite) + line("PASS " + suite)).join("") +
    line("COMPLETE")

  test("recognizes exact ordered progress across byte boundaries and ordinary private stderr", () => {
    const reader = new NativeUnitProgressReader()
    expect(reader.snapshot()).toEqual({ entered: false, passed: 0, complete: false, invalid: false })
    const bytes = Buffer.from("private-stderr-without-proof\n" + all().replaceAll("\n", "\r\n"))
    for (const byte of bytes) reader.consume(Buffer.from([byte]))
    expect(reader.finish()).toEqual({ entered: true, passed: 24, complete: true, invalid: false })
    expect(JSON.stringify(reader.snapshot())).not.toContain("private")
  })

  test("retains only the latest exact active suite and contiguous passed count", () => {
    const reader = new NativeUnitProgressReader()
    reader.consume(Buffer.from(line("ENTER") + line("BEGIN runCommandLineTests")))
    expect(reader.snapshot()).toEqual({
      entered: true,
      passed: 0,
      active: "runCommandLineTests",
      complete: false,
      invalid: false,
    })
    reader.consume(Buffer.from(line("PASS runCommandLineTests") + line("BEGIN runProtocolTests")))
    expect(reader.finish()).toEqual({
      entered: true,
      passed: 1,
      active: "runProtocolTests",
      complete: false,
      invalid: false,
    })
    reader.consume(Buffer.from(all()))
    expect(reader.snapshot().passed).toBe(1)
  })

  test("refuses unknown, duplicate, skipped, reordered and partial reserved markers", () => {
    for (const body of [
      line("BEGIN runCommandLineTests"),
      line("ENTER") + line("ENTER"),
      line("ENTER") + line("BEGIN runProtocolTests"),
      line("ENTER") + line("PASS runCommandLineTests"),
      line("ENTER") + line("BEGIN runPrivateOwnerTests"),
      line("ENTER") + line("BEGIN runCommandLineTests secret"),
      line("ENTER") + line("COMPLETE"),
      all() + line("COMPLETE"),
      line("ENTER") + "vector-unit-progress BEGIN runCommandLineTests",
      line("ENTER") + "vector-unit-progress " + "private".repeat(50) + "\n",
    ]) {
      const reader = new NativeUnitProgressReader()
      reader.consume(Buffer.from(body))
      const value = reader.finish()
      expect(value.invalid).toBe(true)
      expect(value.complete).toBe(false)
      expect(JSON.stringify(value)).not.toMatch(/private|secret/i)
    }
  })

  test("discards nonprotocol/overlong stderr and never accepts evidence beyond its byte budget", () => {
    const reader = new NativeUnitProgressReader()
    reader.consume(
      Buffer.from("private".repeat(100) + "\n  " + line("ENTER") + "vector-unit-progress ENTER trailing\n"),
    )
    expect(reader.finish()).toEqual({ entered: false, passed: 0, complete: false, invalid: true })
    const bounded = new NativeUnitProgressReader()
    bounded.consume(Buffer.alloc(1_048_576, 120))
    bounded.consume(Buffer.from("\n" + all()))
    expect(bounded.finish()).toEqual({ entered: false, passed: 0, complete: false, invalid: false })
    const noisy = new NativeUnitProgressReader()
    noisy.consume(Buffer.from("private\u0000payload\n  " + line("ENTER") + "not-a-marker\n"))
    expect(noisy.finish()).toEqual({ entered: false, passed: 0, complete: false, invalid: false })
  })

  test("validates closed progress fields and relationships before optional diagnostic serialization", () => {
    const valid = { entered: true, passed: 1, active: "runProtocolTests", complete: false, invalid: false }
    expect(nativeCommandDiagnostic({ ...diagnostic(), progress: valid }).progress).toEqual(valid)
    for (const bad of [
      { ...valid, raw: "private" },
      { ...valid, suite: "private" },
      { ...valid, active: "runPrivateOwnerTests" },
      { ...valid, passed: 0 },
      { ...valid, passed: 25 },
      { ...valid, passed: 0.5 },
      { ...valid, entered: false },
      { ...valid, complete: true },
      { entered: true, passed: 24, complete: true, invalid: true },
      { entered: false, passed: 1, complete: false, invalid: false },
    ]) {
      expect(() => nativeUnitProgress(bad)).toThrow()
      expect(() => nativeCommandDiagnostic({ ...diagnostic(), progress: bad })).toThrow()
    }
    expect(nativeCommandDiagnostic(diagnostic()).progress).toBeUndefined()
  })
})

test("the collector runs in actual Node and distinguishes finite owned IO/process outcomes without payload diagnostics", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "vector-native-command-node-"))
  try {
    const entry = fileURLToPath(new URL("./computer-helper-command-diagnostics.ts", import.meta.url))
    const built = await Bun.build({
      entrypoints: [entry],
      target: "node",
      format: "esm",
      outdir: scratch,
      naming: "diagnostics.mjs",
    })
    expect(built.success).toBe(true)
    const driver = path.join(scratch, "driver.mjs")
    await writeFile(
      driver,
      `import { runObservedNativeCommand, NATIVE_UNIT_SUITES } from "./diagnostics.mjs";
const test = process.argv[2];
let calls = 0;
let command = {executable:process.execPath,args:["-e","process.stdout.write('finite-ok');process.stderr.write('private-stderr');process.exitCode=7"],timeoutMs:2000};
let options = {};
if (test === "wall") command = {...command,args:["-e","setTimeout(()=>process.exit(0),2000)"],timeoutMs:250};
if (test === "stdout-cap" || test === "stderr-cap") { command = {...command,args:["-e", "process." + (test === "stdout-cap" ? "stdout" : "stderr") + ".write('private-output-'.repeat(4096));setTimeout(()=>process.exit(0),1000)"]};options.outputLimitBytes=128; }
if (test === "spawn") command.executable += "-finite-missing-executable";
if (test === "pipe") command = {...command,args:["-e","const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1500)'],{stdio:['ignore',1,2],detached:true}).unref();process.exit(0)"],timeoutMs:1000};
if (test === "sample" || test === "invalid-sample" || test === "stalled-sample") {
 command = {...command,args:["-e","setTimeout(()=>process.exit(0),2000)"],timeoutMs:350};
 options = {sampleUnit:true,sampleAfterMs:10,sampler:async target=>{calls++;if(!target.alive()||target.pid<=1)throw Error('not-owned');if(test==='stalled-sample')return new Promise(()=>{});return test==='invalid-sample'?{status:'sampled',suites:['runPrivateOwnerTests'],waits:[],raw:'secret'}:{status:'sampled',suites:['runProtocolTests'],waits:['mutex-wait']};}};
}
if (test === "sample-exited") options = {sampleUnit:true,sampleAfterMs:1000,sampler:async()=>{calls++;throw Error('must-not-sample-dead-child')}};
if (test.startsWith("progress-")) {
 const progress = event => "vector-unit-progress " + event + "\\n";
 const all = progress("ENTER") + NATIVE_UNIT_SUITES.map(suite=>progress("BEGIN " + suite)+progress("PASS " + suite)).join("") + progress("COMPLETE");
 let text = progress("ENTER")+progress("BEGIN runCommandLineTests")+progress("PASS runCommandLineTests")+progress("BEGIN runProtocolTests");
 let code = "setTimeout(()=>process.exit(0),2000)";
 if(test==="progress-complete" || test==="progress-stdout") {text=all;code="process.exitCode=7";}
 if(test==="progress-invalid") {text=progress("ENTER")+progress("BEGIN runPrivateOwnerTests");code="process.exitCode=0";}
 if(test==="progress-partial") text=progress("ENTER")+"vector-unit-progress BEGIN runCommandLineTests";
 if(test==="progress-budget") text=progress("ENTER")+progress("BEGIN runCommandLineTests")+"private".repeat(1000);
 command={...command,args:["-e","process."+(test==="progress-stdout"?"stdout":"stderr")+".write("+JSON.stringify(text)+");"+code],timeoutMs:350};
 options={observeUnitProgress:true,...(test==="progress-budget"?{outputLimitBytes:128}:{})};
}
const result = await runObservedNativeCommand(command,options);
console.log(JSON.stringify({node:process.release.name,result,calls}));
`,
    )
    for (const name of [
      "complete",
      "wall",
      "stdout-cap",
      "stderr-cap",
      "spawn",
      "pipe",
      "sample",
      "invalid-sample",
      "stalled-sample",
      "sample-exited",
      "progress-active",
      "progress-complete",
      "progress-invalid",
      "progress-stdout",
      "progress-budget",
      "progress-partial",
    ]) {
      const child = spawnSync("node", [driver, name], { encoding: "utf8", timeout: 5000 })
      expect(child.error, name).toBeUndefined()
      expect(child.status, name).toBe(0)
      const value = JSON.parse(child.stdout)
      expect(value.node).toBe("node")
      const result = value.result
      const info = nativeCommandDiagnostic(result.diagnostic)
      expect(JSON.stringify(info), name).not.toMatch(/private|secret|argv|rawSample|node:child_process/i)
      if (name.startsWith("progress-")) {
        expect(info.sample.status).toBe("not-requested")
        if (name === "progress-active") {
          expect(info.progress).toEqual({
            entered: true,
            passed: 1,
            active: "runProtocolTests",
            complete: false,
            invalid: false,
          })
          expect(info.trigger).toBe("wall-deadline")
          expect(result.timedOut).toBe(true)
        }
        if (name === "progress-complete") {
          expect(info.progress).toEqual({ entered: true, passed: 24, complete: true, invalid: false })
          expect(result.code).toBe(7)
          expect(result.timedOut).toBeUndefined()
        }
        if (name === "progress-invalid") {
          expect(info.progress).toEqual({ entered: true, passed: 0, complete: false, invalid: true })
          expect(result.code).toBe(0)
        }
        if (name === "progress-stdout") {
          expect(info.progress).toEqual({ entered: false, passed: 0, complete: false, invalid: false })
          expect(result.code).toBe(7)
        }
        if (name === "progress-budget") {
          expect(info.progress).toEqual({
            entered: true,
            passed: 0,
            active: "runCommandLineTests",
            complete: false,
            invalid: false,
          })
          expect(info.trigger).toBe("output-cap")
          expect(result.timedOut).toBe(true)
        }
        if (name === "progress-partial") {
          expect(info.progress).toEqual({ entered: true, passed: 0, complete: false, invalid: true })
          expect(info.trigger).toBe("wall-deadline")
        }
      } else if (name === "complete" || name === "sample-exited") {
        expect(result.code, name).toBe(7)
        expect(result.stdout, name).toBe("finite-ok")
        expect(result.timedOut, name).toBeUndefined()
        expect(info.trigger, name).toBe("complete")
        expect(info.exitObserved && info.closeObserved, name).toBe(true)
        expect(info.stdoutBytes, name).toBe(9)
        expect(info.stderrBytes, name).toBe(14)
        if (name === "sample-exited") {
          expect(value.calls).toBe(0)
          expect(info.sample.status).toBe("target-exited")
        }
      } else if (name === "spawn") {
        expect(info.trigger).toBe("spawn-failed")
        expect(info.spawned || info.exitObserved).toBe(false)
      } else if (name.endsWith("-cap")) {
        expect(info.trigger, name).toBe("output-cap")
        expect(result.timedOut, name).toBe(true)
        expect(info.stdoutBytes + info.stderrBytes, name).toBeGreaterThan(128)
      } else {
        expect(info.trigger, name).toBe("wall-deadline")
        expect(result.timedOut, name).toBe(true)
        if (name === "pipe") {
          expect(info.exitObserved).toBe(true)
          expect(info.closeObserved).toBe(false)
          expect(result.code).toBe(0)
        }
        if (name === "sample") {
          expect(info.sample).toEqual({ status: "sampled", suites: ["runProtocolTests"], waits: ["mutex-wait"] })
          expect(value.calls).toBe(1)
        }
        if (name === "invalid-sample") expect(info.sample.status).toBe("failed")
        if (name === "stalled-sample") expect(info.sample.status).toBe("deadline")
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}, 30_000)
