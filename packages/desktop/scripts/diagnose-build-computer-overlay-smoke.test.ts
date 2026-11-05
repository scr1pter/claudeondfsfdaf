import { expect, test } from "bun:test"
import path from "node:path"
import { type NativeCommand } from "./build-computer-helper"
import { diagnoseComputerOverlayBuild } from "./diagnose-build-computer-overlay-smoke"

const args = ["--platform", "darwin", "--helper", "/tmp/helper", "--out", "/tmp/overlay", "--helper-channel", "beta"]
const settings = { cwd: "/controlled/checkout", env: { ZERO_AR_DATE: "1" }, timeoutMs: 300_000 }
const manifest = {
  helperVersion: "1.0.13",
  protocol: { min: 1, max: 1 },
  platform: "darwin" as const,
  files: {},
  sourceDigest: "a".repeat(64),
  toolchain: "controlled toolchain",
}

test("the diagnostic launcher forwards parsed channel/options, exact native command context and unchanged results", async () => {
  const output: string[] = []
  const commandArgs = ["--sdk", "macosx", "swiftc", "--version"]
  const result = { code: 0, stdout: "unlogged successful compiler output", stderr: "unlogged successful warning" }
  const built = await diagnoseComputerOverlayBuild(args, {
    write: (message) => output.push(message),
    run: async (binary, actualArgs, actualSettings) => {
      expect(binary).toBe("xcrun")
      expect(actualArgs).toBe(commandArgs)
      expect(actualSettings).toBe(settings)
      return result
    },
    build: async (options, input) => {
      expect(options).toEqual({
        platform: "darwin",
        helper: path.resolve("/tmp/helper"),
        out: path.resolve("/tmp/overlay"),
        channel: "beta",
      })
      expect(Object.keys(input ?? {})).toEqual(["run"])
      expect(await input!.run!("xcrun", commandArgs, settings)).toBe(result)
      return manifest
    },
  })
  expect(built).toBe(manifest)
  expect(output).toEqual([])
})

test("failed trusted compilation keeps the original failure and bounded head/tail diagnostics with fixed stage/tool", async () => {
  const output: string[] = []
  const failure = new Error("The dedicated overlay native build command failed.")
  const result = { code: 1, stdout: "not selected", stderr: "not selected", diagnostic: `HEAD${"é".repeat(10000)}TAIL` }
  await expect(
    diagnoseComputerOverlayBuild(args, {
      write: (message) => output.push(message),
      run: async () => result,
      build: async (_options, input) => {
        expect(await input!.run!("xcrun", ["--sdk", "macosx", "swiftc", "controlled.swift"], settings)).toBe(result)
        throw failure
      },
    }),
  ).rejects.toBe(failure)
  expect(output[0]).toBe("overlay-native-command-failed stage=driver-compile tool=xcrun code=1 reason=exit\n")
  const diagnostic = output[1]!.split("overlay-compiler-output-begin\n")[1]!.split("\noverlay-compiler-output-end")[0]!
  expect(diagnostic.startsWith("HEAD")).toBe(true)
  expect(diagnostic.endsWith("TAIL")).toBe(true)
  expect(diagnostic).toContain("[overlay diagnostic truncated]")
  expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(8192)
  expect(diagnostic).not.toContain("�")
  expect(output.join("")).not.toContain("not selected")
  expect(output[2]).toContain("phase=build-or-verify last-stage=driver-compile tool=xcrun")
  expect(output[2]).toContain(failure.message)
})

test("Windows configure/compile and MSVC toolchain failures identify the actual fixed command stage", async () => {
  for (const [binary, commandArgs, stage, tool] of [
    ["cmake", ["-S", "controlled-source", "-B", "controlled-build"], "driver-configure", "cmake"],
    ["cmake", ["--build", "controlled-build", "--target", "computer-overlay-driver"], "driver-compile", "cmake"],
    ["cl", ["/Bv", "/c", "controlled.cpp"], "toolchain-msvc", "cl"],
  ] as const) {
    const output: string[] = []
    await expect(
      diagnoseComputerOverlayBuild(args, {
        write: (message) => output.push(message),
        run: async () => ({ code: 1, stdout: "controlled compiler error", stderr: "" }),
        build: async (_options, input) => {
          await input!.run!(binary, commandArgs, settings)
          throw new Error("Actual failed command remains fatal.")
        },
      }),
    ).rejects.toThrow("Actual failed command remains fatal.")
    expect(output[0]).toContain(`stage=${stage} tool=${tool} code=1`)
    expect(output[1]).toContain("controlled compiler error")
  }
})

test("noncompiler failures keep fixed context without exposing command arguments, environment or output", async () => {
  const output: string[] = []
  const run: NativeCommand = async () => ({
    code: 1,
    stdout: "hidden stdout",
    stderr: "hidden stderr",
    failureReason: "timed-out",
  })
  await expect(
    diagnoseComputerOverlayBuild(args, {
      write: (message) => output.push(message),
      run,
      build: async (_options, input) => {
        await input!.run!("/usr/bin/codesign", ["--sign", "private-identity", "private-path"], settings)
        throw new Error("The original signing failure.")
      },
    }),
  ).rejects.toThrow("The original signing failure.")
  expect(output[0]).toBe("overlay-native-command-failed stage=driver-sign tool=codesign code=1 reason=timed-out\n")
  expect(output).toHaveLength(2)
  expect(output.join("")).not.toMatch(/hidden|private-|controlled\/checkout|ZERO_AR_DATE/)
})

test("argument rejection cannot invoke the build and a noncommand verification rejection remains fatal", async () => {
  const output: string[] = []
  await expect(
    diagnoseComputerOverlayBuild([...args, "--out", "duplicate"], {
      write: (message) => output.push(message),
      build: async () => {
        throw new Error("Build must never be reached.")
      },
    }),
  ).rejects.toThrow("duplicate argument")
  expect(output[0]).toContain("phase=arguments last-stage=none tool=none")
  expect(output[0]).not.toContain("Build must never be reached")
  await expect(
    diagnoseComputerOverlayBuild(args, {
      write: (message) => output.push(message),
      build: async () => {
        throw new Error("The exact source-bound verification failed.")
      },
    }),
  ).rejects.toThrow("The exact source-bound verification failed.")
  expect(output[1]).toContain("phase=build-or-verify last-stage=none tool=none")
  expect(output[1]).toContain("The exact source-bound verification failed.")
})
