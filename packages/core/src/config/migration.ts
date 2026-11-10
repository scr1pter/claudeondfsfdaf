export * as ConfigMigration from "./migration"

import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import TOML from "smol-toml"
import { FSUtil } from "../fs-util"
import { EffectFlock } from "../util/effect-flock"
import { ConfigV1 } from "../v1/config/config"

const excluded = /^(?:vector|tui|package|auth|credential|secret|license|desktop-theme)(?:[.-]|$)/i
const assetNames = [
  "agent",
  "agents",
  "command",
  "commands",
  "plugin",
  "plugins",
  "skill",
  "skills",
  "theme",
  "themes",
  "tool",
  "tools",
  "mode",
  "modes",
]
// SHA-256 digests of the exact folder names that earlier agent versions created in projects and in the home
// folder. Matching digests recognizes only those folders, never look-alikes such as ~/.cursor or .github, and
// keeps the earlier product name out of Vector's source.
const earlierFolders = new Set(["5e2dd251c591a56f07d7103d60847b604e12ed80719fefa8342b70789f4d4907"])
const configKeys = new Set(Object.keys(ConfigV1.Info.fields))
const decode = Schema.decodeUnknownOption(ConfigV1.Info)

export function parseConfig(text: string, file: string): unknown {
  if (file.endsWith(".toml") || !/^\s*[{/]/.test(text)) {
    const data = TOML.parse(text)
    if (typeof data.provider !== "string" || typeof data.model !== "string") return data
    return {
      ...Object.fromEntries(Object.entries(data).filter(([key]) => key !== "provider")),
      model: `${data.provider}/${data.model}`,
    }
  }
  const errors: ParseError[] = []
  const result: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`Invalid settings in ${file}. Repair this file before starting Vector.`)
  return result
}

function decodeConfig(data: Record<string, unknown>) {
  if (Object.keys(data).some((key) => !configKeys.has(key))) throw new Error("Unknown configuration property")
  const decoded = decode(data)
  if (Option.isNone(decoded)) throw new Error("Invalid configuration shape")
  return decoded.value
}

function mergeSettings(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ ...left, ...right }).map(([key, value]) => [
      key,
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      left[key] &&
      typeof left[key] === "object" &&
      !Array.isArray(left[key])
        ? mergeSettings(left[key] as Record<string, unknown>, value as Record<string, unknown>)
        : value,
    ]),
  )
}

/**
 * Imports settings from `directory` into `destination`. Nothing is written unless every file it writes is a plain file
 * that really lands inside `root`, which is the workspace for a project folder and the folder itself for the user's.
 */
export const run = Effect.fn("ConfigMigration.run")(function* (
  directory: string,
  local = false,
  destination = directory,
  root = destination,
) {
  const fs = yield* FSUtil.Service
  if (!(yield* fs.isDir(directory))) return
  const flock = yield* EffectFlock.Service
  return yield* flock.withLock(
    Effect.gen(function* () {
      // Unreadable folders and files hold nothing to import; they must never stop config loading.
      const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.option)
      if (Option.isNone(entries)) return
      const stem = local ? "vector.local" : "vector"
      const targets = [path.join(destination, `${stem}.json`), path.join(destination, `${stem}.jsonc`)]
      for (const target of targets) {
        const text = yield* fs.readFileStringSafe(target)
        if (!text) continue
        const parsed = Option.liftThrowable(() => parseConfig(text, target))()
        // Existing Vector files belong to the normal loader, including its error handling.
        if (Option.isNone(parsed)) return
        if (
          parsed.value &&
          typeof parsed.value === "object" &&
          Object.keys(parsed.value).some((key) => key !== "$schema")
        )
          return
      }

      // The only extensionless settings file is the neutral `config` (TOML). Any other extensionless file, such as a
      // backup or a script in a shared folder above a non-git workspace, is not settings, so it never stops startup.
      const candidates = yield* Effect.forEach(
        entries.value.filter(
          (entry) =>
            entry.type === "file" &&
            !excluded.test(entry.name) &&
            (local
              ? /\.local\.jsonc?$/.test(entry.name)
              : (/\.(?:jsonc?|toml)$/.test(entry.name) || entry.name === "config") && !/\.local\./.test(entry.name)),
        ),
        Effect.fnUntraced(function* (entry) {
          const file = path.join(directory, entry.name)
          const info = yield* fs.stat(file).pipe(Effect.option)
          if (Option.isNone(info) || info.value.size > 1_048_576n) return
          const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))
          if (text === undefined) return
          const parsed = yield* Effect.try({ try: () => parseConfig(text, file), catch: (error) => error }).pipe(
            Effect.option,
          )
          if (Option.isNone(parsed)) {
            if (
              /\$schema["']?\s*[:=]\s*["'][^"']*\/config\.json["']/.test(text) ||
              /["']?permission["']?\s*[:=]/.test(text)
            )
              return yield* Effect.die(
                new Error(`Cannot import settings from ${file}. Repair this file before starting Vector.`),
              )
            return
          }
          if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return
          const data = Object.fromEntries(
            Object.entries(parsed.value).filter(([key]) => !["theme", "keybinds", "tui"].includes(key)),
          )
          const decoded = yield* Effect.try({
            try: () => decodeConfig(data),
            catch: (error) => error,
          }).pipe(Effect.option)
          if (Option.isNone(decoded)) {
            if (
              (typeof data.$schema === "string" && /\/config\.json(?:[?#]|$)/.test(data.$schema)) ||
              "permission" in data
            ) {
              return yield* Effect.die(
                new Error(`Cannot import settings from ${file}. Correct this config before starting Vector.`),
              )
            }
            return
          }
          const tui = Object.fromEntries(
            Object.entries(parsed.value).filter(([key]) => ["theme", "keybinds", "tui"].includes(key)),
          )
          if (!Object.keys(decoded.value).some((key) => key !== "$schema") && !Object.keys(tui).length) return
          return {
            file,
            name: entry.name,
            text: /^\s*[{/]/.test(text) ? text : JSON.stringify(parsed.value, null, 2),
            data: { ...decoded.value, ...tui },
          }
        }),
      )
      const sources = candidates.filter((item) => item !== undefined)
      const families = new Set(
        sources
          .filter((item) => !["config", "config.json", "config.toml"].includes(item.name))
          .map((item) => item.name.replace(/\.(?:jsonc?|toml)$/, "")),
      )
      if (!sources.length) return
      if (families.size > 1) {
        return yield* Effect.die(
          new Error(
            `Multiple settings files found in ${directory}. Merge them into ${targets[1]} before starting Vector.`,
          ),
        )
      }
      const ordered = sources.toSorted(
        (a, b) =>
          Number(["config", "config.toml"].includes(a.name)) - Number(["config", "config.toml"].includes(b.name)) ||
          Number(a.name !== "config.json") - Number(b.name !== "config.json") ||
          Number(a.name.endsWith(".jsonc")) - Number(b.name.endsWith(".jsonc")),
      )
      const merged = ordered.reduce<Record<string, unknown>>((result, item) => mergeSettings(result, item.data), {})
      const original = ordered.at(-1)!.text
      const text = Object.entries({ ...merged, $schema: "https://vectordev.ai/config.json" }).reduce(
        (result, [key, value]) =>
          applyEdits(result, modify(result, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
        original,
      )
      // This runs before the workspace is trusted, and writing follows links: a project can ship its .gitignore or
      // settings file as a link to a file outside it.
      const refused = [targets[1], ...(local ? [path.join(destination, ".gitignore")] : [])].find(
        (file) => !FSUtil.writableInside(root, file),
      )
      if (refused) {
        yield* Effect.logWarning(
          `Skipped importing settings from ${directory}: ${refused} is a link, not a plain file, or outside ${root}.`,
        )
        return
      }
      if (local) {
        const gitignore = path.join(destination, ".gitignore")
        const existing = (yield* fs.readFileStringSafe(gitignore)) ?? ""
        const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
        const missing = targets.map((file) => path.basename(file)).filter((file) => !lines.has(file))
        if (missing.length) {
          yield* fs.writeFileString(gitignore, [existing.trimEnd(), ...missing].filter(Boolean).join("\n") + "\n")
        }
      }
      // Write beside the destination and rename atomically. Never change the source files.
      yield* fs.ensureDir(destination)
      const temporary = `${targets[1]}.${crypto.randomUUID()}.tmp`
      yield* fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" })
      yield* fs.rename(temporary, targets[1]).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
      const message = `Imported settings from ${ordered.map((item) => item.file).join(", ")} into ${targets[1]}. Original files were kept.`
      yield* Effect.logInfo(message)
      return { sources: ordered.map((item) => item.file), target: targets[1], message }
    }),
    `config-import:${directory}:${local}`,
  )
})

/** Copy only recognized configuration assets. An unrelated hidden folder is never imported. */
export const discover = Effect.fn("ConfigMigration.discover")(function* (input: {
  directory: string
  worktree?: string
  global: string
  home: string
  disableProject?: boolean
}) {
  const fs = yield* FSUtil.Service
  const results: Array<{ sources: string[]; target: string; message: string }> = []
  // Imports write before the workspace is trusted. A folder inside the workspace is written only where it really is
  // inside the workspace, so a project folder that links out of it is never written. The home folder and the folders
  // above a non-git workspace, whose settings load with the project's, are written only inside themselves.
  const workspace = path.resolve(input.worktree && input.worktree !== "/" ? input.worktree : input.directory)
  // Decided under every spelling of the workspace, not only as written: a folder reached through an alias of the
  // workspace, or through a workspace link that points out, is the workspace's. One that cannot be resolved is held to
  // the workspace too, which nothing behind a link loop can pass.
  const owner = (directory: string) => {
    try {
      return FSUtil.within([workspace], directory) === undefined ? directory : workspace
    } catch {
      return workspace
    }
  }
  // The global folder can come from VECTOR_AGENT_CONFIG_DIR, which can name a folder of the project's.
  const global = yield* run(input.global, false, input.global, owner(input.global))
  if (global) results.push(global)
  const parents: string[] = []
  const visit = (directory: string): void => {
    parents.push(directory)
    const parent = path.dirname(directory)
    if (directory === input.worktree || directory === input.home || parent === directory) return
    visit(parent)
  }
  if (!input.disableProject) visit(path.resolve(input.directory))
  for (const directory of parents.toReversed()) {
    const imported = yield* run(directory, false, directory, owner(directory))
    if (imported) results.push(imported)
  }
  for (const directory of new Set([input.home, ...parents])) {
    const root = owner(directory)
    // Only the exact earlier folder is opened; other dot folders, such as ~/.Trash, which macOS refuses to list
    // without Full Disk Access, are never read. An unreadable folder holds nothing to import.
    const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => []))
    // Earlier versions followed a linked earlier folder, such as one managed by dotfiles, so it is imported too.
    const earlier = entries.find(
      (entry) =>
        (entry.type === "directory" || entry.type === "symlink") &&
        earlierFolders.has(createHash("sha256").update(entry.name).digest("hex")),
    )
    if (!earlier) continue
    const source = path.join(directory, earlier.name)
    if (!(yield* fs.isDir(source))) continue
    // Only the home folder's earlier folder is followed wherever it links. Anywhere else a link can be a repository's,
    // pointing at the user's own settings elsewhere, and importing it would copy their keys into the repository
    // before trust.
    if (directory !== input.home && !realInside(root, source)) {
      yield* Effect.logWarning(`Skipped importing ${source}: it links outside ${root}.`)
      continue
    }
    // No marker is written for a folder that cannot be listed yet, so a later launch imports it once readable.
    const listing = yield* fs.readDirectoryEntries(source).pipe(Effect.option)
    if (Option.isNone(listing)) {
      yield* Effect.logWarning(`Cannot read ${source}. Its settings will be imported once it is readable.`)
      continue
    }
    const files = listing.value
    const assets = files.filter((file) => file.type === "directory" && assetNames.includes(file.name))
    const target = path.join(directory, ".vector")
    // A linked .vector in the user's home folder is theirs to merge. Anywhere else, such as an extracted archive or a
    // shared folder above a non-git workspace, it is not, so it never stops Vector from starting.
    if (entries.find((entry) => entry.name === ".vector")?.type === "symlink") {
      if (directory !== input.home) {
        yield* Effect.logWarning(`Skipped importing ${source}: ${target} is a link.`)
        continue
      }
      return yield* Effect.die(
        new Error(
          `Cannot import into linked folder ${target}. Merge the earlier settings into the intended destination before starting Vector.`,
        ),
      )
    }
    const marker = path.join(target, "vector-migration.json")
    if (yield* fs.exists(marker)) continue
    if (!FSUtil.writableInside(root, marker)) {
      yield* Effect.logWarning(`Skipped importing ${source}: ${target} is not a plain folder inside ${root}.`)
      continue
    }
    const flock = yield* EffectFlock.Service
    const copied = yield* flock.withLock(
      Effect.gen(function* () {
        if (yield* fs.exists(marker)) return
        yield* fs.ensureDir(target)
        const imported = yield* run(source, false, target, root)
        const local = yield* run(source, true, target, root)
        if (imported) results.push(imported)
        if (local) results.push(local)
        // package.json only carries dependencies for copied plugins and tools.
        const copies = files.filter(
          (file) =>
            assetNames.includes(file.name) ||
            ["tui.json", "tui.jsonc", "AGENTS.md"].includes(file.name) ||
            (file.name === "package.json" && assets.length > 0),
        )
        for (const item of copies) yield* copyAsset(path.join(source, item.name), path.join(target, item.name))
        yield* fs.writeFileString(marker, JSON.stringify({ source, version: 1 }, null, 2), {
          mode: 0o600,
          flag: "wx",
        })
        if (!copies.length) return
        const message = `Imported agent assets from ${source} into ${target}. Original files were kept.`
        yield* Effect.logInfo(message)
        return { sources: [source], target, message }
      }),
      `config-folder-import:${target}`,
    )
    if (copied) results.push(copied)
  }
  return results
})

const copyAsset: (source: string, target: string) => Effect.Effect<void, FSUtil.Error, FSUtil.Service> = Effect.fn(
  "ConfigMigration.copyAsset",
)(function* (source: string, target: string) {
  const fs = yield* FSUtil.Service
  const existing = (yield* fs.readDirectoryEntries(path.dirname(target))).find(
    (entry) => entry.name === path.basename(target),
  )?.type
  const linked =
    (yield* fs.readDirectoryEntries(path.dirname(source))).find((entry) => entry.name === path.basename(source))
      ?.type === "symlink"
  // stat follows links, so a linked asset is judged by what it points to; a broken link is skipped like an unreadable file.
  const info = yield* fs.stat(source).pipe(Effect.option)
  if (Option.isNone(info)) return yield* skipUnreadable(source)
  if (existing === "symlink") {
    // A link left by an interrupted import already points at the same content.
    const current = yield* fs.realPath(target).pipe(Effect.option)
    const original = yield* fs.realPath(source)
    if (Option.isSome(current) && current.value === original) return
    return yield* Effect.die(
      new Error(`Cannot replace linked settings at ${target}. Resolve the link before starting Vector.`),
    )
  }
  // Earlier versions and Vector both follow linked assets, so keep the link instead of copying what it points to.
  // Where links cannot be created, such as on Windows without Developer Mode, the asset is skipped with a warning.
  if (linked && existing === undefined)
    return yield* fs
      .symlink(yield* fs.realPath(source), target)
      .pipe(
        Effect.catch(() =>
          Effect.logWarning(`Skipped linked ${source} while importing earlier settings; link it into ${target}.`),
        ),
      )
  if (info.value.type === "Directory") {
    const children = yield* fs.readDirectoryEntries(source).pipe(Effect.option)
    if (Option.isNone(children)) return yield* skipUnreadable(source)
    yield* fs.ensureDir(target)
    for (const child of children.value) yield* copyAsset(path.join(source, child.name), path.join(target, child.name))
    return
  }
  if (info.value.type !== "File")
    return yield* Effect.die(
      new Error(
        `Cannot import special file ${source}. Move the intended settings into ${target} before starting Vector.`,
      ),
    )
  if (Option.isNone(yield* fs.access(source, { readable: true }).pipe(Effect.option)))
    return yield* skipUnreadable(source)
  if (existing !== undefined) {
    const original = yield* fs.readFile(source)
    const current = existing === "file" ? yield* fs.readFile(target) : undefined
    if (current && Buffer.from(original).equals(Buffer.from(current))) return
    return yield* Effect.die(
      new Error(
        `Existing settings at ${target} conflict with ${source}. Merge them before starting Vector; neither file was changed.`,
      ),
    )
  }
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  yield* fs.copyFile(source, temporary)
  yield* fs.rename(temporary, target).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
})

// The marker is still written: retrying would report conflicts for imported files the user has since edited.
function skipUnreadable(source: string) {
  return Effect.logWarning(`Skipped ${source} while importing earlier settings because it cannot be read.`)
}

// Whether a path really lies inside root once both are resolved. One that cannot be resolved does not.
function realInside(root: string, file: string) {
  try {
    return FSUtil.contains(FSUtil.realpath(root), FSUtil.realpath(file))
  } catch {
    return false
  }
}
