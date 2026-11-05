import { expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { probeComputerOverlayElectronSignatures } from "./diagnose-computer-overlay-electron-signature"

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vector-electron-signature-test-")))
  const electron = path.join(root, "node_modules/electron")
  const app = path.join(electron, "dist/Electron.app")
  await mkdir(path.join(app, "Contents/MacOS"), { recursive: true })
  await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { electron: "42.11.4" } }))
  await writeFile(path.join(electron, "package.json"), JSON.stringify({ name: "electron", version: "42.11.4" }))
  await writeFile(path.join(electron, "path.txt"), "Electron.app/Contents/MacOS/Electron\n")
  await writeFile(path.join(app, "Contents/MacOS/Electron"), "controlled Electron bytes")
  if (process.platform !== "win32") await symlink("MacOS/Electron", path.join(app, "Contents/relative-link"))
  return { root, electron, app }
}

test("the probe contrasts exact source/copy signatures, preserves copy bytes/relative links and cleans its owned copy", async () => {
  const f = await fixture(),
    output: string[] = [],
    bundles: string[] = []
  try {
    const report = await probeComputerOverlayElectronSignatures({
      directory: f.root,
      write: (message) => output.push(message),
      run: async (binary, args, settings) => {
        expect(binary).toBe("/usr/bin/codesign")
        expect(args.slice(0, 3)).toEqual(["--verify", "--strict", "--all-architectures"])
        expect(settings.cwd).toBe(f.root)
        expect(settings.timeoutMs).toBe(30_000)
        const bundle = args[3]!
        bundles.push(bundle)
        expect(await readFile(path.join(bundle, "Contents/MacOS/Electron"), "utf8")).toBe("controlled Electron bytes")
        if (process.platform !== "win32")
          expect(await readlink(path.join(bundle, "Contents/relative-link"))).toBe("MacOS/Electron")
        return bundles.length === 1
          ? { code: 0, stdout: "successful output stays closed", stderr: "" }
          : { code: 1, stdout: "", stderr: `HEAD${"é".repeat(10000)}TAIL` }
      },
    })
    expect(report).toEqual({ protocol: 1, electronVersion: "42.11.4", source: "verified", copy: "failed" })
    expect(bundles[0]).toBe(f.app)
    expect(bundles[1]!.startsWith(f.electron)).toBe(false)
    expect(output[0]).toContain("role=source result=verified code=0")
    expect(output[1]).toContain("role=copy result=failed code=1")
    const diagnostic = output[2]!.split("role=copy\n")[1]!.split("\nelectron-signature-output-end")[0]!
    expect(diagnostic.startsWith("HEAD")).toBe(true)
    expect(diagnostic.endsWith("TAIL")).toBe(true)
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(8192)
    expect(diagnostic).not.toContain("�")
    expect(output.join("")).not.toContain("successful output stays closed")
    await expect(lstat(path.resolve(bundles[1]!, "../.."))).rejects.toThrow()
    expect(await readFile(path.join(f.app, "Contents/MacOS/Electron"), "utf8")).toBe("controlled Electron bytes")
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("source signature failure still permits the copy contrast and a thrown command still cleans the owned copy", async () => {
  const f = await fixture(),
    bundles: string[] = []
  const failure = new Error("Controlled command failure")
  try {
    await expect(
      probeComputerOverlayElectronSignatures({
        directory: f.root,
        write: () => {},
        run: async (_binary, args) => {
          bundles.push(args[3]!)
          if (bundles.length === 2) throw failure
          return { code: 1, stdout: "", stderr: "source invalid" }
        },
      }),
    ).rejects.toBe(failure)
    expect(bundles).toHaveLength(2)
    await expect(lstat(path.resolve(bundles[1]!, "../.."))).rejects.toThrow()
    expect((await lstat(f.app)).isDirectory()).toBe(true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("wrong Electron version or executable selection cannot invoke the diagnostic command", async () => {
  const f = await fixture()
  try {
    const run = async () => {
      throw new Error("Codesign must not be reached")
    }
    await writeFile(path.join(f.electron, "package.json"), JSON.stringify({ name: "electron", version: "42.11.3" }))
    await expect(probeComputerOverlayElectronSignatures({ directory: f.root, run })).rejects.toThrow(
      "exact pinned Electron",
    )
    await writeFile(path.join(f.electron, "package.json"), JSON.stringify({ name: "electron", version: "42.11.4" }))
    await writeFile(path.join(f.electron, "path.txt"), "other-executable\n")
    await expect(probeComputerOverlayElectronSignatures({ directory: f.root, run })).rejects.toThrow(
      "installed macOS Electron bundle",
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("the fast Mac signature probe follows pinned installation and cannot soften the required UI check", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/test.yml", import.meta.url)).text(),
  ) as {
    jobs: Record<string, { steps: Record<string, unknown>[] }>
  }
  const steps = workflow.jobs["computer-helper-macos-overlay"]!.steps
  const install = steps.findIndex((step) => step.name === "Install the exact pinned Electron runtime")
  const diagnostic = steps[install + 1]!
  const required = steps[install + 2]!
  expect(install).toBeGreaterThanOrEqual(0)
  expect(diagnostic.run).toBe("bun --no-env-file ./scripts/diagnose-computer-overlay-electron-signature.ts")
  expect(diagnostic["continue-on-error"]).toBe(true)
  expect(diagnostic["timeout-minutes"]).toBe(2)
  expect(diagnostic.outputs).toBeUndefined()
  expect(required.run).toBe("bun --no-env-file ./scripts/computer-overlay-smoke.ts")
  expect(required["continue-on-error"]).toBeUndefined()
})
