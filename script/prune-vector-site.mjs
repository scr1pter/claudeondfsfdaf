import { copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "packages", "web", "dist")

const keep = new Set([
  "_astro",
  "account",
  "codium",
  "auth",
  "design",
  "docs",
  "download",
  // The unlisted investor one-pager (noindex, shared by link only).
  "investors",
  "legal",
  "login",
  "s",
  "support",
  // The owner's usage dashboard; api/usage/summary decides who sees any numbers.
  "usage",
  // Private owner shells contain no data; the owner API authorizes every read and mutation.
  "owner",
  "install",
  "install.ps1",
  "index.html",
  "404.html",
  "favicon.ico",
  "favicon.svg",
  "favicon-v3.ico",
  "favicon-v3.svg",
  "favicon-96x96.png",
  "favicon-96x96-v3.png",
  "favicon-32x32-desktop-v4.png",
  "favicon-96x96-desktop-v4.png",
  "favicon-desktop-v4.ico",
  "apple-touch-icon.png",
  "apple-touch-icon-v3.png",
  "apple-touch-icon-desktop-v4.png",
  "site.webmanifest",
  "web-app-manifest-192x192.png",
  "web-app-manifest-512x512.png",
  "robots.txt",
  "sitemap-0.xml",
  "sitemap-index.xml",
  "theme.json",
  "config.json",
  "tui.json",
  "desktop-theme.json",
  // The feed the desktop app polls for "what's new". Pruning it is what made
  // the release-notes dialog silently never run.
  "changelog.json",
  // The model catalog every installed app refreshes from (packages/core/src/model-catalog.ts DEFAULT_MIRROR).
  "models",
  // The owner's off-switch for Sign in with ChatGPT that every installed app reads
  // (packages/core/src/provider-remote-policy.ts POLICY_URL, docs/vector/owner-actions/chatgpt.md).
  "policy",
  "vector-logo.png",
  "vector-space-backdrop.png",
])

const publicExtensions = new Set([
  ".aac",
  ".avif",
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".mjs",
  ".mp3",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".svg",
  ".ttf",
  ".txt",
  ".wasm",
  ".wav",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
  ".xml",
])

export async function pruneVectorSite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (!keep.has(entry.name) || entry.isSymbolicLink()) {
      await rm(target, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) await prunePublicDirectory(target)
  }

  await copyFile(path.join(directory, "index.html"), path.join(directory, "404.html"))
  await dropUnpublishedFromSitemap(path.resolve(directory))
}

// Starlight's sitemap lists every prerendered page, including the ones that ask search engines not to index them,
// such as the unlisted investor page and the account pages, and the ones the prune above just deleted, such as the
// /dev previews. Neither may be advertised: a noindex page is meant to stay unlisted, and a deleted one would 404.
async function dropUnpublishedFromSitemap(directory) {
  const file = path.join(directory, "sitemap-0.xml")
  const sitemap = await readFile(file, "utf8").catch(() => "")
  const entries = await Promise.all(
    Array.from(sitemap.matchAll(/<url>.*?<\/url>/gs), async ([entry]) => ({
      entry,
      hidden: await isUnpublished(directory, entry),
    })),
  )
  const hidden = entries.filter((item) => item.hidden)
  if (!hidden.length) return
  await writeFile(file, hidden.reduce((text, item) => text.replace(item.entry, ""), sitemap))
}

// `directory` must be resolved: a trailing slash would make every page fail the containment check below and keep
// every entry.
async function isUnpublished(directory, entry) {
  const location = entry.match(/<loc>(.*?)<\/loc>/s)?.[1]
  if (!location || !URL.canParse(location)) return false
  const page = path.join(directory, decodeURIComponent(new URL(location).pathname), "index.html")
  if (!page.startsWith(directory + path.sep)) return false
  const html = await readFile(page, "utf8").catch(() => undefined)
  if (html === undefined) return true
  return /<meta name="robots" content="[^"]*noindex/i.test(html)
}

async function prunePublicDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) {
      await rm(target, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) {
      await prunePublicDirectory(target)
      continue
    }
    if (
      !entry.isFile() ||
      entry.name.endsWith(".map") ||
      !publicExtensions.has(path.extname(entry.name).toLowerCase())
    ) {
      await rm(target, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await pruneVectorSite(dist)
}
