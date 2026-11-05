import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  buildNodeComputerHelperPackage,
  computerHelperSkipRequested,
  loadComputerHelperSigningNode,
  prepareComputerHelperNode,
} from "./computer-helper-package-node"

const packageDir = fileURLToPath(new URL("../", import.meta.url))

describe("Node computer helper packaging verifier", () => {
  test("actual Node executes the compiled verifier and its lazy C2 import with preserved source roots", async () => {
    const base = path.join(packageDir, "native/build")
    await mkdir(base, { recursive: true })
    const directory = await mkdtemp(path.join(base, "package-node-test-"))
    const inputs = ["identity.json", "blocklist.json"]
    const before = await Promise.all(
      inputs.map((name) => readFile(path.join(packageDir, "native/computer-helper", name))),
    )
    try {
      await cp(path.join(packageDir, "scripts"), path.join(directory, "scripts"), { recursive: true })
      await mkdir(path.join(directory, "native/computer-helper"), { recursive: true })
      for (const name of inputs)
        await cp(
          path.join(packageDir, "native/computer-helper", name),
          path.join(directory, "native/computer-helper", name),
        )
      const built = await buildNodeComputerHelperPackage(directory)
      const executed = spawnSync(
        "node",
        [
          "--input-type=module",
          "--eval",
          `import path from "node:path";
const verifier = await import(process.argv[1]);
const signer = await import(process.argv[2]);
const outer = [];
await signer.signMacWithComputerHelper({app:"/unused.app",identity:"-"}, {appInfo:{id:"ai.vector.app.dev"},projectDir:process.argv[3]}, {environment:{VECTOR_COMPUTER_HELPER:"skip"},signAsync:async options => {if(options.optionsForFile("/unused.app").timestamp !== "none") throw new Error("Adhoc timestamp was not disabled"); outer.push(true);}});
const defaults = verifier.computerHelperPaths("darwin", "prod");
const skipped = await verifier.ensureComputerHelper({platform:"linux", architectures:[], channel:"prod", environment:{}});
try {
  await verifier.ensureComputerHelper({platform:"win32", architectures:["x64"], channel:"prod", environment:{VECTOR_COMPUTER_HELPER_PREBUILT:"true"}});
  throw new Error("Missing prebuilt artifact was accepted");
} catch (error) {
  if (error.code !== "ENOENT" || !error.path.endsWith("native/out/win32/x64/computer-helper.json")) throw error;
  const helper = path.resolve("fixture/VectorComputer.app");
  console.log(JSON.stringify({root:defaults.sourceRoot, skipped, missing:error.path, bun:typeof Bun, signing:outer.length===1 && signer.computerHelperSigningIgnore(helper)(path.join(helper,"Contents/MacOS/VectorComputer"))}));
}`,
          pathToFileURL(built.file).href,
          pathToFileURL(built.signing.file).href,
          directory,
        ],
        { encoding: "utf8", timeout: 10_000 },
      )
      expect(executed.error).toBeUndefined()
      expect(executed.status, executed.stderr).toBe(0)
      expect(JSON.parse(executed.stdout)).toEqual({
        root: path.join(directory, "native/out/darwin"),
        skipped: { skipped: true, manifests: [], windowsHashes: {} },
        missing: path.join(directory, "native/out/win32/x64/computer-helper.json"),
        bun: "undefined",
        signing: true,
      })
      expect(
        await Promise.all(inputs.map((name) => readFile(path.join(packageDir, "native/computer-helper", name)))),
      ).toEqual(before)
      expect(
        await Promise.all(inputs.map((name) => readFile(path.join(directory, "native/computer-helper", name)))),
      ).toEqual(before)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("actual Node imports the original source graph after the compiler process has loaded Hands", async () => {
    const { Hands } = await import("@vectordevai/schema/hands")
    expect(typeof Hands.helperBundleId).toBe("function")
    const built = await buildNodeComputerHelperPackage(packageDir)
    const executed = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `const verifier = await import(process.argv[1]);
const signer = await import(process.argv[2]);
console.log(JSON.stringify({verifier:typeof verifier.prepareComputerHelper === "function",signer:typeof signer.signMacWithComputerHelper === "function",bun:typeof Bun}));`,
        pathToFileURL(built.file).href,
        pathToFileURL(built.signing.file).href,
      ],
      { encoding: "utf8", timeout: 10_000 },
    )
    expect(executed.error).toBeUndefined()
    expect(executed.status, executed.stderr).toBe(0)
    expect(JSON.parse(executed.stdout)).toEqual({ verifier: true, signer: true, bun: "undefined" })
  }, 30_000)

  test("afterPack rejects changed verifier bytes before importing executable code", async () => {
    const base = path.join(packageDir, "native/build")
    await mkdir(base, { recursive: true })
    const directory = await mkdtemp(path.join(base, "package-node-hash-"))
    try {
      await mkdir(path.join(directory, "native/build/computer-helper-package-node"), { recursive: true })
      await writeFile(
        path.join(directory, "native/build/computer-helper-package-node/prepare.mjs"),
        'throw new Error("unverified code executed")\n',
      )
      const context = {
        electronPlatformName: "win32",
        arch: "x64",
        appOutDir: directory,
        packager: { appInfo: { productFilename: "Vector" } },
      }
      await expect(prepareComputerHelperNode(context, { channel: "prod", directory, environment: {} })).rejects.toThrow(
        "was not prepared",
      )
      await expect(
        prepareComputerHelperNode(context, {
          channel: "prod",
          directory,
          environment: { VECTOR_COMPUTER_HELPER_PACKAGE_SHA256: "a".repeat(64) },
        }),
      ).rejects.toThrow("build hash check")
      await expect(
        prepareComputerHelperNode(
          { ...context, electronPlatformName: "linux" },
          { channel: "prod", directory, environment: {} },
        ),
      ).resolves.toBeUndefined()
      await expect(
        prepareComputerHelperNode(context, {
          channel: "dev",
          directory,
          environment: { VECTOR_COMPUTER_HELPER: "skip" },
        }),
      ).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("only an explicit dev package can skip native helper verification", () => {
    expect(computerHelperSkipRequested("dev", {})).toBe(false)
    expect(computerHelperSkipRequested("dev", { VECTOR_COMPUTER_HELPER: "skip" })).toBe(true)
    for (const channel of ["beta", "prod"] as const)
      expect(() => computerHelperSkipRequested(channel, { VECTOR_COMPUTER_HELPER: "skip" })).toThrow(
        "Only an explicit dev",
      )
    expect(() => computerHelperSkipRequested("dev", { VECTOR_COMPUTER_HELPER: "false" })).toThrow("only accepts")
  })

  test("afterPack returns the hash-verified Node module's exact artifact result", async () => {
    const base = path.join(packageDir, "native/build")
    await mkdir(base, { recursive: true })
    const directory = await mkdtemp(path.join(base, "package-node-result-"))
    try {
      await mkdir(path.join(directory, "native/build/computer-helper-package-node"), { recursive: true })
      const expected = {
        skipped: false,
        manifests: [{ platform: "darwin", sourceDigest: "fixture" }],
        windowsHashes: {},
      }
      const bytes = Buffer.from(`export async function prepareComputerHelper() { return ${JSON.stringify(expected)} }`)
      await writeFile(path.join(directory, "native/build/computer-helper-package-node/prepare.mjs"), bytes)
      expect(
        await prepareComputerHelperNode(
          {
            electronPlatformName: "darwin",
            arch: "x64",
            appOutDir: directory,
            packager: { appInfo: { productFilename: "Vector" } },
          },
          {
            channel: "prod",
            directory,
            environment: { VECTOR_COMPUTER_HELPER_PACKAGE_SHA256: createHash("sha256").update(bytes).digest("hex") },
          },
        ),
      ).toEqual(expected)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("signing loader rejects changed Node code before executing it", async () => {
    const base = path.join(packageDir, "native/build")
    await mkdir(base, { recursive: true })
    const directory = await mkdtemp(path.join(base, "signing-node-hash-"))
    try {
      await mkdir(path.join(directory, "native/build/computer-helper-package-node"), { recursive: true })
      await writeFile(
        path.join(directory, "native/build/computer-helper-package-node/signing.mjs"),
        'throw new Error("unverified signing code executed")\n',
      )
      await expect(loadComputerHelperSigningNode({ directory, environment: {} })).rejects.toThrow("was not prepared")
      await expect(
        loadComputerHelperSigningNode({
          directory,
          environment: { VECTOR_COMPUTER_HELPER_SIGN_SHA256: "a".repeat(64) },
        }),
      ).rejects.toThrow("build hash check")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
