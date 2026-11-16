import { isAbsolute, join, relative, sep } from "node:path"

// Raw eval outputs (reports, ledger journals, judgement files, worksheets) stay outside the repository, so they are
// never committed by accident (VectorScope plan, "Budget, privacy and release gate").

export const REPO_ROOT = join(import.meta.dir, "..", "..")

// Whether a path is outside the repository. A name that only starts with two dots, such as <repo>/..reports, is inside.
export function outsideRepository(path: string, root = REPO_ROOT) {
  const inside = relative(root, path)
  return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)
}
