import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"

// WP A54: hostd and the viewer proxy run under Node on the cloud computer (bundled by `bun run build`), so src/ uses
// Node's own modules, the shared schema and relative imports only, and no Bun API. Nothing in src/ reads a secret from
// the environment, calls fetch (which adds `sec-fetch-mode`, refused by the run-API host), or turns a sandbox off.

const root = path.join(import.meta.dir, "..")

async function sources() {
  const files = (await readdir(path.join(root, "src"))).filter((file) => file.endsWith(".ts"))
  return Promise.all(files.map(async (file) => ({ file, text: await Bun.file(path.join(root, "src", file)).text() })))
}

describe("src/", () => {
  test("imports only node:, the shared schema and its own files", async () => {
    for (const { file, text } of await sources()) {
      const specifiers = [...text.matchAll(/^\s*(?:import|export)\b[^"']*?from\s*["']([^"']+)["']/gm)].map((match) => match[1]!)
      const outside = specifiers.filter((specifier) => !specifier.startsWith("./") && !specifier.startsWith("node:") && specifier !== "@vectordevai/schema/hosted")
      expect({ file, outside }).toEqual({ file, outside: [] })
      expect({ file, dynamic: /\bimport\s*\(|\brequire\s*\(/.test(text) }).toEqual({ file, dynamic: false })
    }
  })

  test("no Bun API, no fetch, no environment secret, no sandbox switched off", async () => {
    for (const { file, text } of await sources()) {
      const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
      expect({ file, bun: code.match(/\bBun\.|from "bun|bun:/g) ?? [] }).toEqual({ file, bun: [] })
      expect({ file, fetch: /(?<!async )(?<![.\w])fetch\s*\(/.test(code) }).toEqual({ file, fetch: false })
      expect({ file, env: code.match(/process\.env\.[A-Z_]+/g) ?? [] }).toEqual({ file, env: [] })
      expect({ file, unsafe: code.match(/--no-sandbox|--disable-web-security|--remote-debugging-port/g) ?? [] }).toEqual({ file, unsafe: [] })
    }
  })

  test("the daemon's entry points are hostd.ts and viewer-proxy.ts, as the build and boot.sh name them", async () => {
    const manifest = (await Bun.file(path.join(root, "package.json")).json()) as { scripts: Record<string, string> }
    expect(manifest.scripts.build).toContain("./src/hostd.ts ./src/viewer-proxy.ts --target=node")
    const lib = await Bun.file(path.join(root, "image", "boot-lib.sh")).text()
    expect(lib).toContain("node /opt/vector/hostd.mjs --run-host")
    expect(lib).toContain("node /opt/vector/viewer-proxy.mjs")
  })
})
