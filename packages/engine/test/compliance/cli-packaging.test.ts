import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { catalogBody, catalogDigest } from "../../script/release-catalog"

const root = path.resolve(import.meta.dir, "../../../..")
const notices = ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]
const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"]
const version = "1.2.3"
// The publisher's byte audit derives the former product name from this real notice.
const realNotices = await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()
const formerName = realNotices
  .split("<!-- vector-upstream-attribution -->")[1]
  ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
  ?.trim()
  .toLowerCase()

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vector-cli-packaging-"))
  // Relocating the whole dependency directory breaks its relative workspace links on Windows.
  for (const name of ["@vectordevai/schema", "effect"]) {
    const destination = path.join(dir, "node_modules", name)
    await mkdir(path.dirname(destination), { recursive: true })
    await symlink(
      await dependencyRoot(name, path.join(root, "packages/engine")),
      destination,
      process.platform === "win32" ? "junction" : "dir",
    )
  }
  const catalog = catalogBody(
    JSON.stringify({ openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], models: {} } }),
  )
  const catalogHash = catalogDigest(catalog)
  await Bun.write(path.join(dir, "release-catalog.json"), catalog)
  await Bun.write(path.join(dir, "packages/engine/dist/api.json"), catalog)
  await Bun.write(
    path.join(dir, "packages/engine/script/release-catalog.ts"),
    Bun.file(path.join(root, "packages/engine/script/release-catalog.ts")),
  )
  await Bun.write(
    path.join(dir, "packages/engine/script/catalog-fork.ts"),
    Bun.file(path.join(root, "packages/engine/script/catalog-fork.ts")),
  )
  await Bun.write(
    path.join(dir, "packages/engine/script/publish-vector.ts"),
    Bun.file(path.join(root, "packages/engine/script/publish-vector.ts")),
  )
  await Bun.write(path.join(dir, "script/artifact-audit.ts"), Bun.file(path.join(root, "script/artifact-audit.ts")))
  // The publisher defaults to the CLI version the desktop requires, which need not be the desktop's own version.
  await Bun.write(
    path.join(dir, "packages/desktop/package.json"),
    JSON.stringify({ version: "9.9.9", vectorRequiredCliVersion: version }),
  )
  await Bun.write(
    path.join(dir, "packages/plugin/package.json"),
    JSON.stringify({ name: "@vectordevai/plugin", version: "0.1.0" }),
  )
  await Bun.write(
    path.join(dir, "packages/plugin/script/publish.ts"),
    'await Bun.write("publisher-args.json", JSON.stringify(process.argv.slice(2)))\n',
  )
  await Bun.write(path.join(dir, "user.npmrc"), "")
  await Bun.write(path.join(dir, "global.npmrc"), "")
  for (const notice of notices)
    await Bun.write(
      path.join(dir, notice),
      notice === "THIRD_PARTY_NOTICES.md" ? `Fixture ${notice}\n${realNotices}` : `Fixture ${notice}\n`,
    )
  for (const target of targets) {
    const folder = path.join(dir, "packages/engine/dist", `vector-${target}`)
    const [platform, arch] = target.split("-")
    await Bun.write(
      path.join(folder, "package.json"),
      JSON.stringify({
        name: `vector-${target}`,
        version,
        vectorCatalogSha256: catalogHash,
        os: [platform === "windows" ? "win32" : platform],
        cpu: [arch],
        files: ["bin", ...notices],
      }),
    )
    await Bun.write(
      path.join(folder, "bin", platform === "windows" ? "vector.exe" : "vector"),
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), vector: process.env.VECTOR_CLI }))\n",
    )
    for (const notice of notices) await Bun.write(path.join(folder, notice), Bun.file(path.join(dir, notice)))
  }
  return {
    dir,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(dir, "home"),
      NPM_CONFIG_USERCONFIG: path.join(dir, "user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(dir, "global.npmrc"),
      NPM_CONFIG_CACHE: path.join(dir, "npm-cache"),
      NPM_CONFIG_FETCH_RETRIES: "0",
      NPM_CONFIG_FETCH_TIMEOUT: "1000",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      VECTOR_RELEASE_CATALOG_PATH: path.join(dir, "release-catalog.json"),
      VECTOR_RELEASE_CATALOG_SHA256: catalogHash,
    },
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  }
}

async function dependencyRoot(name: string, from: string) {
  // Follow the installed resolver layout first; export maps may not expose package.json.
  let directory = path.dirname(Bun.resolveSync(name, from))
  while (true) {
    const manifest = Bun.file(path.join(directory, "package.json"))
    if ((await manifest.exists()) && (await manifest.json()).name === name) return await realpath(directory)
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`Could not locate the installed package root for ${name}`)
    directory = parent
  }
}

for (const layout of ["isolated", "hoisted"]) {
  test(`packaging dependencies resolve the installed package root with ${layout} workspace links`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vector-cli-dependency #%-"))
    try {
      const consumer = path.join(dir, "packages/engine")
      const dependency = path.join(dir, "packages/schema")
      const name = "@vector-fixture/schema"
      await mkdir(consumer, { recursive: true })
      await Bun.write(
        path.join(dependency, "package.json"),
        JSON.stringify({ name, type: "module", exports: { ".": "./src/index.ts", "./*": "./src/*.ts" } }),
      )
      await Bun.write(path.join(dependency, "src/index.ts"), 'export const identity = "installed workspace"\n')
      const link = path.join(layout === "isolated" ? consumer : dir, "node_modules", name)
      await mkdir(path.dirname(link), { recursive: true })
      await symlink(dependency, link, process.platform === "win32" ? "junction" : "dir")
      expect(await dependencyRoot(name, consumer)).toBe(await realpath(dependency))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

async function run(command: string[], cwd: string, env: Record<string, string | undefined>, phase?: string) {
  const started = performance.now()
  if (phase) console.info(`[cli-packaging] ${phase}: started`)
  const proc = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" })
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (phase)
      console.info(`[cli-packaging] ${phase}: exited ${code} after ${Math.round(performance.now() - started)}ms`)
    return { stdout, stderr, code }
  } finally {
    proc.kill()
    await proc.exited
  }
}

// The dry run starts seven processes on Windows: the publisher, its build step, the plugin publisher and npm, then
// npm pack and two tar extracts. It takes 4.2 to 4.5 s on a Windows runner. Twice a runner slowed for about 40 s,
// starting in the file before this one, and the publisher alone took 33 to 37 s (test.yml runs 42350032632 and
// 42453816512). So this test gets a limit of its own. A hung process still fails it.
test("dry-run packages every target with notices and a working Vector launcher without registry access", async () => {
  await using tmp = await fixture()
  const requests: string[] = []
  const registry = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(request.url)
      return Response.json({ version })
    },
  })
  try {
    const cwd = path.join(tmp.dir, "packages/engine")
    // Observe real npm startups; replacing npm would miss the Windows process-startup cost.
    const npmInvocations = path.join(tmp.dir, "npm-invocations.jsonl")
    const npmTrace = path.join(tmp.dir, "npm-trace.mjs")
    await Bun.write(
      npmTrace,
      `import { appendFileSync } from "node:fs"
if (process.argv[2] === "pack")
  appendFileSync(${JSON.stringify(npmInvocations)}, JSON.stringify(process.argv.slice(2)) + "\\n")
`,
    )
    // Observe the real publisher's build boundary without compiling the application.
    await Bun.write(
      path.join(cwd, "script/build.ts"),
      'await Bun.write("build-env.json", JSON.stringify({ version: process.env.VECTOR_VERSION, targets: process.env.VECTOR_TARGETS, release: process.env.VECTOR_RELEASE, catalog: process.env.VECTOR_RELEASE_CATALOG_PATH, digest: process.env.VECTOR_RELEASE_CATALOG_SHA256 }))\n',
    )
    const result = await run(
      [process.execPath, "script/publish-vector.ts", "--dry-run"],
      cwd,
      {
        ...tmp.env,
        NPM_CONFIG_REGISTRY: registry.url.toString(),
        VECTOR_VERSION: "stale-inherited-version",
        VECTOR_TARGETS: "stale-inherited-target",
        VECTOR_RELEASE: "true",
        VECTOR_CLI_VERSION: version,
        NODE_OPTIONS: `--import=${pathToFileURL(npmTrace).href}`,
      },
      "publisher dry-run",
    )
    expect(result.code, result.stderr).toBe(0)
    expect(requests).toEqual([])
    const dryPacks = (await Bun.file(npmInvocations).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as string[][]
    expect(dryPacks).toHaveLength(1)
    expect(dryPacks[0].slice(0, 3)).toEqual(["pack", "--dry-run", "--offline"])
    expect(
      (await Promise.all(dryPacks[0].slice(3).map((item) => realpath(path.resolve(cwd, item))))).toSorted(),
    ).toEqual(
      (
        await Promise.all(
          [
            ...targets.map((target) => path.join(cwd, "dist", `vector-${target}`)),
            path.join(cwd, "dist/vectordev-cli"),
          ].map((item) => realpath(item)),
        )
      ).toSorted(),
    )
    expect(await Bun.file(path.join(tmp.dir, "packages/plugin/publisher-args.json")).json()).toEqual(["--dry-run"])
    expect(await Bun.file(path.join(cwd, "build-env.json")).json()).toEqual({
      version,
      targets: targets.join(","),
      release: "",
      catalog: tmp.env.VECTOR_RELEASE_CATALOG_PATH,
      digest: tmp.env.VECTOR_RELEASE_CATALOG_SHA256,
    })

    const packedDirectory = path.join(tmp.dir, "packed")
    await mkdir(packedDirectory)
    // npm accepts multiple local packages; keep every real tarball check without seven extra npm startups.
    const packed = await run(
      [
        "npm",
        "pack",
        "--json",
        "--offline",
        "--pack-destination",
        packedDirectory,
        ...targets.map((target) => `./dist/vector-${target}`),
        "./dist/vectordev-cli",
      ],
      cwd,
      { ...tmp.env, NPM_CONFIG_REGISTRY: registry.url.toString() },
      "pack all seven staged packages",
    )
    expect(packed.code, packed.stderr).toBe(0)
    const packages = JSON.parse(packed.stdout) as { name: string; filename: string; files: { path: string }[] }[]
    expect(packages.map((item) => item.name).toSorted()).toEqual(
      [...targets.map((target) => `@vectordevai/cli-${target}`), "@vectordevai/cli"].toSorted(),
    )

    for (const target of [...targets, "umbrella"]) {
      const folder = path.join(cwd, "dist", target === "umbrella" ? "vectordev-cli" : `vector-${target}`)
      const manifest = await Bun.file(path.join(folder, "package.json")).json()
      expect(manifest.version).toBe(version)
      expect(manifest.license).toBe("SEE LICENSE IN LICENSE")
      expect(manifest.name).toBe(target === "umbrella" ? "@vectordevai/cli" : `@vectordevai/cli-${target}`)
      const info = packages.find((item) => item.name === manifest.name)
      if (!info) throw new Error(`npm did not pack ${manifest.name}`)
      expect(await Bun.file(path.join(packedDirectory, info.filename)).exists()).toBe(true)
      const files = info.files.map((file) => file.path)
      for (const notice of notices) expect(files).toContain(notice)
      expect(files.filter((name: string) => name.startsWith("bin/"))).toEqual([
        target === "umbrella" ? "bin/vector.cjs" : target.startsWith("windows") ? "bin/vector.exe" : "bin/vector",
      ])
      if (target === "umbrella") {
        expect(manifest.bin).toEqual({ vector: "./bin/vector.cjs" })
        expect(manifest.optionalDependencies).toEqual(
          Object.fromEntries(targets.map((item) => [`@vectordevai/cli-${item}`, version])),
        )
        // The desktop release refuses to start until each package it names is on npm, so the
        // publisher's default targets must publish exactly that set.
        const required = (
          Bun.YAML.parse(await Bun.file(path.join(root, ".github/workflows/vector-desktop-release.yml")).text()) as {
            jobs: { prepare: { steps: { name: string; run?: string }[] } }
          }
        ).jobs.prepare.steps
          .find((step) => step.name === "Require published CLI and plugin packages")
          ?.run?.match(/for package in ([^;]+);/)?.[1]
          ?.split(/\s+/)
          .filter((item) => item.startsWith("@vectordevai/cli-"))
          .toSorted()
        expect(required).toEqual(Object.keys(manifest.optionalDependencies).toSorted())
      }
      const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
      if (target !== "umbrella" && target !== host) continue
      const destination = path.join(tmp.dir, "installed/node_modules", manifest.name)
      await mkdir(destination, { recursive: true })
      const unpacked = await run(
        [
          "tar",
          "-xf",
          path.relative(destination, path.join(packedDirectory, info.filename)).split(path.sep).join("/"),
          "--strip-components",
          "1",
        ],
        destination,
        tmp.env,
        `extract ${target}`,
      )
      expect(unpacked.code, unpacked.stderr).toBe(0)
      for (const notice of notices)
        expect(await Bun.file(path.join(destination, notice)).text()).toBe(
          await Bun.file(path.join(tmp.dir, notice)).text(),
        )
    }
    expect(requests).toEqual([])
    // The fixture is a script; Windows requires a compiled PE executable for this final smoke check.
    if (process.platform === "win32") return
    const launched = await run(
      [
        "node",
        path.join(tmp.dir, "installed/node_modules/@vectordevai/cli/bin/vector.cjs"),
        "argument with spaces",
        "--version",
      ],
      cwd,
      tmp.env,
      "launch installed umbrella",
    )
    expect(launched.code, launched.stderr).toBe(0)
    expect(JSON.parse(launched.stdout)).toEqual({ args: ["argument with spaces", "--version"], vector: "1" })
  } finally {
    registry.stop(true)
  }
}, 120_000)

// Every borrowed OAuth registration stops publication except the Codex CLI client, which the provider policy
// still names with Sign in with ChatGPT off by default since 23 October 2026 (docs/vector/owner-actions/chatgpt.md).
const borrowedRegistrations = [
  "1d89f9fdb23ee96d4e603201f6861dab6e143c5c3c00469a018a2d94bdc03d4e",
  "Ov23li8tweQw6odWQebz",
  "b1a00492-073a-47ea-816f-4c329264a828",
]
for (const problem of [
  "stale version",
  "missing binary",
  "missing notice",
  "excluded notice",
  "shared credential",
  "wrong catalog digest",
  "former product name",
  "retired host",
  ...borrowedRegistrations,
]) {
  test(`refuses every package before publishing when the final target has ${problem}`, async () => {
    await using tmp = await fixture()
    const cwd = path.join(tmp.dir, "packages/engine")
    const folder = path.join(cwd, "dist", `vector-${targets.at(-1)}`)
    if (problem === "stale version" || problem === "excluded notice" || problem === "wrong catalog digest") {
      const file = Bun.file(path.join(folder, "package.json"))
      const manifest = await file.json()
      if (problem === "stale version") manifest.version = "0.0.1"
      if (problem === "excluded notice") manifest.files = ["bin", "LICENSE"]
      if (problem === "wrong catalog digest") manifest.vectorCatalogSha256 = "different-snapshot"
      await file.write(JSON.stringify(manifest))
    }
    if (problem === "missing binary") await rm(path.join(folder, "bin/vector.exe"))
    if (problem === "missing notice") await rm(path.join(folder, "THIRD_PARTY_NOTICES.md"))
    if (problem === "shared credential")
      await Bun.write(path.join(folder, "bin/vector.exe"), 'compiled fixture apiKey:"public"')
    if (problem === "former product name")
      await Bun.write(path.join(folder, "bin/vector.exe"), `compiled fixture ${formerName?.toUpperCase()} agent`)
    if (problem === "retired host")
      await Bun.write(path.join(folder, "bin/vector.exe"), 'compiled fixture fetch("https://models.dev/api.json")')
    if (borrowedRegistrations.includes(problem))
      await Bun.write(path.join(folder, "bin/vector.exe"), `compiled fixture ${problem}`)
    const result = await run([process.execPath, "script/publish-vector.ts", "--skip-build", "--dry-run"], cwd, tmp.env)
    expect(result.code).not.toBe(0)
    if (["former product name", "retired host", "shared credential", ...borrowedRegistrations].includes(problem))
      expect(result.stdout + result.stderr).toContain("artifact audit violation")
    expect((await Bun.file(path.join(cwd, "dist/vector-darwin-arm64/package.json")).json()).name).toBe(
      "vector-darwin-arm64",
    )
    expect(await Bun.file(path.join(cwd, "dist/vectordev-cli/package.json")).exists()).toBe(false)
  })
}

test("a failed plugin preparation stops the CLI publisher before any npm publish", async () => {
  await using tmp = await fixture()
  await Bun.write(
    path.join(tmp.dir, "packages/plugin/script/publish.ts"),
    'throw new Error("fixture plugin failure")\n',
  )
  const result = await run(
    [process.execPath, "script/publish-vector.ts", "--skip-build", "--publish"],
    path.join(tmp.dir, "packages/engine"),
    tmp.env,
  )
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("fixture plugin failure")
  expect(result.stdout).not.toContain("published @vectordevai/cli")
})

test.skipIf(process.platform === "win32")(
  "plugin publish inherits input through both publishers and preserves failure status",
  async () => {
    await using tmp = await fixture()
    const plugin = path.join(tmp.dir, "packages/plugin")
    for (const script of ["publish.ts", "build.ts"]) {
      await Bun.write(path.join(plugin, "script", script), Bun.file(path.join(root, "packages/plugin/script", script)))
    }
    await Bun.write(
      path.join(plugin, "dist-publish/package.json"),
      JSON.stringify({
        name: "@vectordevai/plugin",
        version,
        exports: {},
        license: "SEE LICENSE IN LICENSE",
        files: notices,
      }),
    )
    for (const notice of notices) await Bun.write(path.join(plugin, "dist-publish", notice), `Fixture ${notice}`)
    const npm = path.join(tmp.dir, "fake-bin/npm")
    await Bun.write(
      npm,
      `#!/usr/bin/env node
const fs = require("node:fs")
if (process.argv[2] === "view") process.exit(1)
if (process.argv[2] !== "publish") process.exit(36)
fs.writeFileSync(${JSON.stringify(path.join(tmp.dir, "prompt-input"))}, fs.readFileSync(0, "utf8"))
process.exit(35)
`,
    )
    await chmod(npm, 0o755)
    const child = Bun.spawn([process.execPath, "script/publish-vector.ts", "--skip-build", "--publish"], {
      cwd: path.join(tmp.dir, "packages/engine"),
      env: { ...tmp.env, PATH: path.dirname(npm) + path.delimiter + tmp.env.PATH },
      stdin: new Blob(["synthetic-otp\n"]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(35)
    expect(await Bun.file(path.join(tmp.dir, "prompt-input")).text()).toBe("synthetic-otp\n")
    expect(stdout).not.toContain("published @vectordevai/cli")
  },
)

test("the plugin publisher audits its staged package and refuses the former product name before npm runs", async () => {
  await using tmp = await fixture()
  const plugin = path.join(tmp.dir, "packages/plugin")
  for (const script of ["publish.ts", "build.ts"]) {
    await Bun.write(path.join(plugin, "script", script), Bun.file(path.join(root, "packages/plugin/script", script)))
  }
  await Bun.write(
    path.join(plugin, "dist-publish/package.json"),
    JSON.stringify({
      name: "@vectordevai/plugin",
      version,
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      license: "SEE LICENSE IN LICENSE",
      files: ["dist", ...notices],
    }),
  )
  for (const notice of notices) await Bun.write(path.join(plugin, "dist-publish", notice), `Fixture ${notice}`)
  await Bun.write(path.join(plugin, "dist-publish/dist/index.d.ts"), "export {}\n")
  await Bun.write(
    path.join(plugin, "dist-publish/dist/index.js"),
    `export const agent = "${formerName?.toUpperCase()}"\n`,
  )
  const npm = path.join(tmp.dir, "fake-bin/npm")
  await Bun.write(
    npm,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(path.join(tmp.dir, "npm-ran"))}, process.argv.slice(2).join(" "))
process.exit(1)
`,
  )
  await chmod(npm, 0o755)
  const result = await run([process.execPath, "script/publish.ts", "--skip-build", "--publish"], plugin, {
    ...tmp.env,
    VECTOR_PLUGIN_VERSION: version,
    PATH: path.dirname(npm) + path.delimiter + tmp.env.PATH,
  })
  expect(result.code).not.toBe(0)
  expect(result.stdout + result.stderr).toContain("artifact audit violation")
  expect(await Bun.file(path.join(tmp.dir, "npm-ran")).exists()).toBe(false)
})
