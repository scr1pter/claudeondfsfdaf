// VS-48a metadata-only count contract. Never downloads, walks a repository, invokes Git, or reads instruction text.
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { Schema } from "effect"
import {
  countInstructionPaths,
  instructionInventoryPath,
  INSTRUCTION_PATH_SEGMENTS,
  MAX_INSTRUCTION_COUNT_BYTES,
  MAX_INSTRUCTION_COUNT_FILES,
} from "../../../packages/core/src/review/instruction-path"

export const MAX_INSTRUCTION_MANIFEST_BYTES = 16 * 1024 * 1024
export const MAX_INSTRUCTION_REPOSITORIES = 64
const Words = Schema.String.check(Schema.isLengthBetween(1, 200), Schema.isPattern(/^[A-Za-z0-9_./-]+$/))
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const File = Schema.Struct({
  path: Schema.String.check(Schema.makeFilter((value) => instructionInventoryPath(value) !== undefined)),
  origin: Schema.optional(Schema.Literals(["project", "vendored", "unknown"])),
})
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  repositories: Schema.Array(
    Schema.Struct({
      id: Words,
      revision: Commit,
      licence: Schema.Struct({
        spdx: Schema.Literals(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"]),
        path: File.fields.path,
        commit: Commit,
        classifierVersion: Words,
        d8Approved: Schema.Literal(true),
      }),
      files: Schema.Array(File).check(Schema.isMaxLength(MAX_INSTRUCTION_COUNT_FILES)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_INSTRUCTION_REPOSITORIES)),
})

/** Licence facts and ownership labels are supplied by the already-approved manifest, never guessed from code. */
export function countApprovedInstructionManifest(input: unknown) {
  const decoded = Schema.decodeUnknownOption(Manifest, { onExcessProperty: "error" })(input)
  if (decoded._tag === "None") throw new Error("Invalid approved instruction inventory.")
  const manifest = decoded.value
  if (new Set(manifest.repositories.map((repo) => repo.id)).size !== manifest.repositories.length)
    throw new Error("Duplicate repository in instruction inventory.")
  const files = manifest.repositories.reduce((total, repo) => total + repo.files.length, 0)
  const bytes = manifest.repositories.reduce(
    (total, repo) => total + repo.files.reduce((size, file) => size + new TextEncoder().encode(file.path).length, 0),
    0,
  )
  if (files > MAX_INSTRUCTION_COUNT_FILES || bytes > MAX_INSTRUCTION_COUNT_BYTES)
    throw new Error("Instruction inventory exceeds its global metadata limits.")
  const repositories = manifest.repositories.map((repo) => {
    if (repo.licence.commit !== repo.revision)
      throw new Error("Instruction inventory licence is not pinned to its revision.")
    const count = countInstructionPaths(repo.files)
    if (!count.complete) throw new Error(`Instruction inventory is incomplete: ${count.reason}.`)
    return { id: repo.id, revision: repo.revision, licence: repo.licence, count }
  })
  return {
    version: 1 as const,
    status: "measurement-only" as const,
    source: "operator-approved-path-inventory" as const,
    modelCalls: 0,
    instructionBytesRead: 0,
    collectorApplied: false,
    repositories,
    totals: {
      scannedFiles: files,
      nestedFiles: repositories.reduce((total, repo) => total + repo.count.nestedFiles, 0),
      excludedFiles: repositories.reduce((total, repo) => total + repo.count.excludedFiles, 0),
      segments: INSTRUCTION_PATH_SEGMENTS.map((segment) => {
        const rows = repositories.flatMap((repo) => repo.count.segments.filter((row) => row.segment === segment))
        return {
          segment,
          files: rows.reduce((total, row) => total + row.files, 0),
          project: rows.reduce((total, row) => total + row.project, 0),
          vendored: rows.reduce((total, row) => total + row.vendored, 0),
          unknown: rows.reduce((total, row) => total + row.unknown, 0),
        }
      }),
    },
  }
}

/** One explicitly supplied local manifest; bounded regular-file read, with no file paths from the input opened. */
export async function countInstructionManifestFile(file: string) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_INSTRUCTION_MANIFEST_BYTES)
      throw new Error("Instruction manifest must be a bounded regular file.")
    const buffer = Buffer.alloc(info.size + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
    }
    if (bytes !== info.size) throw new Error("Instruction manifest changed while reading.")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes))
    const input = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
    if (input._tag === "None") throw new Error("Invalid JSON instruction manifest.")
    return countApprovedInstructionManifest(input.value)
  } finally {
    await handle.close()
  }
}

if (import.meta.main) {
  if (process.argv.length !== 3 || !process.argv[2])
    throw new Error("Usage: bun instructions.ts <approved-local-inventory.json>")
  console.log(JSON.stringify(await countInstructionManifestFile(process.argv[2]), null, 2))
}
