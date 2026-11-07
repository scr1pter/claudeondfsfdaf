// Unified diffs for reviews: parsing git and GitHub patches, anchoring findings to lines GitHub accepts comments on,
// following lines across commits, and rebuilding a file from its base. Pure and browser-safe.

import { fnv1a64 } from "./fingerprint"
import { isBinaryPath } from "./ignore"
import type { Anchor, AnchorFailure, FocusHunk, Side, Trust } from "./types"

export interface DiffLine {
  kind: "add" | "del" | "context"
  oldLine?: number
  newLine?: number
  text: string
  noNewline?: boolean // followed by "\ No newline at end of file"
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath?: string // set for renames
  status: "added" | "modified" | "deleted" | "renamed"
  binary: boolean
  hunks: DiffHunk[]
  additions: number
  deletions: number
  patch: string // the hunk text only, the same shape as GitHub's `patch`
}

// One entry of `pulls.listFiles`.
export interface GitHubPrFile {
  filename: string
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"
  additions: number
  deletions: number
  changes?: number
  patch?: string
  previous_filename?: string
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }

// Lines without their terminators. A trailing "\r" is dropped too, so CRLF diffs and CRLF file content compare equal
// to their LF forms; applyPatch puts the file's own line ending back.
function splitLines(text: string) {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
}

// Reads a path git quoted C-style, such as "src/caf\303\251.ts", from the opening quote at `start`.
function readQuoted(text: string, start: number) {
  const encoder = new TextEncoder()
  const bytes: number[] = []
  let index = start + 1
  while (index < text.length && text[index] !== '"') {
    const char = text[index]
    if (char === "\\" && index + 1 < text.length) {
      const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1))?.[0]
      if (octal) {
        bytes.push(parseInt(octal, 8) & 0xff)
        index += 1 + octal.length
        continue
      }
      const next = text[index + 1]
      if (ESCAPES[next] !== undefined) bytes.push(ESCAPES[next])
      else bytes.push(...encoder.encode(next))
      index += 2
      continue
    }
    const width = (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
    bytes.push(...encoder.encode(text.slice(index, index + width)))
    index += width
  }
  return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: index + 1 }
}

// A path from a `---`, `+++`, `rename` or `copy` line. Git ends a path containing a space with a tab, and non-git
// diffs put a timestamp after one. null is /dev/null.
function headerPath(raw: string): string | null {
  const value = raw.startsWith('"') ? readQuoted(raw, 0).value : raw.split("\t")[0]
  return value === "/dev/null" ? null : value
}

// The two paths of `diff --git a/x b/y`, prefixes included. Unquoted paths with spaces are ambiguous, so this takes
// the split where both sides name the same file; renames carry `rename from` and `rename to` lines anyway.
function gitHeaderPaths(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0)
    const tail = rest.slice(first.end).trimStart()
    return [first.value, tail.startsWith('"') ? readQuoted(tail, 0).value : tail]
  }
  const quoted = rest.indexOf(' "')
  if (quoted > 0) return [rest.slice(0, quoted), readQuoted(rest, quoted + 1).value]
  const bare = (value: string) => value.replace(/^[a-z]\//, "")
  for (let index = rest.indexOf(" "); index >= 0; index = rest.indexOf(" ", index + 1)) {
    const left = rest.slice(0, index)
    const right = rest.slice(index + 1)
    if (bare(left) === bare(right)) return [left, right]
  }
  const middle = rest.indexOf(" b/")
  return middle > 0 ? [rest.slice(0, middle), rest.slice(middle + 1)] : undefined
}

function readHunk(lines: string[], start: number): { hunk: DiffHunk; next: number } {
  const match = HUNK_HEADER.exec(lines[start])!
  const oldStart = Number(match[1])
  const oldLines = match[2] === undefined ? 1 : Number(match[2])
  const newStart = Number(match[3])
  const newLines = match[4] === undefined ? 1 : Number(match[4])
  const out: DiffLine[] = []
  let oldLeft = oldLines
  let newLeft = newLines
  let oldLine = oldStart
  let newLine = newStart
  let index = start + 1
  // Counting lines rather than reading until the next header keeps a removed line such as "-- comment", which shows
  // up as "--- comment", inside its hunk.
  while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const line = lines[index]
    if (line.startsWith("\\")) {
      if (out.length) out[out.length - 1].noNewline = true
    } else if (line.startsWith("+")) {
      if (newLeft === 0) break
      out.push({ kind: "add", newLine: newLine++, text: line.slice(1) })
      newLeft--
    } else if (line.startsWith("-")) {
      if (oldLeft === 0) break
      out.push({ kind: "del", oldLine: oldLine++, text: line.slice(1) })
      oldLeft--
    } else if (line.startsWith(" ") || line === "") {
      // An empty line is a context line whose leading space an editor or a copy trimmed.
      if (oldLeft === 0 || newLeft === 0) break
      out.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) })
      oldLeft--
      newLeft--
    } else break
    index++
  }
  while (index < lines.length && lines[index].startsWith("\\")) {
    if (out.length) out[out.length - 1].noNewline = true
    index++
  }
  return { hunk: { header: lines[start], oldStart, oldLines, newStart, newLines, lines: out }, next: index }
}

interface Pending {
  git?: [string, string]
  prefixes: [string, string]
  minus?: string | null
  plus?: string | null
  renameFrom?: string
  renameTo?: string
  copyFrom?: string
  copyTo?: string
  binaryPaths?: [string, string]
  created: boolean
  removed: boolean
  binary: boolean
  hunks: DiffHunk[]
  patch: string[]
}

function pending(): Pending {
  return { prefixes: ["", ""], created: false, removed: false, binary: false, hunks: [], patch: [] }
}

function startGitFile(line: string): Pending {
  const file = pending()
  const paths = gitHeaderPaths(line.replace(/^diff --(?:git|vector) /, ""))
  if (!paths) return file
  // Git's prefixes always differ (a/ and b/, or i/ and w/ with diff.mnemonicPrefix); equal ones mean --no-prefix.
  const left = /^[a-z]\//.exec(paths[0])?.[0]
  const right = /^[a-z]\//.exec(paths[1])?.[0]
  if (left && right && left !== right) file.prefixes = [left, right]
  file.git = [paths[0].slice(file.prefixes[0].length), paths[1].slice(file.prefixes[1].length)]
  return file
}

function finishFile(file: Pending): DiffFile {
  const strip = (value: string | null | undefined, prefix: string) =>
    value && prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value
  const minus = strip(file.minus, file.prefixes[0])
  const plus = strip(file.plus, file.prefixes[1])
  const binaryOld = file.binaryPaths && strip(headerPath(file.binaryPaths[0]), file.prefixes[0])
  const binaryNew = file.binaryPaths && strip(headerPath(file.binaryPaths[1]), file.prefixes[1])
  const oldName = file.renameFrom ?? file.copyFrom ?? minus ?? file.git?.[0] ?? binaryOld ?? undefined
  const newName = file.renameTo ?? file.copyTo ?? plus ?? file.git?.[1] ?? binaryNew ?? undefined
  const created = file.created || minus === null || binaryOld === null || file.copyTo !== undefined
  const removed = !created && (file.removed || plus === null || binaryNew === null)
  const renamed = !created && !removed && !!oldName && !!newName && oldName !== newName
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks)
    for (const line of hunk.lines) {
      if (line.kind === "add") additions++
      if (line.kind === "del") deletions++
    }
  return {
    path: (removed ? oldName : newName) ?? oldName ?? "",
    ...(renamed ? { oldPath: oldName } : {}),
    status: created ? "added" : removed ? "deleted" : renamed ? "renamed" : "modified",
    binary: file.binary,
    hunks: file.hunks,
    additions,
    deletions,
    patch: file.patch.join("\n"),
  }
}

// Parses `git diff` output, a plain unified diff, or the hunks of one file on their own (GitHub's `patch`, which
// comes back as a single file with an empty path).
export function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = splitLines(text)
  const files: DiffFile[] = []
  let current: Pending | undefined
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.startsWith("diff --git ") || line.startsWith("diff --vector ")) {
      if (current) files.push(finishFile(current))
      current = startGitFile(line)
      index++
      continue
    }
    if (HUNK_HEADER.test(line)) {
      current ??= pending()
      const read = readHunk(lines, index)
      current.hunks.push(read.hunk)
      current.patch.push(...lines.slice(index, read.next))
      index = read.next
      continue
    }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      // Without `diff --git` lines, a `---` after hunks starts the next file.
      if (!current || current.hunks.length > 0 || current.minus !== undefined) {
        if (current) files.push(finishFile(current))
        current = pending()
      }
      current.minus = headerPath(line.slice(4))
      current.plus = headerPath(lines[index + 1].slice(4))
      if (!current.git && current.minus?.startsWith("a/") && current.plus?.startsWith("b/"))
        current.prefixes = ["a/", "b/"]
      index += 2
      continue
    }
    index++
    if (!current) continue
    if (line.startsWith("new file mode")) current.created = true
    else if (line.startsWith("deleted file mode")) current.removed = true
    else if (line.startsWith("rename from ")) current.renameFrom = headerPath(line.slice(12)) ?? undefined
    else if (line.startsWith("rename to ")) current.renameTo = headerPath(line.slice(10)) ?? undefined
    else if (line.startsWith("rename old ")) current.renameFrom = headerPath(line.slice(11)) ?? undefined
    else if (line.startsWith("rename new ")) current.renameTo = headerPath(line.slice(11)) ?? undefined
    else if (line.startsWith("copy from ")) current.copyFrom = headerPath(line.slice(10)) ?? undefined
    else if (line.startsWith("copy to ")) current.copyTo = headerPath(line.slice(8)) ?? undefined
    else if (line === "GIT binary patch") current.binary = true
    else if (line.startsWith("Binary files ")) {
      current.binary = true
      const match = /^Binary files (.+) and (.+) differ$/.exec(line)
      if (match) current.binaryPaths = [match[1], match[2]]
    }
  }
  if (current) files.push(finishFile(current))
  return files
}

export function fromGitHubFiles(files: GitHubPrFile[]): DiffFile[] {
  return files.map((file) => {
    const patch = file.patch ?? ""
    const status: DiffFile["status"] =
      file.status === "removed"
        ? "deleted"
        : file.status === "added" || file.status === "copied"
          ? "added"
          : file.status === "renamed"
            ? "renamed"
            : "modified"
    return {
      path: file.filename,
      ...(status === "renamed" && file.previous_filename ? { oldPath: file.previous_filename } : {}),
      status,
      binary: (!patch && isBinaryPath(file.filename)) || /^Binary files /m.test(patch),
      hunks: patch ? (parseUnifiedDiff(patch)[0]?.hunks ?? []) : [],
      additions: file.additions,
      deletions: file.deletions,
      patch,
    }
  })
}

export interface AnchorEntry {
  file: DiffFile
  right: Map<number, number> // head line of an added or context line → hunk index
  left: Map<number, number> // base line of a deleted line → hunk index
}

export interface AnchorIndex {
  files: Map<string, AnchorEntry>
}

export function buildAnchorIndex(files: DiffFile[]): AnchorIndex {
  const index = new Map<string, AnchorEntry>()
  for (const file of files) {
    const entry: AnchorEntry = { file, right: new Map(), left: new Map() }
    file.hunks.forEach((hunk, position) => {
      for (const line of hunk.lines) {
        if (line.kind === "del") entry.left.set(line.oldLine!, position)
        else entry.right.set(line.newLine!, position)
      }
    })
    index.set(file.path, entry)
  }
  // A finding may name a renamed file by its old path; GitHub only takes the new one.
  for (const entry of [...index.values()])
    if (entry.file.oldPath && !index.has(entry.file.oldPath)) index.set(entry.file.oldPath, entry)
  return { files: index }
}

// The diff entry for a path as a model writes it: "./src/x.ts", "b/src/x.ts" or a full checkout path all find
// "src/x.ts".
export function lookupFile(ix: AnchorIndex, path: string): AnchorEntry | undefined {
  const direct = ix.files.get(path)
  if (direct) return direct
  const clean = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
  const candidates = [clean, clean.replace(/^\/+/, ""), clean.replace(/^[ab]\//, "")]
  for (const candidate of candidates) {
    const found = ix.files.get(candidate)
    if (found) return found
  }
  // The longest path the full one ends with wins, so "/w/src/x.ts" finds "src/x.ts" even when "x.ts" changed too.
  return [...new Set(ix.files.values())]
    .filter((entry) => clean.endsWith("/" + entry.file.path))
    .reduce<
      AnchorEntry | undefined
    >((best, entry) => (!best || entry.file.path.length > best.file.path.length ? entry : best), undefined)
}

// A line a model named just outside a hunk (up to 3 lines) moves onto the hunk's nearest added line.
function snap(entry: AnchorEntry, line: number): { line: number; hunk: number } | undefined {
  let best: { line: number; hunk: number; gap: number; shift: number } | undefined
  entry.file.hunks.forEach((hunk, position) => {
    const right = hunk.lines.filter((item) => item.kind !== "del")
    if (!right.length) return
    const first = right[0].newLine!
    const last = right[right.length - 1].newLine!
    const gap = line < first ? first - line : line > last ? line - last : 0
    if (gap === 0 || gap > 3) return
    const added = right.filter((item) => item.kind === "add")
    const pool = added.length ? added : right
    const target = pool.reduce((a, b) => (Math.abs(b.newLine! - line) < Math.abs(a.newLine! - line) ? b : a))
    const shift = Math.abs(target.newLine! - line)
    if (!best || gap < best.gap || (gap === best.gap && shift < best.shift))
      best = { line: target.newLine!, hunk: position, gap, shift }
  })
  return best && { line: best.line, hunk: best.hunk }
}

export function resolveAnchor(
  ix: AnchorIndex,
  f: { path: string; line: number; endLine?: number; side?: Side },
): { ok: true; anchor: Anchor } | { ok: false; reason: AnchorFailure } {
  const entry = lookupFile(ix, f.path)
  if (!entry) return { ok: false, reason: "file-not-in-diff" }
  if (entry.file.binary || entry.file.hunks.length === 0) return { ok: false, reason: "no-patch" }
  if (!Number.isInteger(f.line) || f.line < 1) return { ok: false, reason: "line-outside-diff" }
  const side = f.side ?? "RIGHT"
  const lines = side === "RIGHT" ? entry.right : entry.left
  const path = entry.file.path
  const end = f.endLine !== undefined && Number.isInteger(f.endLine) && f.endLine > f.line ? f.endLine : undefined
  if (end !== undefined) {
    const first = lines.get(f.line)
    const last = lines.get(end)
    if (first !== undefined && first === last)
      return { ok: true, anchor: { path, side, line: end, startLine: f.line, hunk: first } }
    if (last !== undefined) return { ok: true, anchor: { path, side, line: end, hunk: last } }
  }
  const hunk = lines.get(f.line)
  if (hunk !== undefined) return { ok: true, anchor: { path, side, line: f.line, hunk } }
  const snapped = side === "RIGHT" ? snap(entry, f.line) : undefined
  if (snapped) return { ok: true, anchor: { path, side, line: snapped.line, hunk: snapped.hunk } }
  return { ok: false, reason: "line-outside-diff" }
}

// The code the anchor covers, on its own side.
export function anchorText(ix: AnchorIndex, a: Anchor): string {
  const hunk = lookupFile(ix, a.path)?.file.hunks[a.hunk]
  if (!hunk) return ""
  const start = a.startLine ?? a.line
  return hunk.lines
    .filter((line) =>
      a.side === "RIGHT"
        ? line.kind !== "del" && line.newLine! >= start && line.newLine! <= a.line
        : line.kind === "del" && line.oldLine! >= start && line.oldLine! <= a.line,
    )
    .map((line) => line.text)
    .join("\n")
}

function indentStyle(line: string) {
  return line.startsWith("\t") ? "tab" : line.startsWith(" ") ? "space" : "none"
}

// Whether a suggestion can be a committable ```suggestion block. Otherwise it is shown as a ```diff block. `range` is
// the model's own line..endLine: the anchor must be exactly those lines, because a range collapsed to its end or a
// line snapped onto a nearby added line would commit the fix over other code.
export function suggestionAllowed(
  ix: AnchorIndex,
  a: Anchor,
  suggestion: string,
  opts: { trust?: Trust; verified?: boolean; range?: { line: number; endLine?: number } } = {},
): boolean {
  if (a.side !== "RIGHT") return false
  if (opts.trust === "untrusted" && !opts.verified) return false
  const range = opts.range
  if (range && ((a.startLine ?? a.line) !== range.line || a.line !== (range.endLine ?? range.line))) return false
  const entry = lookupFile(ix, a.path)
  if (!entry || entry.file.status === "deleted" || entry.file.binary) return false
  if (!entry.file.hunks[a.hunk]) return false
  for (let line = a.startLine ?? a.line; line <= a.line; line++) if (entry.right.get(line) !== a.hunk) return false
  const replacement = suggestion.replace(/\r\n/g, "\n").replace(/\n$/, "")
  if (replacement.trim() === "") return false
  const lines = replacement.split("\n")
  if (lines.length > 40) return false
  const current = anchorText(ix, a)
  if (replacement === current) return false
  if (indentStyle(lines[0]) !== indentStyle(current.split("\n")[0])) return false
  return !repeatsNeighbours(entry.file.hunks[a.hunk]!, a, lines)
}

// A fix whose last lines are the lines just after its range, or whose first lines are the lines just before it,
// would leave those lines twice once committed. Lines with no letters or digits (a closing brace) do not count.
function repeatsNeighbours(hunk: DiffHunk, a: Anchor, lines: string[]): boolean {
  const right = hunk.lines.filter((line) => line.kind !== "del")
  const start = a.startLine ?? a.line
  const before = right.filter((line) => line.newLine! < start).map((line) => line.text)
  const after = right.filter((line) => line.newLine! > a.line).map((line) => line.text)
  const same = (left: string[], right: string[]) =>
    left.every((text, index) => text.trim() === right[index]?.trim()) && left.some((text) => /[A-Za-z0-9]/.test(text))
  for (let count = Math.min(lines.length, after.length); count >= 1; count--)
    if (same(lines.slice(-count), after.slice(0, count))) return true
  for (let count = Math.min(lines.length, before.length); count >= 1; count--)
    if (same(lines.slice(0, count), before.slice(before.length - count))) return true
  return false
}

function findChanged(changes: DiffFile[], path: string) {
  return changes.find((file) => (file.oldPath ?? file.path) === path) ?? changes.find((file) => file.path === path)
}

// Where a line of the old version is in the new one, through the diff between them.
export function mapLine(changes: DiffFile[], path: string, oldLine: number): number | "deleted" {
  const file = findChanged(changes, path)
  if (!file) return oldLine
  if (file.status === "deleted") return "deleted"
  let offset = 0
  for (const hunk of file.hunks) {
    // A side with no lines names the line before the change, so its first line is start + 1.
    const oldFirst = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart
    const oldNext = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart + hunk.oldLines
    if (oldLine < oldFirst) break
    if (oldLine < oldNext) {
      const line = hunk.lines.find((item) => item.kind !== "add" && item.oldLine === oldLine)
      return !line || line.kind === "del" ? "deleted" : line.newLine!
    }
    const newNext = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart + hunk.newLines
    offset = newNext - oldNext
  }
  return oldLine + offset
}

// Whether the diff changed anything within `radius` lines of `line`, a line of the new version. A deletion sits
// between two new lines and counts for both.
export function touched(changes: DiffFile[], path: string, line: number, radius = 5): boolean {
  const file = changes.find((item) => item.path === path)
  if (!file) return false
  if (file.status === "deleted" || file.status === "added") return true
  for (const hunk of file.hunks) {
    let next = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart
    for (const item of hunk.lines) {
      if (item.kind === "del") {
        if (line >= next - 1 - radius && line <= next + radius) return true
        continue
      }
      if (item.kind === "add" && Math.abs(item.newLine! - line) <= radius) return true
      next = item.newLine! + 1
    }
  }
  return false
}

// Like `git patch-id`: the same change at other line numbers, or re-indented, keeps its id.
export function patchIdOf(file: DiffFile): string {
  const parts: string[] = []
  for (const hunk of file.hunks)
    for (const line of hunk.lines)
      if (line.kind !== "context") parts.push((line.kind === "add" ? "+" : "-") + line.text.replace(/\s+/g, ""))
  if (file.binary) parts.push("binary")
  return fnv1a64(parts.join("\n"))
}

function textLines(text: string) {
  const lines = splitLines(text)
  return { lines, endsWithNewline: text.endsWith("\n") }
}

// Rebuilds the new version of a file from its old text. undefined when any context or removed line differs, so a
// file that is not at the diff's base is never rebuilt wrong.
export function applyPatch(baseText: string, file: DiffFile): string | undefined {
  if (file.binary) return undefined
  const eol = baseText.includes("\r\n") ? "\r\n" : "\n"
  const base = textLines(baseText)
  if (file.status === "added" && base.lines.length > 0) return undefined
  const out: string[] = []
  let cursor = 0
  let last: DiffLine | undefined
  for (const hunk of file.hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    if (start < cursor || start > base.lines.length) return undefined
    while (cursor < start) out.push(base.lines[cursor++])
    for (const line of hunk.lines) {
      if (line.kind !== "add") {
        if (base.lines[cursor] !== line.text) return undefined
        cursor++
      }
      if (line.kind !== "del") {
        out.push(line.text)
        last = line
      }
    }
  }
  if (file.status === "deleted") return cursor === base.lines.length ? "" : undefined
  const tail = cursor < base.lines.length
  while (cursor < base.lines.length) out.push(base.lines[cursor++])
  if (!out.length) return ""
  const endsWithNewline = tail ? base.endsWithNewline : !last?.noNewline
  return out.join(eol) + (endsWithNewline ? eol : "")
}

// Why a model's fix patch is not posted as a patch (S6). "malformed": not one well-formed unified diff, a line outside
// its hunks, or a hunk whose header counts or new start do not match its lines; "several-files" and "other-file": it
// does not change the finding's own file in place; "hunks": more hunks than allowed; "context": a context or removed
// line differs from head at the exact position its header names; "unchanged": applied, it changes nothing.
export type FixPatchFailure = "malformed" | "several-files" | "other-file" | "hunks" | "context" | "unchanged"

// The lines a fix patch may carry before its first hunk: git's header lines that name the file or say it was created,
// deleted, copied or renamed, so those reach the other-file check. A mode change is not a text fix: it is malformed.
const FIX_PREAMBLE =
  /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/

// Applies a model's fix patch to the head text of the finding's file (VS-27b, S6), at the exact positions its hunk
// headers name, with no offset or fuzz. The patch's own file headers never choose the file (I-8): only bare hunks, or
// headers naming `options.path` as a file modified in place, are taken. Every line from the first hunk on must belong
// to a hunk, and every hunk must fill its header's counts, so text that passes is a patch `git apply` reads as it was
// checked. Pure and browser-safe; no runner calls it before VS-27c.
export function applyFixPatch(
  headText: string,
  patch: string,
  options: { path: string; maxHunks: number },
): { ok: true; text: string; hunks: number } | { ok: false; reason: FixPatchFailure } {
  const files = parseUnifiedDiff(patch)
  if (files.length > 1) return { ok: false, reason: "several-files" }
  const file = files[0]
  if (!file || file.binary || !file.hunks.length) return { ok: false, reason: "malformed" }
  const lines = splitLines(patch)
  const first = lines.findIndex((line) => HUNK_HEADER.test(line))
  const preamble = lines.slice(0, first)
  const body = file.patch.split("\n")
  const rest = lines.slice(first)
  if (
    !preamble.every((line, index) => FIX_PREAMBLE.test(line) && pairedHeader(preamble, index)) ||
    body.some((line, index) => rest[index] !== line) ||
    rest.slice(body.length).some((line) => line !== "") ||
    !wellCounted(file.hunks)
  )
    return { ok: false, reason: "malformed" }
  if ((file.path !== "" && file.path !== options.path) || file.status !== "modified")
    return { ok: false, reason: "other-file" }
  if (file.hunks.length > options.maxHunks) return { ok: false, reason: "hunks" }
  const text = applyPatch(headText, file)
  if (text === undefined) return { ok: false, reason: "context" }
  if (text === headText) return { ok: false, reason: "unchanged" }
  return { ok: true, text, hunks: file.hunks.length }
}

// A `---` line is read as a file header only with a `+++` line after it, so a lone one could name a file the parser
// never saw: each must come in a pair.
function pairedHeader(preamble: readonly string[], index: number) {
  const line = preamble[index]
  if (line.startsWith("--- ")) return index + 1 < preamble.length && preamble[index + 1].startsWith("+++ ")
  if (line.startsWith("+++ ")) return index > 0 && preamble[index - 1].startsWith("--- ")
  return true
}

// Each hunk's lines fill its header's counts exactly, and its new start follows from its old start and the hunks before
// it. readHunk stops quietly at the end of the text, so a header that promises more lines than follow would otherwise
// read as a shorter hunk.
function wellCounted(hunks: readonly DiffHunk[]) {
  return hunks.every((hunk, index) => {
    const before = hunks.slice(0, index).reduce((total, item) => total + item.newLines - item.oldLines, 0)
    const old = hunk.lines.filter((line) => line.kind !== "add").length
    const fresh = hunk.lines.filter((line) => line.kind !== "del").length
    const oldFirst = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart
    const newFirst = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart
    return old === hunk.oldLines && fresh === hunk.newLines && old + fresh > 0 && newFirst === oldFirst + before
  })
}

// Whether `text` already is the new version at every hunk, so a checkout can be reviewed in place.
export function matchPostImage(text: string, file: DiffFile): boolean {
  if (file.binary) return false
  const lines = textLines(text).lines
  if (file.status === "deleted") return lines.length === 0
  let count = 0
  for (const hunk of file.hunks)
    for (const line of hunk.lines) {
      if (line.kind === "del") continue
      if (lines[line.newLine! - 1] !== line.text) return false
      count++
    }
  return file.status !== "added" || lines.length === count
}

// The head version of a file with its line numbers, the lines the change added marked "+", and the removed lines
// shown as "-" where they were, with their base line number, so a finding on removed code can anchor to the LEFT side
// although the diff is not sent. It holds what the file's diff and its full head text hold, once, so
// a prompt can show it in place of both. In a file longer than `foldAbove` lines, only `context` lines around each
// change are kept, and each run left out becomes one "⋯" line with its head and base line numbers. undefined when
// `headText` is not the diff's post-image.
export function renderAnnotated(
  file: DiffFile,
  headText: string,
  options: { context?: number; foldAbove?: number } = {},
): string | undefined {
  if (file.binary || file.status === "deleted" || !matchPostImage(headText, file)) return undefined
  const head = splitLines(headText)
  const context = options.context ?? ANNOTATED_CONTEXT
  const fold = head.length > (options.foldAbove ?? ANNOTATED_FOLD_ABOVE)
  const added = new Set<number>()
  // The head line each run of removed lines sits before, and their base line numbers and text.
  const removed = new Map<number, { line: number; text: string }[]>()
  for (const hunk of file.hunks) {
    let next = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart
    for (const line of hunk.lines) {
      if (line.kind === "del")
        removed.set(next, [...(removed.get(next) ?? []), { line: line.oldLine!, text: line.text }])
      else {
        if (line.kind === "add") added.add(line.newLine!)
        next = line.newLine! + 1
      }
    }
  }
  const changed = [...added, ...[...removed.keys()].flatMap((line) => [line - 1, line])]
  const near = (line: number) => changed.some((at) => Math.abs(at - line) <= context)
  // A fold line costs about as much as a few code lines, so a short run is shown rather than folded.
  const hidden = head.map((_, index) => fold && !added.has(index + 1) && !near(index + 1))
  for (const run of runs(hidden)) if (run.end - run.start < MIN_FOLD) hidden.fill(false, run.start, run.end)
  const width = String(head.length).length
  const row = (number: string, mark: string, text: string) =>
    text ? `${number.padStart(width)} ${mark} ${text}` : `${number.padStart(width)} ${mark}`.trimEnd()
  const span = (from: number, to: number) => (from === to ? `line ${from}` : `lines ${from}-${to}`)
  const out: string[] = []
  const counts = { added: 0, removed: 0 }
  for (const line of Array.from({ length: head.length + 1 }, (_, index) => index + 1)) {
    for (const gone of removed.get(line) ?? []) {
      out.push(row(String(gone.line), "-", gone.text))
      counts.removed++
    }
    if (line > head.length) break
    if (hidden[line - 1]) {
      // The first line of a folded run writes the fold for the whole run.
      if (hidden[line - 2]) continue
      const last = line + hidden.slice(line - 1).findIndex((value) => !value) - 1
      const end = last < line ? head.length : last
      const base = line - counts.added + counts.removed
      out.push(`⋯ ${span(line, end)} unchanged (base ${span(base, base + end - line)})`)
      continue
    }
    out.push(row(String(line), added.has(line) ? "+" : " ", head[line - 1]))
    if (added.has(line)) counts.added++
  }
  return out.join("\n")
}

// Runs of true values, as [start, end) indexes.
function runs(values: boolean[]) {
  return values.reduce<{ start: number; end: number }[]>((out, value, index) => {
    if (!value) return out
    const last = out.at(-1)
    if (last && last.end === index) last.end = index + 1
    else out.push({ start: index, end: index + 1 })
    return out
  }, [])
}

const MIN_FOLD = 4
const ANNOTATED_CONTEXT = 20
const ANNOTATED_FOLD_ABOVE = 200

// Head line ranges of each hunk's new side. A hunk that only deletes sits between newStart and newStart + 1.
function hunkSpan(hunk: DiffHunk): [number, number] {
  if (hunk.newLines === 0) return [Math.max(1, hunk.newStart), hunk.newStart + 1]
  return [hunk.newStart, hunk.newStart + hunk.newLines - 1]
}

// What a diff changed, as head line ranges: each added line, and each deletion as the two lines around it.
function changedSpans(file: DiffFile): [number, number][] {
  const spans: [number, number][] = []
  for (const hunk of file.hunks) {
    let next = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart
    for (const line of hunk.lines) {
      if (line.kind === "del") spans.push([Math.max(1, next - 1), next])
      else {
        if (line.kind === "add") spans.push([line.newLine!, line.newLine!])
        next = line.newLine! + 1
      }
    }
  }
  return spans
}

// Merges overlapping or touching ranges per file, sorted by path and line.
export function mergeFocus(...lists: FocusHunk[][]): FocusHunk[] {
  const sorted = lists.flat().toSorted((a, b) => a.path.localeCompare(b.path) || a.start - b.start)
  const out: FocusHunk[] = []
  for (const item of sorted) {
    const previous = out.at(-1)
    if (previous && previous.path === item.path && item.start <= previous.end + 1)
      previous.end = Math.max(previous.end, item.end)
    else out.push({ ...item })
  }
  return out
}

// Every hunk of the named files, padded by 3 lines: the focus for files a partial run left or a force-push changed.
export function focusOfFiles(pr: DiffFile[], paths: string[]): FocusHunk[] {
  const wanted = new Set(paths)
  return mergeFocus(
    pr
      .filter((file) => wanted.has(file.path) && file.status !== "deleted")
      .flatMap((file) =>
        file.hunks.map((hunk) => {
          const [start, end] = hunkSpan(hunk)
          return { path: file.path, start: Math.max(1, start - 3), end: end + 3 }
        }),
      ),
  )
}

// The hunks of the pull request's own diff (merge-base → head) that the new commits (since → head) changed, padded by
// 3 lines. Changes a merge brought in from the base branch are not in the pull request's diff, so they add nothing.
export function focusHunks(pr: DiffFile[], sinceToHead: DiffFile[]): FocusHunk[] {
  const changed = new Map<string, [number, number][]>()
  for (const file of sinceToHead) if (file.status !== "deleted") changed.set(file.path, changedSpans(file))
  const out: FocusHunk[] = []
  for (const file of pr) {
    const spans = changed.get(file.path)
    if (!spans?.length || file.status === "deleted") continue
    for (const hunk of file.hunks) {
      const [start, end] = hunkSpan(hunk)
      if (spans.some(([from, to]) => from <= end && start <= to))
        out.push({ path: file.path, start: Math.max(1, start - 3), end: end + 3 })
    }
  }
  return mergeFocus(out)
}

// Fits whole files into `maxChars` of rendered diff, in order; the rest are listed for the reviewer to open.
export function budgetDiff(files: DiffFile[], maxChars: number): { inline: DiffFile[]; notInlined: DiffFile[] } {
  const inline: DiffFile[] = []
  const notInlined: DiffFile[] = []
  let used = 0
  for (const file of files) {
    const size = renderPatch([file]).length + 1
    if (used + size <= maxChars) {
      inline.push(file)
      used += size
    } else notInlined.push(file)
  }
  return { inline, notInlined }
}

function toHunk(lines: DiffLine[], oldFirst: number, newFirst: number, section: string): DiffHunk {
  const oldLines = lines.filter((line) => line.kind !== "add").length
  const newLines = lines.filter((line) => line.kind !== "del").length
  const oldStart = oldLines === 0 ? oldFirst - 1 : oldFirst
  const newStart = newLines === 0 ? newFirst - 1 : newFirst
  const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${section ? " " + section : ""}`
  return { header, oldStart, oldLines, newStart, newLines, lines }
}

// Keeps at most `keep` context lines around each change, splitting a hunk where a longer run of context is dropped.
function trimContext(hunk: DiffHunk, keep: number): DiffHunk[] {
  const distance = hunk.lines.map(() => Infinity)
  let seen = -Infinity
  hunk.lines.forEach((line, index) => {
    if (line.kind !== "context") seen = index
    distance[index] = index - seen
  })
  seen = Infinity
  for (let index = hunk.lines.length - 1; index >= 0; index--) {
    if (hunk.lines[index].kind !== "context") seen = index
    distance[index] = Math.min(distance[index], seen - index)
  }
  const kept = distance.map((value) => value <= keep)
  if (kept.every(Boolean)) return [hunk]
  const section = hunk.header.replace(HUNK_HEADER, "").trim()
  const pieces: DiffHunk[] = []
  let oldNext = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart
  let newNext = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart
  let piece: { lines: DiffLine[]; oldFirst: number; newFirst: number } | undefined
  hunk.lines.forEach((line, index) => {
    if (kept[index]) {
      piece ??= { lines: [], oldFirst: oldNext, newFirst: newNext }
      piece.lines.push(line)
    } else if (piece) {
      pieces.push(toHunk(piece.lines, piece.oldFirst, piece.newFirst, pieces.length ? "" : section))
      piece = undefined
    }
    if (line.kind !== "add") oldNext++
    if (line.kind !== "del") newNext++
  })
  if (piece) pieces.push(toHunk(piece.lines, piece.oldFirst, piece.newFirst, pieces.length ? "" : section))
  return pieces
}

function renderFile(file: DiffFile, contextLines?: number) {
  const before = file.oldPath ?? file.path
  const out = [`diff --git a/${before} b/${file.path}`]
  if (file.status === "renamed" && file.oldPath) out.push(`rename from ${file.oldPath}`, `rename to ${file.path}`)
  const minus = file.status === "added" ? "/dev/null" : `a/${before}`
  const plus = file.status === "deleted" ? "/dev/null" : `b/${file.path}`
  if (file.binary) {
    out.push(`Binary files ${minus} and ${plus} differ`)
    return out.join("\n")
  }
  if (!file.hunks.length) return out.join("\n")
  out.push(`--- ${minus}`, `+++ ${plus}`)
  const hunks = contextLines === undefined ? file.hunks : file.hunks.flatMap((hunk) => trimContext(hunk, contextLines))
  for (const hunk of hunks) {
    out.push(hunk.header)
    for (const line of hunk.lines) {
      out.push((line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + line.text)
      if (line.noNewline) out.push("\\ No newline at end of file")
    }
  }
  return out.join("\n")
}

// A unified diff for a prompt, optionally with fewer context lines than the source diff had.
export function renderPatch(files: DiffFile[], contextLines?: number): string {
  return files.map((file) => renderFile(file, contextLines)).join("\n")
}
