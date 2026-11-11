export * as EverywherePublish from "./publish"

import {
  BRANCH_PATTERN,
  LIMITS,
  isIssueKey,
  isJobId,
  isPlatform,
  isRepositoryName,
  type PlatformId,
} from "@vectordevai/schema/everywhere"
import {
  PLATFORM_NAMES,
  outsideCode,
  sanitizeReply,
  titleWords,
  wrapMentions,
} from "@vectordevai/schema/everywhere-policy"

/*
 * What the desktop runner writes to git and GitHub after an unattended run (contract 3.5 step 8): the branch name, the
 * paths it holds back, the commit message and the draft pull request, all from fixed templates. The only model text
 * that reaches GitHub is the summary, after `sanitizeReply`, the mention wrap and the closing-reference strip. Pure and
 * runtime-neutral.
 */

export { wrapMentions }

/** The marker a draft PR and a status comment carry, so the server can find its own. */
export function jobMarker(jid: string) {
  if (!isJobId(jid)) throw new RangeError("A job marker needs a job id.")
  return `<!-- vector:job ${jid} -->`
}

/**
 * The branch a job pushes: `vector/ve-<12 characters of the jid>`, or for a Linear or Jira job
 * `vector/ve-<issue key>-<8 characters of the jid>`, the key lowercase for Linear (as Linear writes branch names) and
 * as written for Jira. The characters are the jid's random tail, so two jobs in the same millisecond still differ.
 */
export function branchFor(jid: string, issue?: { readonly key: string; readonly platform: PlatformId }) {
  if (!isJobId(jid)) throw new RangeError("A branch needs a job id.")
  if (issue === undefined) return checked(`vector/ve-${jid.slice(-12)}`)
  if (issue.platform !== "linear" && issue.platform !== "jira")
    throw new RangeError("Only Linear and Jira jobs carry an issue key.")
  if (!isIssueKey(issue.key)) throw new RangeError("The issue key is malformed.")
  const key = issue.platform === "linear" ? issue.key.toLowerCase() : issue.key
  return checked(`vector/ve-${key}-${jid.slice(-8)}`)
}

function checked(branch: string) {
  if (!BRANCH_PATTERN.test(branch)) throw new RangeError("The branch is malformed.")
  return branch
}

/** Top-level folders a run may change but the runner never commits: CI, hooks and their settings (E7). */
export const HELD_BACK_FOLDERS = [".github", ".husky", ".githooks"] as const
/** Files the runner never commits wherever they are: they set git filters, attributes and submodules. */
export const HELD_BACK_FILES = [".gitattributes", ".gitmodules"] as const

/**
 * A path's parts as git and the file system read them: `\` as `/`, no `.` parts, and each part with Windows' trailing
 * dots and spaces removed and lowercased, since macOS and Windows treat `.GitHub/` and `.github./` as `.github/`.
 */
function pathParts(path: string) {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.replace(/[. ]+$/, (tail) => (part === tail ? tail : "")).toLowerCase())
    .filter((part) => part !== "" && part !== ".")
}

/** Whether the runner holds this changed path back: under `.github/`, `.husky/` or `.githooks/`, or a git settings file. */
export function isHeldBack(path: string) {
  const parts = pathParts(path)
  if (parts.length === 0) return false
  if ((HELD_BACK_FOLDERS as readonly string[]).includes(parts[0]!)) return true
  return (HELD_BACK_FILES as readonly string[]).includes(parts[parts.length - 1]!)
}

/** The changed paths the runner reverts and lists as held back, in the order given. */
export function heldBack(paths: readonly string[]) {
  return paths.filter(isHeldBack)
}

/** Words that close an issue when a pull request merges, on GitHub and on Linear. */
const CLOSING = String.raw`(?:close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving|complete[sd]?|completing)`
const OWNER = String.raw`[A-Za-z0-9][A-Za-z0-9-]{0,38}`
const NAME = String.raw`[A-Za-z0-9_.-]{1,100}`
const REFERENCE =
  String.raw`(?:https:\/\/github\.com\/(${OWNER})\/(${NAME})\/(?:issues|pull)\/([0-9]{1,10})` +
  String.raw`|(${OWNER})\/(${NAME})#([0-9]{1,10})` +
  String.raw`|(#[0-9]{1,10})` +
  String.raw`|([A-Za-z][A-Za-z0-9_]{0,9}-[0-9]{1,7}))`
const CLOSING_REFERENCE = new RegExp(String.raw`\b(${CLOSING})(\s*:)?(\s+)${REFERENCE}(?![\w-])`, "gi")

/**
 * Removes closing references that would close something other than the job's own work when the PR merges: a GitHub
 * issue in another repository (`Fixes other/repo#1` or its URL) and any issue key but the job's own (`Fixes ENG-9`
 * when the job is ENG-123). The keyword goes and the reference stays as code, so it neither closes nor links. The
 * template's own "Fixes ENG-123" or "PROJ-123" line, and same-repository `#12` references, are kept.
 */
export function stripClosingKeywords(
  text: string,
  options: { readonly repository: string; readonly issueKey?: string },
) {
  const own = isRepositoryName(options.repository) ? options.repository.toLowerCase() : undefined
  const ownKey = isIssueKey(options.issueKey) ? options.issueKey.toUpperCase() : undefined
  return outsideCode(text, (plain) =>
    plain.replace(
      CLOSING_REFERENCE,
      (match, _word, _colon, _space, urlOwner, urlName, urlNumber, refOwner, refName, refNumber, local, key) => {
        if (local) return match
        if (key) return key.toUpperCase() === ownKey ? match : `\`${key}\``
        const owner = urlOwner ?? refOwner
        const name = urlName ?? refName
        const number = urlNumber ?? refNumber
        if (own !== undefined && `${owner}/${name}`.toLowerCase() === own) return match
        return `\`${owner}/${name}#${number}\``
      },
    ),
  )
}

/** The subject of the commit and the PR title: "<issue key> Vector: <the task's first words>". */
export function prTitle(input: { readonly task: string; readonly issueKey?: string }) {
  const words = titleWords(input.task, 60) || "requested changes"
  const key = isIssueKey(input.issueKey) ? `${input.issueKey} ` : ""
  return `${key}Vector: ${words}`
}

/**
 * The runner's commit message: the PR title, the job id, and `[skip ci]`, so the repository's CI (and its secrets)
 * runs only after a person pushes or starts it.
 */
export function commitMessage(input: { readonly jid: string; readonly task: string; readonly issueKey?: string }) {
  if (!isJobId(input.jid)) throw new RangeError("A commit message needs a job id.")
  return `${prTitle(input)}\n\nVector everywhere job ${input.jid}.\n\n[skip ci]`
}

export type PrTemplateInput = {
  readonly jid: string
  readonly platform: PlatformId
  readonly repository: string
  /** The requester's own words; only their first words reach the title. */
  readonly task: string
  readonly issueKey?: string
  /** A GitHub job's issue or pull request. */
  readonly github?: { readonly kind: "issue" | "pr"; readonly number: number }
  /** The summary after the computer's headless posting check; sanitized again here. */
  readonly summary?: string
  /** How many changed paths were held back. */
  readonly held?: number
}

/**
 * The draft PR (3.5 step 8, 4.1 item 2) from a fixed template: the issue key and the task's first words as the title;
 * then the checked summary, the held-back count, a line saying checks have not run and how to start them, the issue
 * line ("Fixes ENG-123" for Linear, the key for Jira, "Refs #12" for GitHub), and the job marker.
 */
export function prTemplate(input: PrTemplateInput) {
  if (!isJobId(input.jid)) throw new RangeError("A pull request needs a job id.")
  if (!isPlatform(input.platform)) throw new RangeError("A pull request needs a known platform.")
  if (!isRepositoryName(input.repository)) throw new RangeError("A pull request needs the exact owner/name.")
  const issueKey =
    (input.platform === "linear" || input.platform === "jira") && isIssueKey(input.issueKey) ? input.issueKey : undefined

  const title = prTitle({ task: input.task, issueKey })
  const checked =
    input.summary === undefined
      ? ""
      : sanitizeReply(input.summary, { platform: "github", repository: input.repository, maxChars: LIMITS.summaryChars })
          .text
  const summary = checked === "" ? "No summary was sent." : checked

  const lines = [summary, ""]
  const held = input.held
  if (typeof held === "number" && Number.isSafeInteger(held) && held > 0)
    lines.push(
      `Held back: ${held} ${held === 1 ? "file" : "files"} under .github/, .husky/, .githooks/, .gitattributes or .gitmodules ${held === 1 ? "was" : "were"} not committed. ${held === 1 ? "It stays" : "They stay"} in the worktree on the computer that ran the job.`,
      "",
    )
  lines.push(
    "Checks have not run: the commit carries [skip ci], so this repository's CI starts only when a person pushes a commit to this branch.",
    "",
  )
  if (input.platform === "linear" && issueKey) lines.push(`Fixes ${issueKey}`, "")
  if (input.platform === "jira" && issueKey) lines.push(issueKey, "")
  if (input.platform === "github" && input.github && Number.isSafeInteger(input.github.number) && input.github.number > 0)
    lines.push(`Refs #${input.github.number}`, "")
  lines.push(`Opened by Vector everywhere for a request on ${PLATFORM_NAMES[input.platform]}.`, jobMarker(input.jid))

  const body = stripClosingKeywords(wrapMentions(lines.join("\n")), { repository: input.repository, issueKey })
  return { title, body }
}
