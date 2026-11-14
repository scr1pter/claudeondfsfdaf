import { cp, rm, stat } from "node:fs/promises"
import path from "node:path"

// The phone app (WP A38) is built by packages/app (`bun run build:phone` → packages/app/dist-phone) and published with
// the website at /phone, where vercel.json serves it on https://remote.vectordev.ai only. The website build copies it
// in after Astro finishes; script/prune-vector-site.mjs keeps it.

/** What a phone build must contain for the phone origin to work at all. */
export const PHONE_APP_FILES = ["index.html", "sw.js", "phone.webmanifest", "version.json"]

/**
 * Copies a built phone app into the website's output as `phone/`. A missing or incomplete build throws when
 * `required` (a Vercel build, which would otherwise publish the phone origin without its app) and is skipped with a
 * warning otherwise (a local website build that did not build the phone app).
 *
 * @param {{ from: string, to: string, required: boolean, warn?: (message: string) => void }} options
 */
export async function copyPhoneApp({ from, to, required, warn = console.warn }) {
  /** @type {string[]} */
  const missing = []
  for (const file of PHONE_APP_FILES) {
    const found = await stat(path.join(from, file)).catch(() => undefined)
    if (!found?.isFile()) missing.push(file)
  }
  if (missing.length) {
    const message = `The phone app is not built (${path.relative(process.cwd(), from) || from} lacks ${missing.join(", ")}). Run \`bun --cwd packages/app run build:phone\` first.`
    if (required) throw new Error(message)
    warn(message)
    return false
  }
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true, dereference: false, verbatimSymlinks: true })
  return true
}

/**
 * The Astro integration that runs the copy when the website build is done.
 *
 * @param {{ from: string, to: string }} options
 * @returns {import("astro").AstroIntegration}
 */
export function phoneApp({ from, to }) {
  return {
    name: "vector-phone-app",
    hooks: {
      "astro:build:done": async () => {
        await copyPhoneApp({ from, to, required: process.env.VERCEL === "1" })
      },
    },
  }
}
