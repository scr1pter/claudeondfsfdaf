// What of a change is held back from the model (VectorScope addendum A, VS-34, Now window). A changed file whose new or
// old path names key material or credentials is held back whole: the read tool's secret and env patterns and the
// payload-only list of credential files (permission.ts), and so is a head file whose own path is one. Every
// other changed file, and its head file, has the values a secret's own shape gives away replaced with `[redacted]` in
// place (BrainScan read for shapes), so line numbers, hunks and anchors still line up. A gitignored file that was
// committed is listed, never dropped.
//
// `reading` is the BrainScan reading values are redacted with, for shapes unless given. Nothing passes one and no key
// sets it: it lets the measurement window compare the generic reading (`{ code: true }`) with the shapes tier through
// this same function before runner-wiring adopts a tier. A reading that does not keep a text's lines (the generic one
// replaces a key whole) has each line read on its own.
//
// holdbackContext does the same for the other untrusted blocks a prompt quotes (design item 3): the pull request's
// title, body and commit subjects, related-code hits, history, human comments, requirements, CI log excerpts and the
// earlier findings the review prompt lists as open. What quotes a held path, or a path holdback would hold, is dropped,
// and every other text has its values redacted.
//
// Pure: no function here reads process.env (`env` defaults to none) or makes a git call (the collector computes
// `ignored`). Their imports are browser-safe, and `Wildcard.match` reads `process.platform` only where there is a
// `process`, so the desktop renderer runs them too (SF-15). Review.run calls holdbackFiles and holdbackContext before
// prompt building under `holdback: "secrets"` (SF-13b), and so does the desktop runner (ai-review.ts, SF-15, with no
// gitignore check); only prompt rendering (the diff, the head files and the context blocks) may use what they return:
// skips, review state, anchors, suggestions and patch IDs keep the files as they are.
//
// holdbackText and holdbackLines are the tool half (SF-14): the engine's read, grep and glob tools redact what they
// return with them, in the same reading, only in a review session whose permission rules hold back (permission.ts
// holdsBack). Those rules decide what the read tool may open (they deny the credential files and the held paths);
// grep also reads heldReason, to withhold every line of a path this module holds back whatever the rules say.

import { BrainScan } from "../brain/scan"
import { Wildcard } from "../util/wildcard"
import type { RulePart } from "./config"
import { matchPostImage, parseUnifiedDiff, type DiffFile, type DiffHunk, type DiffLine } from "./diff"
import { isCodePath } from "./ignore"
import { CREDENTIAL_FILES, ENV_FILES, SECRET_FILES } from "./permission"
import type { HeadFile, PromptInput } from "./prompt"
import { REDACTED } from "./redact"
import type { HeldFile, HoldbackReason, ReviewConfig } from "./types"

// The `[redacted]` placeholders holdback added to one path: in its diff (hunk headers and lines) and in its head file.
export interface HoldbackRedaction {
  path: string
  diff: number
  head: number
}

export interface HoldbackResult {
  files: DiffFile[] // the files sent, in input order, their hunks and patch redacted
  headFiles?: HeadFile[] // present when the input had head files: those of held files or held paths dropped
  held: HeldFile[] // in input order
  redactions: HoldbackRedaction[] // paths given a placeholder, in the order of the files, then of other head files
  ignoredCommitted: string[] // changed paths in `ignored` that the change does not delete, in file order, held or not
}

// The read tool's env patterns (ENV_FILES) are held but for templates, by their final suffix (`.env.local.example` is
// one, `.env.example.bak` is not), and for a source file such as `config.env.ts`, which reads env rather than holds
// it. A dotfile `.env.*` is held whatever follows (`.env.ts` too), and so is a shell or SQL script, which sets values
// (`deploy/prod.env.sh` exports a password) although isCodePath counts it as source.
const ENV_TEMPLATES = ["*.example", "*.sample", "*.template", "*.dist", "*.defaults"]
const ENV_DOTFILES = [".env.*", "*/.env.*"]
const ENV_SCRIPTS = ["*.sh", "*.bash", "*.zsh", "*.ps1", "*.sql"]

const SHAPES = { shapes: true } as const

// A text with its values redacted.
type Read = (text: string) => string

// The untrusted blocks holdbackContext reads. `impact` is not one: no runner sets it before VS-25b wiring, which
// builds the slice from the files holdback sends and redacts it. `prior` is: an earlier finding's title is a model's
// text from an earlier review, which may have been made without holdback and quote a value.
export type HoldbackContext = Pick<
  PromptInput,
  "pr" | "related" | "history" | "humanComments" | "requirements" | "checks" | "prior"
>

export function holdbackFiles(
  files: readonly DiffFile[],
  input: {
    headFiles?: readonly HeadFile[]
    ignored: readonly string[]
    env?: Record<string, string | undefined>
    reading?: BrainScan.Reading
  },
): HoldbackResult {
  const read = reader(input)
  const held = files.flatMap((file): HeldFile[] => {
    const reason = heldReason(file.path) ?? (file.oldPath ? heldReason(file.oldPath) : undefined)
    if (!reason) return []
    return [{ path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), status: file.status, reason }]
  })
  const withheld = new Set(held.map((file) => file.path))
  const heads = input.headFiles?.filter((head) => !withheld.has(head.path) && !heldReason(head.path))
  const headOf = new Map(heads?.map((head) => [head.path, head]))
  const sent = files
    .filter((file) => !withheld.has(file.path))
    .map((file) => {
      const head = headOf.get(file.path)
      const out = redactPath(file, head, read)
      return {
        before: file,
        file: { ...file, hunks: out.hunks, patch: rewriteDiff(file.patch, file.hunks, out.hunks, read) },
        head: head && { before: head, text: out.headText ?? head.text },
      }
    })
  const paired = new Map(sent.flatMap((change) => (change.head ? [[change.head.before, change.head.text]] : [])))
  const headPairs = heads?.map((head) => {
    const text = paired.get(head) ?? redactPath(undefined, head, read).headText ?? head.text
    return { before: head, head: { ...head, text } }
  })
  const counts = [
    ...sent.map((change) => ({
      path: change.file.path,
      diff: added(diffTexts(change.before), diffTexts(change.file)),
      head: 0,
    })),
    ...(headPairs ?? []).map((pair) => ({
      path: pair.head.path,
      diff: 0,
      head: added([pair.before.text], [pair.head.text]),
    })),
  ].reduce((paths, row) => {
    const seen = paths.get(row.path)
    return paths.set(row.path, {
      path: row.path,
      diff: (seen?.diff ?? 0) + row.diff,
      head: (seen?.head ?? 0) + row.head,
    })
  }, new Map<string, HoldbackRedaction>())
  const ignored = new Set(input.ignored)
  return {
    files: sent.map((change) => change.file),
    ...(headPairs ? { headFiles: headPairs.map((pair) => pair.head) } : {}),
    held,
    // One entry per path given a placeholder, in first-seen order.
    redactions: [...counts.values()].filter((row) => row.diff + row.head > 0),
    ignoredCommitted: files
      .filter((file) => file.status !== "deleted" && ignored.has(file.path))
      .map((file) => file.path),
  }
}

// The context blocks a prompt quotes, as holdbackFiles treats the diff: a related-code entry or hit, a history entry
// (its blame quotes the lines), a human comment and an earlier finding anchored on a held path, or on a path holdback
// would hold (an unchanged `config/prod/.envrc` a grep hit quotes), are dropped; every other text, the pull request's
// title, body and commit subjects, requirements, CI log excerpts and earlier findings' titles included, has its values
// redacted. Authors, paths, lines, symbols, check names and earlier findings' ids and statuses are kept. A block the
// input leaves out stays out, and the result has only the input's keys.
export function holdbackContext(
  context: HoldbackContext,
  input: {
    held: readonly Pick<HeldFile, "path" | "oldPath">[]
    env?: Record<string, string | undefined>
    reading?: BrainScan.Reading
  },
): HoldbackContext {
  const read = reader(input)
  const paths = new Set(input.held.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))
  const dropped = (path: string) => paths.has(path) || heldReason(path) !== undefined
  const pr = context.pr
  return {
    ...(pr
      ? {
          pr: {
            ...pr,
            title: read(pr.title),
            body: read(pr.body),
            ...(pr.commits ? { commits: pr.commits.map(read) } : {}),
          },
        }
      : {}),
    ...(context.related
      ? {
          related: context.related
            .filter((entry) => !dropped(entry.path))
            .map((entry) => ({
              ...entry,
              hits: entry.hits.filter((hit) => !dropped(hit.path)).map((hit) => ({ ...hit, text: read(hit.text) })),
            })),
        }
      : {}),
    ...(context.history
      ? {
          history: context.history
            .filter((entry) => !dropped(entry.path))
            .map((entry) => ({ ...entry, text: read(entry.text) })),
        }
      : {}),
    ...(context.humanComments
      ? {
          humanComments: context.humanComments
            .filter((comment) => comment.path === undefined || !dropped(comment.path))
            .map((comment) => ({ ...comment, body: read(comment.body) })),
        }
      : {}),
    ...(context.requirements !== undefined ? { requirements: read(context.requirements) } : {}),
    ...(context.checks
      ? {
          checks: context.checks.map((check) =>
            check.excerpt === undefined ? check : { ...check, excerpt: read(check.excerpt) },
          ),
        }
      : {}),
    ...(context.prior
      ? {
          prior: context.prior
            .filter((entry) => !dropped(entry.path))
            .map((entry) => ({ ...entry, title: read(entry.title) })),
        }
      : {}),
  }
}

// A credential in trusted instructions is still a credential. Under ruleCheck "strict", omit the affected block as a
// whole so clipping and source offsets on the remaining block agree with the transmitted text. Otherwise no citation
// refers to these blocks, so their values are redacted in place, as the read tool redacts loaded instructions.
export function safeRulePrompt(
  input: { instructions?: string; rules?: string; ruleParts?: readonly RulePart[] },
  config: Pick<ReviewConfig, "ruleCheck" | "holdback">,
) {
  if (config.holdback !== "secrets") return input
  if (config.ruleCheck !== "strict")
    return {
      ...input,
      ...(input.instructions ? { instructions: holdbackText(input.instructions) } : {}),
      ...(input.rules ? { rules: holdbackText(input.rules) } : {}),
      ...(input.ruleParts ? { ruleParts: input.ruleParts.map((part) => ({ ...part, text: holdbackText(part.text) })) } : {}),
    }
  return {
    ...input,
    ...(input.instructions && holdbackText(input.instructions) !== input.instructions ? { instructions: "" } : {}),
    ...(input.rules && holdbackText(input.rules) !== input.rules ? { rules: "", ruleParts: [] } : {}),
  }
}

// One text a read or grep tool returns, its values redacted as the prompt's are: by shape, with no environment.
export function holdbackText(text: string) {
  return reader({})(text)
}

// Lines a tool returns, redacted as one text so that a private key's header still marks the body lines after it, each
// line kept where it was (redactTexts).
export function holdbackLines(lines: readonly string[]) {
  return redactTexts(lines, reader({}))
}

function reader(input: { env?: Record<string, string | undefined>; reading?: BrainScan.Reading }): Read {
  return (text) => BrainScan.named(text, input.env ?? {}, input.reading ?? SHAPES).text
}

// Lowercased first, as every pattern is, so a path is judged alike on every platform: Wildcard ignores case only on
// Windows, and the read tool's rules follow it. The grep tool reads it too (SF-14): under holdback it withholds every
// line from a path this holds back, whatever the session's rules say (design item 2's backstop).
export function heldReason(path: string): HoldbackReason | undefined {
  const lower = path.toLowerCase()
  const matches = (patterns: readonly string[]) => patterns.some((pattern) => Wildcard.match(lower, pattern))
  if (matches(SECRET_FILES)) return "secret-file"
  if (
    matches(ENV_FILES) &&
    !matches(ENV_TEMPLATES) &&
    (matches(ENV_DOTFILES) || matches(ENV_SCRIPTS) || !isCodePath(lower))
  )
    return "env-file"
  if (matches(CREDENTIAL_FILES)) return "credential-file"
  return undefined
}

// A changed file's hunks and its head file's text, redacted as one text so that a key's header or an AWS key ID on
// another line of the same path still counts. A head file that is the diff's post-image is read with the removed lines
// put back; otherwise the hunks are read, then the head file (the hunks of one that is only hunks, or its lines).
function redactPath(file: DiffFile | undefined, head: HeadFile | undefined, read: Read) {
  const own = file?.hunks ?? []
  if (file && head?.exact && !head.annotated && matchPostImage(head.text, file))
    return redactPostImage(own, head.text, read)
  const parsed = head && !head.exact ? parseUnifiedDiff(head.text).flatMap((entry) => entry.hunks) : []
  const mine = hunkTexts(own)
  const out = redactTexts([...mine, ...(head?.exact ? head.text.split("\n") : hunkTexts(parsed))], read)
  const hunks = withTexts(own, out.slice(0, mine.length))
  if (!head) return { hunks }
  const theirs = out.slice(mine.length)
  return {
    hunks,
    headText: head.exact ? theirs.join("\n") : rewriteDiff(head.text, parsed, withTexts(parsed, theirs), read),
  }
}

// The head file's lines with the diff's removed lines put back where they were, so that a removed line is read beside
// the lines it sat between, and a line the diff and the head file share is redacted once: they still match, which
// packing needs to annotate the head file.
function redactPostImage(hunks: readonly DiffHunk[], text: string, read: Read) {
  const lines = text.split("\n")
  const removed = removedBefore(hunks)
  const order = Array.from({ length: lines.length + 1 }, (_, index) => [
    ...(removed.get(index) ?? []),
    ...(index < lines.length ? [index] : []),
  ]).flat()
  const sections = hunks.map((hunk) => section(hunk.header))
  const out = redactTexts(
    [...order.map((item) => (typeof item === "number" ? lines[item] : item.text)), ...sections],
    read,
  )
  const head = out.filter((_, index) => typeof order[index] === "number")
  const gone = new Map(order.flatMap((item, index) => (typeof item === "number" ? [] : [[item, out[index]] as const])))
  const headers = out.slice(order.length)
  return {
    hunks: hunks.map((hunk, index) => ({
      ...hunk,
      header: hunk.header.slice(0, hunk.header.length - sections[index].length) + headers[index],
      lines: hunk.lines.map((line) => ({
        ...line,
        // The diff's lines have no "\r"; a CRLF head file's lines keep theirs.
        text: line.kind === "del" ? gone.get(line)! : head[line.newLine! - 1].replace(/\r$/, ""),
      })),
    })),
    headText: head.join("\n"),
  }
}

// The removed lines by the index of the head line they sat before, as renderAnnotated places them. Each list grows in
// place: the PR author sets how long a deletion runs, and copying a list for every line made a long one quadratic.
function removedBefore(hunks: readonly DiffHunk[]) {
  return hunks.reduce((removed, hunk) => {
    hunk.lines.reduce(
      (next, line) => {
        if (line.kind !== "del") return line.newLine!
        const list = removed.get(next) ?? []
        list.push(line)
        removed.set(next, list)
        return next
      },
      hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1,
    )
    return removed
  }, new Map<number, DiffLine[]>())
}

// Lines read as one text, so that a value's context can lie on another line. Read for shapes, redaction keeps every
// line where it was; were it not to, each line is read on its own rather than put in the wrong place.
function redactTexts(texts: readonly string[], read: Read) {
  const out = read(texts.join("\n")).split("\n")
  if (out.length === texts.length) return out
  return texts.map((text) => read(text))
}

// A hunk header's section: the text git writes after `@@ … @@`, a line of the file.
function section(header: string) {
  return header.slice(header.indexOf(" @@", 2) + 3)
}

function hunkTexts(hunks: readonly DiffHunk[]) {
  return hunks.flatMap((hunk) => [section(hunk.header), ...hunk.lines.map((line) => line.text)])
}

// The hunks given the texts hunkTexts read from them, in the same order.
function withTexts(hunks: readonly DiffHunk[], texts: readonly string[]): DiffHunk[] {
  const queue = texts.values()
  const take = () => queue.next().value ?? ""
  return hunks.map((hunk) => ({
    ...hunk,
    header: hunk.header.slice(0, hunk.header.length - section(hunk.header).length) + take(),
    lines: hunk.lines.map((line) => ({ ...line, text: take() })),
  }))
}

// A diff's text with its hunks redacted: each hunk header and line that `before` accounts for is written from `after`,
// its prefix and line ending kept, and every other line (a file header, a line no hunk counted) is read on its own.
// "\ No newline at end of file" lines pass. It walks the text once with a cursor (a hunk and a line in it) rather than
// mapping: each line is compared only with the next one the hunks expect, so a line equal to one elsewhere in the diff
// is never written from it, and a line no hunk counted does not move the cursor.
function rewriteDiff(text: string, before: readonly DiffHunk[], after: readonly DiffHunk[], read: Read) {
  const out: string[] = []
  let hunk = -1
  let line = 0
  for (const raw of text.split("\n")) {
    const bare = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    const end = raw.slice(bare.length)
    if (!bare.startsWith("\\") && bare.slice(1) === before[hunk]?.lines[line]?.text) {
      out.push(bare === "" ? raw : bare[0] + after[hunk].lines[line].text + end)
      line++
      continue
    }
    if (bare === before[hunk + 1]?.header) {
      hunk++
      line = 0
      out.push(after[hunk].header + end)
      continue
    }
    out.push(bare.startsWith("\\") ? raw : read(raw))
  }
  return out.join("\n")
}

function diffTexts(file: DiffFile) {
  return file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.map((line) => line.text)])
}

// The placeholders `after` has beyond those `before` already had.
function added(before: readonly string[], after: readonly string[]) {
  const count = (texts: readonly string[]) => texts.reduce((sum, text) => sum + text.split(REDACTED).length - 1, 0)
  return count(after) - count(before)
}
