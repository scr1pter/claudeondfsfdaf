import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// Vercel runs each api/ function on Node after compiling the TypeScript files it reaches by relative path. A runtime
// import by workspace package name resolves to that package's TypeScript source inside node_modules, which Node will not
// load: every free-model route returned 500 in production because of one such import (17 October 2026). Bun runs
// TypeScript anywhere, so the source tests alone cannot catch it.
const root = path.join(import.meta.dir, "..")
const transpiler = new Bun.Transpiler({ loader: "ts" })

async function resolve(from: string, specifier: string) {
  const base = path.resolve(path.dirname(from), specifier)
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")]) {
    if (await Bun.file(candidate).exists()) return candidate
  }
  throw new Error(`${path.relative(root, from)} imports ${specifier}, which does not resolve to a file`)
}

test("api functions reach other workspace packages only through relative imports", async () => {
  const entries = Array.from(new Bun.Glob("api/**/*.ts").scanSync({ cwd: root }))
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => path.join(root, file))
  expect(entries.length).toBeGreaterThan(10)
  const seen = new Set<string>()
  const queue = [...entries]
  const packageImports: string[] = []
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    // scanImports leaves out type-only imports, which the compiler erases.
    for (const item of transpiler.scanImports(await Bun.file(file).text())) {
      if (item.path.startsWith(".")) queue.push(await resolve(file, item.path))
      else if (item.path.startsWith("@vectordevai/"))
        packageImports.push(`${path.relative(root, file)} -> ${item.path}`)
    }
  }
  expect(seen.size).toBeGreaterThan(entries.length)
  expect(packageImports).toEqual([])
})

test("fresh Node ESM callers, run tokens and readiness initialize in either import direction", async () => {
  const entries = [
    "api/_lib/cloud-agents-run-token.ts",
    "api/_lib/model-plan-caller.ts",
    "api/_lib/codium-perks.ts",
    "api/_lib/cloud-agents-entitlement.ts",
    "api/_lib/model-plan-models.ts",
    "api/_lib/cloud-agents-readiness.ts",
  ]
  const temporary = await mkdtemp(path.join(tmpdir(), "vector-api-import-"))
  try {
    await writeFile(path.join(temporary, "package.json"), '{"type":"module"}')
    await symlink(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir")
    const seen = new Set<string>()
    const queue = entries.map((entry) => path.join(root, entry))
    // Keep each module separate: a bundle can lower cyclic consts to vars and hide the Node ESM TDZ being tested.
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      let compiled = transpiler.transformSync(await Bun.file(file).text())
      for (const item of transpiler.scanImports(compiled)) {
        if (!item.path.startsWith(".")) continue
        const resolved = await resolve(file, item.path)
        queue.push(resolved)
        const relative = path.relative(path.dirname(file), resolved).replace(/\.ts$/, ".js").split(path.sep).join("/")
        const specifier = relative.startsWith(".") ? relative : `./${relative}`
        compiled = compiled
          .replaceAll(JSON.stringify(item.path), JSON.stringify(specifier))
          .replaceAll(`'${item.path}'`, JSON.stringify(specifier))
      }
      const output = path.join(temporary, path.relative(root, file).replace(/\.ts$/, ".js"))
      await mkdir(path.dirname(output), { recursive: true })
      await writeFile(output, compiled)
    }
    expect(seen.size).toBeGreaterThan(entries.length)
    const urls = entries.map((entry) => pathToFileURL(path.join(temporary, entry.replace(/\.ts$/, ".js"))).href)
    for (const first of urls) {
      const order = [first, ...urls.filter((url) => url !== first)]
      const result = spawnSync(
        "node",
        [
          "--input-type=module",
          "--eval",
          `import assert from 'node:assert/strict';
           globalThis.fetch = async () => { throw new Error('Import probe forbids network'); };
           for (const url of ${JSON.stringify(order)}) await import(url);
           const caller = await import(${JSON.stringify(urls[1])});
           await assert.rejects(caller.requireModelPlanCaller({headers:{authorization:'Bearer vrt_invalid.signature'}}),
             error => error?.code === 'MODEL_PLAN_RUN_EXPIRED');
           assert.throws(() => caller.registerRunVerifier('vrt_', async () => undefined), /exactly one verifier/);`,
        ],
        {
          cwd: temporary,
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, VECTOR_RUN_TOKEN_SECRET: "fixture-isolated-node-run-token-secret" },
        },
      )
      expect({
        first: path.basename(new URL(first).pathname),
        status: result.status,
        error: result.error?.message,
        stderr: result.stderr,
      }).toEqual({
        first: path.basename(new URL(first).pathname),
        status: 0,
        error: undefined,
        stderr: "",
      })
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}, 120_000)
