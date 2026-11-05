import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Keep Bun's compiler types local: importing bun.d.ts would augment desktop renderer fetch globals.
declare const Bun: {
  build(options: {
    entrypoints: string[]
    target: "node"
    format: "esm"
    outdir: string
    naming: string
    plugins: {
      name: string
      setup(builder: {
        onLoad(
          options: { filter: RegExp },
          load: (args: { path: string }) => Promise<{ contents: string; loader: "ts" } | undefined>,
        ): void
      }): void
    }[]
  }): Promise<{ success: boolean }>
}

const packageDir = fileURLToPath(new URL("../", import.meta.url))

/** Bun compiles the tool once; all helper transport and lifecycle checks run in actual Node. */
export async function buildNodeSelfTest(outdir: string) {
  const directory = path.resolve(outdir)
  const entry = fileURLToPath(new URL("./computer-helper-selftest.ts", import.meta.url))
  const identity = fileURLToPath(new URL("./computer-helper-identity.ts", import.meta.url))
  await mkdir(directory, { recursive: true })
  const result = await Bun.build({
    entrypoints: [entry],
    target: "node",
    format: "esm",
    outdir: directory,
    naming: "driver.mjs",
    plugins: [
      {
        name: "preserve-selftest-source-locations",
        setup(builder) {
          builder.onLoad({ filter: /computer-helper-(?:selftest|identity)\.ts$/ }, async (args) => {
            if (args.path !== entry && args.path !== identity) return
            // Bundling otherwise moves default roots and makes an imported generator look like the CLI entry.
            return {
              contents: (await readFile(args.path, "utf8")).replaceAll(
                "import.meta.url",
                JSON.stringify(pathToFileURL(args.path).href),
              ),
              loader: "ts",
            }
          })
        },
      },
    ],
  })
  if (!result.success) throw new Error("The Node self-test driver could not be built.")
  const bootstrap = path.join(directory, "run.mjs")
  await writeFile(
    bootstrap,
    'import { runSelfTestCLI } from "./driver.mjs"\nawait runSelfTestCLI(process.argv.slice(2))\n',
  )
  return bootstrap
}

export async function runNodeSelfTest(argv: readonly string[]) {
  const base = path.join(packageDir, "native/build")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(path.join(base, "selftest-node-"))
  try {
    const bootstrap = await buildNodeSelfTest(directory)
    return await new Promise<number>((resolve, reject) => {
      const child = spawn("node", [bootstrap, ...argv], { stdio: "inherit", windowsHide: true })
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
      const forward = (signal: NodeJS.Signals) => child.kill(signal)
      const handlers = signals.map((signal) => {
        const handler = () => forward(signal)
        process.on(signal, handler)
        return { signal, handler }
      })
      const cleanup = () => handlers.forEach(({ signal, handler }) => process.off(signal, handler))
      child.once("error", () => {
        cleanup()
        reject(new Error("The Node self-test driver could not start."))
      })
      child.once("close", (code) => {
        cleanup()
        resolve(code ?? 1)
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runNodeSelfTest(process.argv.slice(2))
  } catch {
    process.stderr.write("Computer helper Node self-test could not start. Check Node and the toolchain.\n")
    process.exitCode = 2
  }
}
