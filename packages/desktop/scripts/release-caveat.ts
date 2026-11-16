import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** True means a changed measured helper still lacks its explicit macOS access re-ask caveat. */
export function requiresReaskCaveat(lockChanged: boolean, entry: unknown) {
  if (!lockChanged) return false
  if (!record(entry) || !Array.isArray(entry.highlights)) return true
  return !entry.highlights.some(
    (highlight: unknown) =>
      record(highlight) &&
      highlight.source === "desktop" &&
      Array.isArray(highlight.items) &&
      highlight.items.some(
        (item: unknown) =>
          record(item) &&
          typeof item.description === "string" &&
          item.description
            .normalize("NFKC")
            .replace(/\s+/g, " ")
            .toLowerCase()
            .includes("macos may ask you to grant access again after a helper update"),
      ),
  )
}

/** Select published notes unless an explicit artifacts-only Hands preview passes every source/channel guard. */
export function releaseCaveatEntry(
  document: unknown,
  tag: string,
  preview?: { entry: unknown; environment: Readonly<Record<string, string | undefined>> },
) {
  if (!record(document) || !Array.isArray(document.releases)) throw new Error("The release changelog is invalid.")
  const entries = document.releases.filter((entry: unknown) => record(entry) && entry.tag === tag)
  if (entries.length !== 1) throw new Error("The release needs exactly one changelog entry.")
  if (!preview) return entries[0]
  const environment = preview.environment
  if (
    environment.RELEASE_DRY_RUN !== "true" ||
    environment.REQUESTED_UNSIGNED !== "true" ||
    environment.RELEASE_PRERELEASE !== "false" ||
    environment.VECTOR_CHANNEL !== "prod" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REF !== "refs/heads/hands" ||
    !environment.GITHUB_REPOSITORY ||
    environment.EVENT_REPOSITORY !== environment.GITHUB_REPOSITORY
  )
    throw new Error(
      "Hands draft notes require an explicit unsigned same-repository stable artifacts-only dispatch on hands.",
    )
  return preview.entry
}

if (import.meta.main) {
  const parsed = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      tag: { type: "string" },
      "lock-changed": { type: "string" },
      "hands-preview": { type: "string", default: "false" },
    },
  })
  const tag = parsed.values.tag
  const changed = parsed.values["lock-changed"]
  const preview = parsed.values["hands-preview"]
  if (
    !tag ||
    !/^v\d+\.\d+\.\d+$/.test(tag) ||
    (changed !== "true" && changed !== "false") ||
    (preview !== "true" && preview !== "false")
  )
    throw new Error("Usage: --tag vMAJOR.MINOR.PATCH --lock-changed true|false [--hands-preview true|false]")
  const document: unknown = JSON.parse(
    await readFile(new URL("../../web/public/changelog.json", import.meta.url), "utf8"),
  )
  const draft = preview === "true" ? await handsDraft() : undefined
  if (requiresReaskCaveat(changed === "true", releaseCaveatEntry(document, tag, draft)))
    throw new Error("The measured helper changed: add the macOS access re-ask caveat to this release's desktop notes.")
}

async function handsDraft() {
  const { handsReleasePreview } = await import("../../web/src/data/vector-releases")
  return {
    entry: { highlights: [{ source: "desktop", items: [{ description: handsReleasePreview.summary }] }] },
    environment: process.env,
  }
}
