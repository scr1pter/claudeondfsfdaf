// What a review prompt shows of a change. A file whose exact pull request version is at hand is shown once, as an
// annotated file (renderAnnotated) that stands in for both its diff and its full text, when that is no larger than the
// two together: its line numbers cost a few characters a line, which a small change to a long file does not repay. In
// an incremental review a file with no hunk in the focus was reviewed before, so it keeps only its changed lines: no
// context lines and no full text. Pure and browser-safe.

import { renderAnnotated, renderPatch, type DiffFile } from "./diff"
import type { HeadFile } from "./prompt"
import type { Finding, FocusHunk } from "./types"

export function packChanges(input: {
  inline: DiffFile[] // the files the diff budget inlines, in prompt order
  changed?: DiffFile[] // every reviewed file, so head files of those the budget left out are annotated too
  headFiles?: HeadFile[] // the pull request's versions, when the working tree is not the head
  focus?: FocusHunk[] // incremental reviews only
}): { diff: string; headFiles: HeadFile[]; settled: string[] } {
  const changed = input.changed ?? input.inline
  const focused = new Set((input.focus ?? []).map((hunk) => hunk.path))
  const settled = new Set(
    input.focus?.length ? changed.filter((file) => !focused.has(file.path)).map((file) => file.path) : [],
  )
  const headFiles = annotate(
    changed,
    (input.headFiles ?? []).filter((file) => !settled.has(file.path)),
  )
  const annotated = new Set(headFiles.flatMap((file) => (file.annotated ? [file.path] : [])))
  return {
    diff: input.inline
      .flatMap((file) => {
        if (annotated.has(file.path)) return []
        return [settled.has(file.path) ? renderPatch([file], 0) : renderPatch([file])]
      })
      .join("\n"),
    headFiles,
    settled: [...settled],
  }
}

/** Canonical repository path used to select the head file cited by a model evidence reference. */
export function evidencePath(reference: string): string {
  return reference.replace(/:\d+(?:-\d+)?$/, "").replace(/^(\.\/|\/)+/, "")
}

// The head files a double-check needs: the files its candidates sit in and the files their evidence cites, annotated.
// Every other changed file is left out; the checker can still open files from the working tree.
export function verifyHeadFiles(
  changed: DiffFile[],
  headFiles: HeadFile[] | undefined,
  candidates: Pick<Finding, "path" | "evidence">[],
): HeadFile[] | undefined {
  if (!headFiles) return undefined
  const cited = new Set(candidates.flatMap((finding) => [finding.path, ...(finding.evidence ?? []).map(evidencePath)]))
  return annotate(
    changed,
    headFiles.filter((file) => cited.has(file.path)),
  )
}

function annotate(changed: DiffFile[], headFiles: HeadFile[]): HeadFile[] {
  const files = new Map(changed.map((file) => [file.path, file]))
  return headFiles.map((head) => {
    const file = files.get(head.path)
    const text = head.exact && !head.annotated && file ? renderAnnotated(file, head.text) : undefined
    if (text === undefined || text.length > head.text.length + renderPatch([file!]).length) return head
    return { path: head.path, text, exact: true, annotated: true }
  })
}
