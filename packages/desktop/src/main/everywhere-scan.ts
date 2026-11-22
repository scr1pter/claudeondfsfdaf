import { sanitizeReply, secretLike, WITHHELD } from "@vectordevai/schema/everywhere-policy"
import type { EverywhereJob } from "@vectordevai/schema/everywhere"

export type PostingCheck = (parts: readonly string[], sessions: readonly string[]) => Promise<{
  readonly status: "clean" | "changed" | "ask"
  readonly parts: readonly string[]
}>

/** A diff read as git writes it: its added lines, and the file header lines outside every hunk. */
function readPatch(diff: string): { readonly added: readonly string[]; readonly headers: readonly string[] } | undefined {
  if (/^(?:GIT binary patch|Binary files )/m.test(diff)) return undefined
  const added: string[] = []
  const headers: string[] = []
  let old = 0
  let next = 0
  let patch = diff === ""
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line)
    if (hunk) {
      if (old || next) return undefined
      old = Number(hunk[1] ?? 1)
      next = Number(hunk[2] ?? 1)
      if (!Number.isSafeInteger(old) || !Number.isSafeInteger(next)) return undefined
      patch = true
      continue
    }
    if (line === "\\ No newline at end of file") continue
    if (old || next) {
      if (line.startsWith("+") && next > 0) { added.push(line.slice(1)); next--; continue }
      if (line.startsWith("-") && old > 0) { old--; continue }
      if (line.startsWith(" ") && old > 0 && next > 0) { old--; next--; continue }
      return undefined
    }
    if (line === "") continue
    if (/^(?:diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |--- |\+\+\+ )/.test(line)) { patch = true; headers.push(line); continue }
    return undefined
  }
  return patch && old === 0 && next === 0 ? { added, headers } : undefined
}

/** Binary changes cannot be inspected by this textual secret/privacy boundary and remain local. */
export function addedLines(diff: string): string | undefined {
  return readPatch(diff)?.added.join("\n")
}

const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }
const UTF8 = new TextDecoder("utf-8", { fatal: true })
const ENCODER = new TextEncoder()

/** A path as a git header writes it: bare, or C-quoted (`"caf\303\251"`) when it holds unusual bytes. */
function headerPath(text: string): string | undefined {
  if (!text.startsWith('"')) return text === "" ? undefined : text
  if (text.length < 2 || !text.endsWith('"')) return undefined
  const body = text.slice(1, -1)
  const bytes: number[] = []
  const part = /\\([0-7]{3})|\\([abtnvfr"\\])|([^"\\]+)/y
  while (part.lastIndex < body.length) {
    const match = part.exec(body)
    if (!match) return undefined
    if (match[1] !== undefined) {
      const byte = Number.parseInt(match[1], 8)
      if (byte > 255) return undefined
      bytes.push(byte)
    } else if (match[2] !== undefined) bytes.push(C_ESCAPES[match[2]]!)
    else bytes.push(...ENCODER.encode(match[3]))
  }
  try {
    const path = UTF8.decode(new Uint8Array(bytes))
    return path === "" ? undefined : path
  } catch { return undefined }
}

/**
 * The paths a staged diff adds, changes or renames to, read from its `+++ b/<path>`, `rename to` and `copy to` headers
 * outside every hunk (a `+++` line inside a hunk is added content). git ends a `+++` line with a tab when its path holds
 * a space, and C-quotes a path with unusual bytes. A deletion's `+++ /dev/null` names nothing. Undefined when the diff,
 * or any of those headers, cannot be read: the push gate treats that as unsafe.
 */
export function stagedPaths(diff: string): readonly string[] | undefined {
  const headers = readPatch(diff)?.headers
  if (headers === undefined) return undefined
  const paths: string[] = []
  for (const line of headers) {
    if (line.startsWith("+++ ")) {
      const label = line.slice(4).replace(/\t$/, "")
      if (label === "/dev/null") continue
      const path = headerPath(label)
      if (path === undefined || !path.startsWith("b/") || path.length === 2) return undefined
      paths.push(path.slice(2))
      continue
    }
    const moved = /^(?:rename|copy) to (.*)$/.exec(line)
    if (!moved) continue
    const path = headerPath(moved[1]!)
    if (path === undefined) return undefined
    paths.push(path)
  }
  return paths
}

/** `.env.*` files that are templates by their final suffix (`.env.local.example`), not filled-in env files. */
const ENV_TEMPLATES = ["example", "sample", "template", "dist", "defaults"]
/** Files that hold logins, tokens or cluster access by their name alone, wherever they are. */
const CREDENTIAL_NAMES = [".netrc", "_netrc", ".pgpass", ".git-credentials", ".pypirc", ".vault-token", ".s3cfg", "credentials", "kubeconfig"]
/** Private keys, keystores, and Terraform variables and state. */
const CREDENTIAL_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".tfvars", ".tfstate"]
const SSH_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/

/**
 * Whether a changed path names a credential file: an env file (`.env` and `.env.production`, not `.env.example`), a
 * login or token store, an SSH private key, or a key, keystore or Terraform variables or state file. It is judged on the
 * file name, lowercased and without Windows' trailing dots and spaces, so `config/.ENV.` counts. The list is defined
 * here on purpose: VectorScope's holdback list belongs to that feature.
 */
export function credentialPath(path: string) {
  const base = path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? ""
  const name = (base.replace(/[. ]+$/, "") || base).toLowerCase()
  if (name === ".env") return true
  if (name.startsWith(".env.")) return !ENV_TEMPLATES.includes(name.slice(name.lastIndexOf(".") + 1))
  return CREDENTIAL_NAMES.includes(name) || SSH_KEY.test(name) || CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * Underscore-delimited words that make an env-style name a secret's: `DATABASE_PASSWORD`, `SENTRY_DSN` and
 * `AWS_SECRET_ACCESS_KEY` are, `PASSPORT_ID` and `MAX_TOKENS` are not.
 */
const SECRET_NAME = /(?:^|_)(?:PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|CREDENTIALS?|DSN)(?:_|$)/
/**
 * An assigned value, read ahead so the text after `=` is scanned again (`ENV=DB_PASSWORD=…`): a quoted string, a
 * `<placeholder>`, a `${{ expression }}`, or the next word.
 */
const VALUE = String.raw`(?=("[^"\r\n]*"|'[^'\r\n]*'|<[^>\r\n]*>|\$\{\{[^}\r\n]*\}\}|\S*))`
/**
 * `NAME=value` or `NAME: value` with an upper-case, env-style name, anywhere in a line, so a leading `export` or `ENV`
 * changes nothing. Code's own names (`const token = getToken()`) are not env assignments.
 */
const ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_])([A-Z_][A-Z0-9_]*)(?:=[ \t]*|:[ \t]+)${VALUE}`, "g")
/** npm registry credentials in an .npmrc: `//registry/:_authToken=`, `_auth=` and `_password=`. */
const NPM_AUTH = new RegExp(String.raw`(?:^|[\s:])_(?:authToken|auth|password)[ \t]*=[ \t]*${VALUE}`, "gim")
/** Values that are not a secret: empty, a variable or Actions secret, or a placeholder someone fills in. */
const PLACEHOLDERS = [
  /^$/,
  /^\$\{[^}]*\}$/,
  /^\$[A-Za-z_][A-Za-z0-9_]*$/,
  /^\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}$/,
  /^<[^>]*>$/,
  /^\*{3,}$/,
  /^x{3,}$/i,
  /^changeme$/i,
  /^your[-_]/i,
]

function literal(value: string) {
  const bare = /^(["']).*\1$/s.test(value) ? value.slice(1, -1).trim() : value
  return !PLACEHOLDERS.some((pattern) => pattern.test(bare))
}

/**
 * Whether text assigns a secret the way an env file, a shell, a container setting or an .npmrc does: a secret-named
 * `NAME=value` or `NAME: value` (`DATABASE_PASSWORD=hunter2`), or npm's `_authToken=`, with a value that is not a
 * placeholder. core's BrainScan.named is not used: it flags code such as `const token = getToken()`.
 */
export function envSecret(text: string) {
  for (const match of text.matchAll(ASSIGNMENT)) if (SECRET_NAME.test(match[1]!) && literal(match[2]!)) return true
  for (const match of text.matchAll(NPM_AUTH)) if (literal(match[1]!)) return true
  return false
}

export async function checkedSummary(job: EverywhereJob, text: string, sessions: readonly string[], check: PostingCheck) {
  if (secretLike(text) || envSecret(text)) return WITHHELD.secret
  const cleaned = sanitizeReply(text, { platform: job.platform, repository: job.repository.fullName, maxChars: job.reply.maxChars }).text
  try {
    const result = await check([cleaned], sessions)
    if (result.status === "ask" || !Array.isArray(result.parts)) return WITHHELD.posting
    return sanitizeReply(result.parts.join("\n"), { platform: job.platform, repository: job.repository.fullName, maxChars: job.reply.maxChars }).text
  } catch { return WITHHELD.posting }
}

/**
 * Whether a staged diff may leave this computer. Besides the token and key shapes (secretLike), a secret in env form
 * or a credential file (another project's `.env` copied in from the home folder) keeps the branch local, so the job
 * settles `held`; so does a changed path the gate cannot read.
 */
export async function mayPushDiff(diff: string, sessions: readonly string[], check: PostingCheck) {
  const lines = addedLines(diff)
  const paths = stagedPaths(diff)
  if (lines === undefined || paths === undefined || secretLike(lines) || envSecret(lines) || paths.some(credentialPath)) return false
  try {
    const result = await check([lines], sessions)
    return result.status === "clean" && result.parts.length === 1 && result.parts[0] === lines
  } catch { return false }
}
