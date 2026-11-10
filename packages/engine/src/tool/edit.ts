// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { FileSystem } from "@vectordevai/core/filesystem"
import { Watcher } from "@vectordevai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { assertOwnedPath } from "./owned-path"
import { FileLock } from "./file-lock"
import { FileState } from "./file-state"
import { FSUtil } from "@vectordevai/core/fs-util"
import * as Bom from "@/util/bom"
import { Instruction } from "../session/instruction"
import { SessionMemory } from "../session/memory"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  oldString: Schema.String.annotate({ description: "The text to replace" }),
  newString: Schema.String.annotate({
    description: "The text to replace it with (must be different from oldString)",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString (default false)",
  }),
})

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const instruction = yield* Instruction.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          if (params.oldString === params.newString) {
            throw new Error("No changes to apply: oldString and newString are identical.")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)
          yield* assertOwnedPath(ctx, filePath)

          const empty =
            "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement."
          const creating = params.oldString === ""
          // The change on the file's text as it is: worked out again when the file changed during the ask.
          const derive = (current: FileState.Observed | undefined) => {
            if (creating) {
              const next = Bom.split(params.newString)
              return { contentOld: "", contentNew: next.text, bom: next.bom }
            }
            const source = Bom.decode(current!.bytes)
            const ending = detectLineEnding(source.text)
            const old = convertToLineEnding(normalizeLineEndings(params.oldString), ending)
            const replacement = convertToLineEnding(normalizeLineEndings(params.newString), ending)
            const next = Bom.split(replace(source.text, old, replacement, params.replaceAll))
            return { contentOld: source.text, contentNew: next.text, bom: source.bom || next.bom }
          }
          const patch = (from: string, to: string) =>
            trimDiff(createTwoFilesPatch(filePath, filePath, normalizeLineEndings(from), normalizeLineEndings(to)))

          let before: FileState.Observed | undefined
          if (creating) {
            if (yield* afs.existsSafe(filePath)) throw new Error(empty)
          } else {
            const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`File ${filePath} not found`)
            if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
            before = yield* FileState.observe(filePath)
            if (!before) throw new Error(`File ${filePath} not found`)
          }
          const check = (now: FileState.Observed | undefined) =>
            FileState.verify({
              sessionID: ctx.sessionID,
              file: filePath,
              now: now?.stamp,
              kind: creating ? "create" : "update",
              messages: ctx.messages,
              tool: "edit",
              inFamily: ctx.inFamily,
            })
          yield* check(before)

          let change = derive(before)
          let diff = patch(change.contentOld, change.contentNew)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filePath)],
            always: ["*"],
            metadata: {
              filepath: filePath,
              diff,
            },
          })

          // Never held across the ask. Inside it the file is read again: this session's own change since (a parallel
          // edit in the same step) passes and the edit is applied to the new text; anyone else's is refused.
          const { contentOld, contentNew, fileState } = yield* FileLock.withFiles([filePath])(
            Effect.gen(function* () {
              const current = yield* FileState.observe(filePath)
              if (!FileState.same(current?.stamp, before?.stamp)) {
                if (creating && current) throw new Error(empty)
                if (!creating && !current) throw new Error(`File ${filePath} not found`)
                yield* check(current)
                change = derive(current)
              }
              if (ctx.assertWritable) yield* ctx.assertWritable({ files: [filePath] })
              yield* FileLock.write(afs, filePath, Bom.join(change.contentNew, change.bom))
              let written = change.contentNew
              if (yield* format.file(filePath)) {
                written = yield* Bom.syncFile(afs, filePath, change.bom)
              }
              const fileState = yield* FileState.commit({
                sessionID: ctx.sessionID,
                file: filePath,
                title: typeof ctx.extra?.subagentTitle === "string" ? ctx.extra.subagentTitle : undefined,
              })
              yield* events.publish(FileSystem.Event.Edited, {
                file: filePath,
                sessionID: ctx.sessionID,
                agent: ctx.agent,
                messageID: ctx.messageID,
              })
              yield* events.publish(Watcher.Event.Updated, {
                file: filePath,
                event: creating ? "add" : "change",
              })
              return { contentOld: change.contentOld, contentNew: written, fileState }
            }),
          )
          diff = patch(contentOld, contentNew)

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = "Edit applied successfully."
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = FSUtil.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`
          const guarded = yield* instruction.guard(ctx.messages, [filePath], ctx.messageID, SessionMemory.linking(ctx))
          if (guarded.text) output += `\n\n${guarded.text}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
              fileState,
              ...(guarded.links.length ? { [Instruction.LINKS]: guarded.links } : {}),
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)

  // Handle single line matches
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  // Try direct match with unescaped find string
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  // Also try finding escaped versions in content that match unescaped find
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  // This replacer yields all exact matches, allowing the replace function
  // to handle multiple occurrences based on replaceAll parameter
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) {
    // Need at least 3 lines to have meaningful context
    return
  }

  // Remove trailing empty line if present
  if (findLines[findLines.length - 1] === "") {
    findLines.pop()
  }

  const contentLines = content.split("\n")

  // Extract first and last lines as context anchors
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  // Find blocks that start and end with the context anchors
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    // Look for the matching last line
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found a potential context block
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")

        // Check if the middle content has reasonable similarity
        // (simple heuristic: at least 50% of non-empty lines should match when trimmed)
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break // Only match the first occurrence
          }
        }
        break
      }
    }
  }
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }
  if (oldString === "") {
    throw new Error(
      "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
    )
  }

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    // Distinct spans, because a replacer may yield the same span from more than
    // one of its strategies, and because two different spans mean two different
    // places in the file matched — ambiguity the caller has to resolve.
    const spans = new Set<string>()
    for (const search of replacer(content, oldString)) {
      if (!search || !content.includes(search)) continue
      spans.add(search)
    }
    if (spans.size === 0) continue

    const matches = [...spans].map((span) => ({ span, count: content.split(span).length - 1 }))
    const total = matches.reduce((sum, match) => sum + match.count, 0)
    if (total > 1 && !replaceAll) {
      throw new Error(
        "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
      )
    }

    // A fuzzy replacer hands back a span taken from the file, which can cover
    // more than oldString described. Substituting newString into a wider span
    // rewrites lines the model never saw while still reporting success, so a
    // span that cannot be reconciled is dropped rather than applied.
    const applied = matches.flatMap((match) => {
      const next = reconcile(match.span, oldString, newString)
      return next === undefined ? [] : [{ span: match.span, next }]
    })
    if (applied.length !== matches.length) continue

    if (replaceAll) {
      return applied.reduce((result, item) => result.replaceAll(item.span, item.next), content)
    }
    const index = content.indexOf(applied[0].span)
    return content.substring(0, index) + applied[0].next + content.substring(index + applied[0].span.length)
  }

  throw new Error(
    "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
  )
}

/**
 * Text to substitute for a matched span, or undefined when the span covers more
 * than oldString accounted for and no safe narrowing exists.
 *
 * Only two shapes are reconcilable. The span is oldString exactly, or the span
 * is oldString shifted right by one uniform indent — models routinely strip
 * indentation when quoting a file back, and newString is then written against
 * the stripped form, so shifting it by the same indent reproduces exactly the
 * edit that was described. Whitespace inside a line is negotiable too, since
 * newString respecifies the whole line. Anything else (a different number of
 * lines, per-line indentation that does not shift uniformly, different code in
 * the middle of the block) is refused: there is no way to tell which part of
 * the span was meant to survive, so guessing loses code.
 */
function reconcile(search: string, oldString: string, newString: string) {
  if (search === oldString) return newString

  const searchLines = search.split("\n")
  const oldLines = oldString.split("\n")
  if (searchLines.length !== oldLines.length) return undefined

  const anchor = oldLines.findIndex((line) => line.trim().length > 0)
  if (anchor === -1) return undefined
  const base = indentation(oldLines[anchor])
  const indent = indentation(searchLines[anchor])
  if (!indent.startsWith(base)) return undefined
  const shift = indent.slice(base.length)

  const aligned = searchLines.every((line, index) => {
    if (line.trim().length === 0) return oldLines[index].trim().length === 0
    if (!line.startsWith(shift)) return false
    return collapse(line.slice(shift.length)) === collapse(oldLines[index])
  })
  if (!aligned) return undefined
  if (shift === "") return newString
  return newString
    .split("\n")
    .map((line) => (line.trim().length === 0 ? line : shift + line))
    .join("\n")
}

function indentation(line: string) {
  return /^[ \t]*/.exec(line)![0]
}

function collapse(line: string) {
  return indentation(line) + line.trim().replace(/\s+/g, " ")
}
