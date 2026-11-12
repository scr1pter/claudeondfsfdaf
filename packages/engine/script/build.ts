#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import { prepareGitLab } from "../../../script/prepare-gitlab"
import { linuxIsolationBuildPlugin, linuxIsolationCIMode } from "../../../script/linux-isolation-asset"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { compileRuntime } from "../../../script/compile-runtime"
import { bundleBrainWorker } from "./brain-worker"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@vectordevai/script"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const isolation = await linuxIsolationBuildPlugin(linuxIsolationCIMode(process.argv, process.env.GITHUB_ACTIONS))
const sourceRevision = process.env.VECTOR_SOURCE_REVISION ?? (await $`git rev-parse HEAD`.text()).trim()
if (!/^[a-f0-9]{40}$/.test(sourceRevision))
  throw new Error("VECTOR_SOURCE_REVISION must be a full lowercase Git revision")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`VECTOR_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
// The brain's background reader, which carries this build's version and channel (bundleBrainWorker).
const brainWorkerModule = `export default ${JSON.stringify(await bundleBrainWorker({ version: Script.version, channel: Script.channel }, isolation))}`

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets.filter((item) => {
      // VECTOR_TARGETS="darwin-arm64,linux-x64" restricts the matrix (used by publish-vector.ts).
      const only = process.env.VECTOR_TARGETS?.split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      if (!only?.length) return true
      const key = [
        item.os === "win32" ? "windows" : item.os,
        item.arch,
        item.avx2 === false ? "baseline" : undefined,
        item.abi,
      ]
        .filter(Boolean)
        .join("-")
      return only.includes(key)
    })

const executablePath = await compileRuntime({
  executable: process.env.VECTOR_BUN_EXECUTABLE_PATH,
  single: singleFlag,
  baseline: baselineFlag,
  targets,
})

await $`rm -rf dist`
await Bun.write("dist/api.json", generated.modelsData)

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
await prepareGitLab()
const { dependencyNotices } = await import("../../../script/dependency-notices.ts")
const notices = await dependencyNotices(path.resolve(dir, "../.."))
await Bun.write(path.resolve(dir, "../../DEPENDENCY_NOTICES.md"), notices.body)
for (const item of targets) {
  const name = [
    "vector",
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/tui/worker.ts"
  // The egress guard's Worker preload, an entry point of its own so the guard can start every Worker with it.
  const guardWorker = fs.realpathSync(path.resolve(dir, "../core/src/local-mode/guard-worker.ts"))

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")
  const guardWorkerRelativePath = path.relative(dir, guardWorker).replaceAll("\\", "/").replace(/\.ts$/, ".js")

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin, isolation],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace("vector", "bun") as Bun.Build.CompileTarget,
      ...(executablePath ? { executablePath } : {}),
      outfile: `dist/${name}/bin/vector`,
      execArgv: [`--user-agent=vector/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      ...(embeddedFileMap ? { "vector-web-ui.gen.ts": embeddedFileMap } : {}),
      "brain-worker.gen.ts": brainWorkerModule,
    },
    entrypoints: [
      "./src/index.ts",
      parserWorker,
      workerPath,
      guardWorker,
      ...(embeddedFileMap ? ["vector-web-ui.gen.ts"] : []),
      "brain-worker.gen.ts",
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      VECTOR_VERSION: `'${Script.version}'`,
      VECTOR_CLI_STANDALONE: "true",
      VECTOR_PLUGIN_VERSION: JSON.stringify(process.env.VECTOR_PLUGIN_VERSION ?? Script.version),
      VECTOR_MODEL_CATALOG: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      // Bundled as JavaScript beside the other entry points, at its path from this package.
      VECTOR_GUARD_WORKER_PATH: JSON.stringify(bunfsRoot + guardWorkerRelativePath),
      VECTOR_WORKER_PATH: workerPath,
      VECTOR_CHANNEL: `'${Script.channel}'`,
      VECTOR_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/vector${item.os === "win32" ? ".exe" : ""}`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
      await $`${process.execPath} script/verify-local-plugin.ts ${binaryPath}`
      // The brain's reader must start from the bundled source as an eval worker, or documents are read on the main
      // thread under tighter limits.
      await $`${process.execPath} script/verify-brain-worker.ts ${binaryPath}`
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        vectorCatalogSha256: generated.modelsSha256,
        vectorStandalone: true,
        vectorSourceRevision: sourceRevision,
        preferUnplugged: true,
        license: "SEE LICENSE IN LICENSE",
        files: ["bin", "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"],
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
    await Bun.write(`dist/${name}/${notice}`, Bun.file(path.join(dir, "../..", notice)))
  }
  binaries[name] = Script.version
}

if (Script.release) {
  const { assertCleanArtifacts } = await import("../../../script/artifact-audit")
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../${key}.tar.gz -C bin . -C .. LICENSE THIRD_PARTY_NOTICES.md DEPENDENCY_NOTICES.md`.cwd(
        `dist/${key}`,
      )
    } else {
      await $`zip -j ../${key}.zip bin/* LICENSE THIRD_PARTY_NOTICES.md DEPENDENCY_NOTICES.md`.cwd(`dist/${key}`)
    }
  }
  // These archives go straight to GitHub Releases, so they pass the byte audit first.
  await assertCleanArtifacts(
    Object.keys(binaries).map((key) => path.join(dir, "dist", key.includes("linux") ? `${key}.tar.gz` : `${key}.zip`)),
  )
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
