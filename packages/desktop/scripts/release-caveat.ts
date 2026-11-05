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

if (import.meta.main) {
  const parsed = parseArgs({
    strict: true,
    allowPositionals: false,
    options: { tag: { type: "string" }, "lock-changed": { type: "string" } },
  })
  const tag = parsed.values.tag
  const changed = parsed.values["lock-changed"]
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag) || (changed !== "true" && changed !== "false"))
    throw new Error("Usage: --tag vMAJOR.MINOR.PATCH --lock-changed true|false")
  const document: unknown = JSON.parse(
    await readFile(new URL("../../web/public/changelog.json", import.meta.url), "utf8"),
  )
  if (!record(document) || !Array.isArray(document.releases)) throw new Error("The release changelog is invalid.")
  const entries = document.releases.filter((entry: unknown) => record(entry) && entry.tag === tag)
  if (entries.length !== 1) throw new Error("The release needs exactly one changelog entry.")
  if (requiresReaskCaveat(changed === "true", entries[0]))
    throw new Error("The measured helper changed: add the macOS access re-ask caveat to this release's desktop notes.")
}
