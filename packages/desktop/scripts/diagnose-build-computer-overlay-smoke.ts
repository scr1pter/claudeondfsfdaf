import { runNativeCommand, type NativeCommand } from "./build-computer-helper"
import { buildComputerOverlaySmoke, parseComputerOverlayBuildOptions } from "./build-computer-overlay-smoke"

/** CI diagnostics only: the measured builder, command runner and admission checks remain authoritative.
 * This launcher grants no shipping, release, native-ready or skip credit.
 */
export async function diagnoseComputerOverlayBuild(
  args: readonly string[],
  input: {
    run?: NativeCommand
    build?: typeof buildComputerOverlaySmoke
    write?: (message: string) => void
  } = {},
) {
  const write = input.write ?? ((message: string) => process.stderr.write(message))
  const context = { phase: "arguments", stage: "none", tool: "none" }
  const run: NativeCommand = async (binary, args, settings) => {
    const command = diagnosticCommand(binary, args)
    context.stage = command.stage
    context.tool = command.tool
    const result = await (input.run ?? runNativeCommand)(binary, args, settings)
    if (result.code !== 0) {
      write(
        `overlay-native-command-failed stage=${command.stage} tool=${command.tool} code=${result.code} reason=${result.failureReason ?? "exit"}\n`,
      )
      // Only controlled CI build/signature output is exposed; never print argv, environment or raw spawn errors.
      if (["xcrun", "xcodebuild", "cmake", "cl", "codesign"].includes(command.tool)) {
        const output = result.diagnostic ?? `${result.stdout}\n${result.stderr}`
        write(`overlay-compiler-output-begin\n${boundedDiagnostic(output, 8192)}\noverlay-compiler-output-end\n`)
      }
    }
    return result
  }
  try {
    const options = parseComputerOverlayBuildOptions(args)
    context.phase = "build-or-verify"
    return await (input.build ?? buildComputerOverlaySmoke)(options, { run })
  } catch (error) {
    const cause = error instanceof Error ? error.message : "The overlay build rejected an unknown error."
    write(
      `overlay-build-failed phase=${context.phase} last-stage=${context.stage} tool=${context.tool} cause=${JSON.stringify(boundedDiagnostic(cause, 1024))}\n`,
    )
    throw error
  }
}

function diagnosticCommand(binary: string, args: readonly string[]) {
  const name = binary.replaceAll("\\", "/").split("/").at(-1)
  if (name === "xcrun")
    return {
      tool: "xcrun",
      stage: args.includes("--show-sdk-version")
        ? "toolchain-sdk-version"
        : args.includes("--show-sdk-path")
          ? "toolchain-sdk-path"
          : args.includes("--version")
            ? "toolchain-swift"
            : "driver-compile",
    }
  if (name === "xcodebuild") return { tool: "xcodebuild", stage: "toolchain-xcode" }
  if (name === "cmake")
    return {
      tool: "cmake",
      stage: args.includes("--build")
        ? "driver-compile"
        : args.includes("--version")
          ? "toolchain-cmake"
          : "driver-configure",
    }
  if (name === "cl" || name === "cl.exe") return { tool: "cl", stage: "toolchain-msvc" }
  if (name === "codesign")
    return {
      tool: "codesign",
      stage: args.includes("--sign")
        ? "driver-sign"
        : args.at(-1)?.endsWith("/Electron.app")
          ? "electron-signature"
          : args.at(-1)?.endsWith("/VectorComputerOverlayDriver.app")
            ? "driver-signature"
            : "prebuilt-signature",
    }
  if (name === "VectorComputer" || name === "vector-computer.exe")
    return { tool: "prebuilt-helper", stage: "prebuilt-version" }
  return { tool: "other", stage: "native-command" }
}

export function boundedDiagnostic(value: string, limit: number) {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= limit) return value
  const marker = "\n[overlay diagnostic truncated]\n"
  const side = Math.floor((limit - Buffer.byteLength(marker)) / 2)
  return (
    bytes
      .subarray(0, side)
      .toString("utf8")
      .replace(/\uFFFD$/, "") +
    marker +
    bytes
      .subarray(-side)
      .toString("utf8")
      .replace(/^\uFFFD+/, "")
  )
}

if (import.meta.main)
  void diagnoseComputerOverlayBuild(process.argv.slice(2)).then(
    () => process.stdout.write("Built and verified the separate source-bound computer overlay stage.\n"),
    () => {
      process.exitCode = 1
    },
  )
