import { readFile } from "node:fs/promises"
import path from "node:path"
import { build, type Plugin } from "vite"
import { versionFile } from "./version"

// The phone app's build (WP A38), used by vite.config.ts in `--mode phone` (`bun run build:phone`). It runs in Node
// at build time and is never bundled. Next to the page and its assets in dist-phone it writes, at fixed names:
//
// - phone.webmanifest and the icons it names, so Home Screen installs find them under /phone/;
// - version.json, the deployed build for the version handshake (version.ts);
// - sw.js, the service worker as one classic script, built on its own so it never imports a chunk shared with the
//   page (a module worker is not available on every phone the app supports).
//
// It also refuses a page with an inline script or style attribute, which the phone origin's CSP would block.

export type PhoneBuildOptions = {
  /** packages/app */
  appRoot: string
  /** packages/app/dist-phone */
  outDir: string
  /** The build id the bundle, the worker and version.json all carry. */
  build: string
}

const ICONS = [
  ["web-app-manifest-192x192.png", "icons/icon-192.png"],
  ["web-app-manifest-512x512.png", "icons/icon-512.png"],
  ["apple-touch-icon-desktop-v4.png", "icons/apple-touch-icon.png"],
  ["favicon-32x32-desktop-v4.png", "icons/favicon-32.png"],
] as const

/** The build id: `VECTOR_PHONE_BUILD` when given, else the app version and the commit, else the version alone. */
export function phoneBuildId(env: Record<string, string | undefined>, version: string) {
  const explicit = env.VECTOR_PHONE_BUILD?.trim()
  if (explicit && /^[A-Za-z0-9._-]{1,64}$/.test(explicit)) return explicit
  const commit = (env.VERCEL_GIT_COMMIT_SHA ?? env.GITHUB_SHA)?.trim()
  if (commit && /^[0-9a-f]{7,40}$/i.test(commit)) return `${version}-${commit.slice(0, 12)}`
  return `${version}-local`
}

/** The problems that would make the phone origin's CSP block part of a built page. */
export function cspProblems(html: string) {
  const problems: string[] = []
  if (/<script\b(?![^>]*\bsrc\s*=)[^>]*>\s*\S/i.test(html)) problems.push("an inline script")
  if (/<[a-z][^>]*\sstyle\s*=/i.test(html)) problems.push("an inline style attribute")
  if (/<style\b/i.test(html)) problems.push("an inline style element")
  if (/\son[a-z]+\s*=/i.test(html)) problems.push("an inline event handler")
  return problems
}

export function phoneBuildPlugin(options: PhoneBuildOptions): Plugin {
  const phone = path.join(options.appRoot, "src", "phone")
  return {
    name: "vector:phone-build",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const problems = cspProblems(html)
        if (problems.length) throw new Error(`The phone page has ${problems.join(", ")}, which its CSP blocks.`)
        return html
      },
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "phone.webmanifest",
        source: await readFile(path.join(phone, "phone.webmanifest"), "utf8"),
      })
      for (const [from, to] of ICONS)
        this.emitFile({
          type: "asset",
          fileName: to,
          source: await readFile(path.join(options.appRoot, "public", from)),
        })
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify(versionFile(options.build))}\n`,
      })
    },
    async closeBundle() {
      await build({
        configFile: false,
        root: phone,
        publicDir: false,
        logLevel: "warn",
        define: { __VECTOR_PHONE_BUILD__: JSON.stringify(options.build) },
        build: {
          outDir: options.outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          minify: true,
          lib: {
            entry: path.join(phone, "sw.ts"),
            formats: ["iife"],
            name: "VectorPhoneWorker",
            fileName: () => "sw.js",
          },
        },
      })
    },
  }
}
