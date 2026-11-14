import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NativeCommand } from "./build-computer-helper"
import { prepareComputerOverlayElectronRuntime } from "./computer-overlay-electron-runtime"

const profile = await readFile(new URL("../resources/entitlements.plist", import.meta.url))
const profileSha256 = "16b05c93e71cebb2b645afa60a55a0dd29d022702d9c95c7076c7fd51e5d6a5a"
const entitlements = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
  "com.apple.security.cs.disable-executable-page-protection": true,
  "com.apple.security.cs.disable-library-validation": true,
  "com.apple.security.device.audio-input": true,
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vector-overlay-runtime-test-")))
  const source = path.join(root, "source/Electron.app"),
    copy = path.join(root, "copy/Electron.app")
  const helper = "Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"
  await mkdir(path.dirname(path.join(source, helper)), { recursive: true })
  await mkdir(path.join(source, "Contents/MacOS"), { recursive: true })
  await mkdir(path.join(root, "resources"))
  await writeFile(path.join(root, "resources/entitlements.plist"), profile)
  await writeFile(path.join(source, "Contents/MacOS/Electron"), "original root bytes")
  await writeFile(path.join(source, helper), "original nested bytes")
  await writeFile(path.join(source, "Contents/Info.plist"), "controlled pinned Info.plist")
  if (process.platform !== "win32") await symlink("MacOS/Electron", path.join(source, "Contents/relative-link"))
  await cp(source, copy, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  })
  return { root, source, copy, helper, profile: path.join(root, "resources/entitlements.plist") }
}

function commands(f: Awaited<ReturnType<typeof fixture>>, mode = "success") {
  const state = { sealed: false, calls: [] as { binary: string; args: readonly string[] }[], exported: "" }
  const run: NativeCommand = async (binary, args, settings) => {
    state.calls.push({ binary, args })
    expect(settings.cwd).toBe(f.root)
    expect(settings.env).toEqual({ ZERO_AR_DATE: "1" })
    if (binary === "/usr/bin/plutil") {
      if (args[0] === "-extract")
        return {
          code: 0,
          stdout:
            args[1] === "CFBundleIdentifier"
              ? "com.github.Electron\n"
              : mode === "bundle-version"
                ? "42.11.3\n"
                : "42.11.4\n",
          stderr: "",
        }
      expect(args.slice(0, 4)).toEqual(["-convert", "json", "-o", "-"])
      if (args.at(-1) !== f.profile) {
        state.exported = args.at(-1)!
        expect(await readFile(state.exported, "utf8")).toBe("<plist><dict>observed signed entitlements</dict></plist>")
      }
      return {
        code: 0,
        stdout: JSON.stringify(args.at(-1) !== f.profile && mode === "entitlements" ? {} : entitlements),
        stderr: "",
      }
    }
    if (binary !== "/usr/bin/codesign") {
      expect(binary).toBe(path.join(f.copy, "Contents/MacOS/Electron"))
      expect(args).toEqual(["--version"])
      expect(settings.timeoutMs).toBe(5000)
      if (mode === "version-source") await writeFile(path.join(f.source, f.helper), "changed during version")
      if (mode === "version-profile") await writeFile(f.profile, Buffer.concat([profile, Buffer.from("\n")]))
      return { code: 0, stdout: mode === "version" ? "v42.11.3\n" : "v42.11.4\n", stderr: "" }
    }
    expect(args.at(-1)).toBe(f.copy)
    if (args.includes("--display")) {
      expect(args).toEqual(["--display", "--verbose=4", "--entitlements", ":-", "--xml", f.copy])
      return {
        code: 0,
        stdout: state.sealed ? "<plist><dict>observed signed entitlements</dict></plist>" : "",
        stderr: `Identifier=${state.sealed ? "com.github.Electron" : mode === "template" ? "Unknown" : "Electron"}\nCodeDirectory v=20500 size=400 flags=${state.sealed ? (mode === "flags" ? "0x2" : "0x10002") : "0x20002"}(adhoc) hashes=4+4 location=embedded\n${state.sealed ? "Runtime Version=15.5.0\n" : ""}`,
      }
    }
    if (args.includes("--sign")) {
      expect(args).toEqual([
        "--force",
        "--deep",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--timestamp=none",
        "--entitlements",
        f.profile,
        f.copy,
      ])
      state.sealed = true
      await writeFile(path.join(f.copy, "Contents/MacOS/Electron"), "new root signature bytes")
      await writeFile(path.join(f.copy, f.helper), "new nested signature bytes")
      if (mode === "source") await writeFile(path.join(f.source, f.helper), "changed source")
      if (mode === "profile") await writeFile(f.profile, Buffer.concat([profile, Buffer.from("\n")]))
      return { code: 0, stdout: "successful signing output stays closed", stderr: "" }
    }
    const deep = args.includes("--deep")
    expect(args).toEqual(
      deep
        ? ["--verify", "--deep", "--strict", "--all-architectures", f.copy]
        : ["--verify", "--strict", "--all-architectures", f.copy],
    )
    return {
      code: (mode === "strict" && !deep) || (mode === "deep" && deep) || mode === "output" ? 1 : 0,
      stdout: "",
      stderr: mode === "output" ? `HEAD${"é".repeat(10000)}TAIL` : "controlled verification error",
      ...(mode === "timeout" ? { failureReason: "timed-out" as const } : {}),
    }
  }
  return { state, run }
}

test("the measured runtime preparation uses the exact repository C4 profile and validates actual owned files", async () => {
  expect(createHash("sha256").update(profile).digest("hex")).toBe(profileSha256)
  const f = await fixture(),
    command = commands(f),
    output: string[] = []
  try {
    const receipt = await prepareComputerOverlayElectronRuntime({
      ...f,
      directory: f.root,
      run: command.run,
      environment: { ZERO_AR_DATE: "1" },
      write: (value) => output.push(value),
    })
    expect(receipt).toMatchObject({
      mode: "c4-deep-ad-hoc",
      sourceBytesUnchanged: true,
      nestedBytePolicy: "re-signed-not-preserved",
      nestedBytesChanged: true,
      helperExecutables: 1,
      profileSha256,
      profileApplied: true,
      strictVerified: true,
      deepVerified: true,
      versionVerified: true,
    })
    expect(receipt.finalMetadata).toMatchObject({
      identifier: "com.github.Electron",
      flags: 0x10002,
      runtime: "15.5.0",
    })
    expect(receipt).not.toHaveProperty("nestedBytesUnchanged")
    expect(await readFile(path.join(f.source, f.helper), "utf8")).toBe("original nested bytes")
    expect((await lstat(f.copy)).isDirectory()).toBe(true)
    expect((await lstat(f.source)).isDirectory()).toBe(true)
    await expect(lstat(path.dirname(command.state.exported))).rejects.toThrow()
    expect(output.join("")).not.toContain("successful signing output")
    expect(command.state.calls.at(-1)?.args).toEqual(["--version"])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("source/copy inequality, aliasing, nesting and escaped links cannot reach signing", async () => {
  for (const mode of ["inequality", "alias", "nested", ...(process.platform === "win32" ? [] : ["link"])]) {
    const f = await fixture(),
      command = commands(f)
    try {
      const copy = mode === "alias" ? f.source : mode === "nested" ? path.join(f.source, "nested") : f.copy
      if (mode === "inequality") await writeFile(path.join(f.copy, f.helper), "different bytes")
      if (mode === "nested") await mkdir(copy)
      if (mode === "link") await symlink(f.source, path.join(f.copy, "Contents/escaped"))
      await expect(
        prepareComputerOverlayElectronRuntime({
          source: f.source,
          copy,
          directory: f.root,
          run: command.run,
          environment: { ZERO_AR_DATE: "1" },
          write: () => {},
        }),
      ).rejects.toThrow()
      expect(command.state.sealed).toBe(false)
      expect(command.state.calls).toHaveLength(0)
      expect((await lstat(f.copy)).isDirectory()).toBe(true)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  }
})

test("unsupported template, bundle version and a changed fixed profile fail before signing", async () => {
  for (const mode of ["template", "bundle-version", "fixed-profile"]) {
    const f = await fixture(),
      command = commands(f, mode)
    try {
      if (mode === "fixed-profile") await writeFile(f.profile, Buffer.concat([profile, Buffer.from("\n")]))
      await expect(
        prepareComputerOverlayElectronRuntime({
          ...f,
          directory: f.root,
          run: command.run,
          environment: { ZERO_AR_DATE: "1" },
          write: () => {},
        }),
      ).rejects.toThrow()
      expect(command.state.sealed).toBe(false)
      expect((await lstat(f.copy)).isDirectory()).toBe(true)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  }
})

test("signature, metadata, semantic entitlement, source/profile mutation and version failures never return a receipt", async () => {
  for (const mode of [
    "strict",
    "deep",
    "timeout",
    "flags",
    "entitlements",
    "source",
    "profile",
    "version",
    "version-source",
    "version-profile",
  ]) {
    const f = await fixture(),
      command = commands(f, mode)
    try {
      await expect(
        prepareComputerOverlayElectronRuntime({
          ...f,
          directory: f.root,
          run: command.run,
          environment: { ZERO_AR_DATE: "1" },
          write: () => {},
        }),
      ).rejects.toThrow()
      expect(command.state.sealed).toBe(true)
      expect((await lstat(f.copy)).isDirectory()).toBe(true)
      if (command.state.exported) await expect(lstat(path.dirname(command.state.exported))).rejects.toThrow()
      expect(command.state.calls.some((call) => call.args[0] === "--version")).toBe(mode.startsWith("version"))
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  }
})

test("failed controlled native diagnostics retain bounded UTF-8 head/tail output and cannot become authority", async () => {
  const f = await fixture(),
    command = commands(f, "output"),
    output: string[] = []
  try {
    await expect(
      prepareComputerOverlayElectronRuntime({
        ...f,
        directory: f.root,
        run: command.run,
        environment: { ZERO_AR_DATE: "1" },
        write: (value) => output.push(value),
      }),
    ).rejects.toThrow("strict-all-architectures")
    const diagnostic = output[1]!
      .split("overlay-electron-runtime-output-begin\n")[1]!
      .split("\noverlay-electron-runtime-output-end")[0]!
    expect(diagnostic.startsWith("HEAD")).toBe(true)
    expect(diagnostic.endsWith("TAIL")).toBe(true)
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(8192)
    expect(diagnostic).not.toContain("�")
    const second = await fixture(),
      secondCommand = commands(second)
    try {
      expect(
        (
          await prepareComputerOverlayElectronRuntime({
            ...second,
            directory: second.root,
            run: secondCommand.run,
            environment: { ZERO_AR_DATE: "1" },
            write: () => {
              throw new Error("observational logger")
            },
          })
        ).strictVerified,
      ).toBe(true)
    } finally {
      await rm(second.root, { recursive: true, force: true })
    }
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
