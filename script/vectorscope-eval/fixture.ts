import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { applyPatch, parseUnifiedDiff, type DiffFile } from "../../packages/core/src/review/diff"
import type { EvalExpectation } from "../../packages/core/src/review/eval"
import { packChanges } from "../../packages/core/src/review/pack"
import type { PromptInput } from "../../packages/core/src/review/prompt"

// Loading and validation of the Vectorscope evaluation fixtures. The runner refuses to send a fixture that fails
// fixtureProblems, and fixtures.test.ts keeps every checked-in fixture passing it.

export const FIXTURES_DIR = join(import.meta.dir, "fixtures")
const BASE_SHA = "5d1c9e04a7b3f2e8d6c4a1b9e7f5d3c2a0b8e6f4"
const HEAD_SHA = "c8a2f71e93d4b6a05e1f8c3d7b9a2e4f6c0d8b1a"
const MAX_COMMENTS = 25

export interface Fixture {
  name: string
  pr: { title: string; body: string }
  diff: string
  files: DiffFile[]
  headFiles: { path: string; text: string }[]
  expected: EvalExpectation[]
}

// What the reviewer is shown: the fixture without its planted-bug labels.
export type FixtureView = Omit<Fixture, "expected" | "name">

export function fixtureView(fixture: Fixture): FixtureView {
  return { pr: fixture.pr, diff: fixture.diff, files: fixture.files, headFiles: fixture.headFiles }
}

// The app and the engine pack an untrusted change the same way: each changed file once, annotated when that is no
// larger than its diff and its text together. Built from a view, so the labels cannot reach the prompt.
export function promptInput(view: FixtureView): PromptInput {
  const packed = packChanges({
    inline: view.files,
    headFiles: view.headFiles.map((file) => ({ path: file.path, text: file.text, exact: true })),
  })
  return {
    mode: "full",
    trust: "untrusted",
    base: BASE_SHA,
    head: HEAD_SHA,
    pr: view.pr,
    diff: packed.diff,
    headFiles: packed.headFiles,
    maxComments: MAX_COMMENTS,
  }
}

export async function listFixtures() {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
}

export async function loadFixture(name: string): Promise<Fixture> {
  const dir = join(FIXTURES_DIR, name)
  const diff = await Bun.file(join(dir, "diff.patch")).text()
  const paths = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(dir, "head"), onlyFiles: true, dot: true }))
  return {
    name,
    pr: await Bun.file(join(dir, "pr.json")).json(),
    diff,
    files: parseUnifiedDiff(diff),
    headFiles: await Promise.all(
      paths.toSorted().map(async (path) => ({
        path: path.replaceAll("\\", "/"),
        text: await Bun.file(join(dir, "head", path)).text(),
      })),
    ),
    expected: await Bun.file(join(dir, "expected.json")).json(),
  }
}

// Everything wrong with a fixture; empty when it is valid. Each changed file's head copy must be exactly what the
// diff produces: the base is rebuilt by applying the diff in reverse to the head copy, and applying the diff to that
// base must give the head copy back.
export function fixtureProblems(fixture: Fixture): string[] {
  const heads = new Map(fixture.headFiles.map((file) => [file.path, file.text]))
  const changed = new Set(fixture.files.map((file) => file.path))
  const expected = Array.isArray(fixture.expected) ? fixture.expected : []
  const ids = expected.map((expectation) => expectation.id)
  return [
    ...(typeof fixture.pr?.title === "string" && fixture.pr.title.trim() ? [] : ["pr.json has no title"]),
    ...(typeof fixture.pr?.body === "string" ? [] : ["pr.json has no body"]),
    ...(fixture.files.length ? [] : ["diff.patch has no files"]),
    ...hunkProblems(fixture.diff, fixture.files),
    ...fixture.files.flatMap((file) => headProblems(file, heads.get(file.path))),
    ...[...heads.keys()].filter((path) => !changed.has(path)).map((path) => `head/${path} is not changed by the diff`),
    ...(Array.isArray(fixture.expected) ? [] : ["expected.json is not an array"]),
    ...ids.filter((id, index) => ids.indexOf(id) !== index).map((id) => `expectation id ${id} repeats`),
    ...expected.flatMap((expectation) => expectationProblems(expectation, fixture.files)),
  ]
}

function headProblems(file: DiffFile, head: string | undefined) {
  if (file.binary) return [`${file.path} is binary`]
  if (file.status === "deleted") return head === undefined ? [] : [`head/${file.path} exists but the diff deletes it`]
  if (head === undefined) return [`head/${file.path} is missing`]
  const base = applyPatch(head, reverse(file))
  if (base === undefined || applyPatch(base, file) !== head)
    return [`head/${file.path} is not the post-image of the diff`]
  return []
}

// The parser reads a hunk by the counts in its header, so a wrong count shows up as lines it left unread or as a
// hunk whose lines disagree with its header.
function hunkProblems(diff: string, files: DiffFile[]) {
  const lines = diff.replace(/\n$/, "").split("\n")
  const starts = lines.flatMap((line, index) => (line.startsWith("diff --git ") ? [index] : []))
  const chunks = starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length))
  if (chunks.length !== files.length)
    return [`diff.patch has ${chunks.length} file sections but parses as ${files.length}`]
  return files.flatMap((file, index) => {
    if (!file.hunks.length) return [`${file.path} has no hunks`]
    const unread =
      chunks[index].length -
      chunks[index].findIndex((line) => line.startsWith("@@ ")) -
      file.hunks.reduce((sum, hunk) => sum + 1 + hunk.lines.length, 0)
    const counts = file.hunks.flatMap((hunk) =>
      hunk.lines.filter((line) => line.kind !== "add").length === hunk.oldLines &&
      hunk.lines.filter((line) => line.kind !== "del").length === hunk.newLines
        ? []
        : [`${file.path}: hunk "${hunk.header}" does not match its line counts`],
    )
    return unread === 0 ? counts : [`${file.path}: ${unread} diff lines are outside any hunk`, ...counts]
  })
}

function expectationProblems(expectation: EvalExpectation, files: DiffFile[]) {
  const label = `expectation ${expectation.id}`
  const file = files.find((candidate) => candidate.path === expectation.path && candidate.status !== "deleted")
  const lines = file?.hunks.flatMap((hunk) => hunk.lines) ?? []
  const added = lines.some((line) => line.kind === "add" && line.newLine === expectation.line)
  const end =
    expectation.endLine === undefined ||
    (expectation.endLine >= expectation.line && lines.some((line) => line.newLine === expectation.endLine))
  return [
    ...(typeof expectation.id === "string" && expectation.id ? [] : ["an expectation has no id"]),
    ...(expectation.severity === "blocking" || expectation.severity === "concern"
      ? []
      : [`${label} has severity ${expectation.severity}`]),
    ...(typeof expectation.description === "string" && expectation.description.trim()
      ? []
      : [`${label} has no description`]),
    ...(file ? [] : [`${label} names ${expectation.path}, which the diff does not add or change`]),
    ...(!file || added ? [] : [`${label}: line ${expectation.line} is not an added line of ${expectation.path}`]),
    ...(!file || end
      ? []
      : [`${label}: endLine ${expectation.endLine} is not a diff line at or after line ${expectation.line}`]),
  ]
}

// The same change seen from the head: added lines become removed ones and the old and new sides swap.
function reverse(file: DiffFile): DiffFile {
  return {
    ...file,
    status: file.status === "added" ? "deleted" : file.status === "deleted" ? "added" : file.status,
    hunks: file.hunks.map((hunk) => ({
      ...hunk,
      oldStart: hunk.newStart,
      oldLines: hunk.newLines,
      newStart: hunk.oldStart,
      newLines: hunk.oldLines,
      lines: hunk.lines.map((line) => ({
        ...line,
        kind: line.kind === "add" ? "del" : line.kind === "del" ? "add" : "context",
        oldLine: line.newLine,
        newLine: line.oldLine,
      })),
    })),
  }
}
