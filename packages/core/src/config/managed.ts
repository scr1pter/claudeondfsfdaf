export * as ConfigManaged from "./managed"

import { spawnSync } from "child_process"
import { existsSync, realpathSync, statSync, type Stats } from "fs"
import os from "os"
import path from "path"

// Company policy: the managed folder's vector.json and vector.jsonc, the macOS MDM profile and, on Windows, the
// policy key. It overrides the user's own config, so it counts only when an administrator is the only one who could
// have written it. Nothing here takes its lead from the environment Vector starts in: the system tools it runs are
// found by absolute path, never through PATH, and no variable can point it at another folder, so whatever starts
// Vector (a nested vector the agent runs included) can neither forge company policy nor hide it. Everything here is
// synchronous: Vector Local resolves its policy from these sources once, at process start, before any startup fetch,
// and the config loader reads the same sources so the two always agree. The desktop's main process reads them here
// too (LocalStartup.policy and LocalStartup.ca), so it trusts the same company policy its engine does.

const MANAGED_PLIST_DOMAINS = ["ai.vector.managed"]
const MANAGED_PREFERENCES = "/Library/Managed Preferences"

// Keys injected by macOS/MDM into the managed plist that are not Vector config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

/** The Windows policy key. Only administrators can write under HKLM\SOFTWARE\Policies; it holds vector.json as text. */
export const REGISTRY_KEY = "HKLM\\SOFTWARE\\Policies\\Vector"
export const REGISTRY_VALUE = "Config"
const REGISTRY_PARENT = "HKLM\\SOFTWARE\\Policies"
const REGISTRY_LISTED = /^HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Vector\s*$/im

/** What the Vector Local pane shows for a policy file it ignored. */
export const UNTRUSTED = "Ignored a policy file that standard users can change."

const MANAGED_FILES = ["vector.json", "vector.jsonc"]

// The system tools that read company policy. A program earlier in PATH, or on Windows in the working folder, could
// report a forged owner or print nothing at all. Windows is taken to live in C:\Windows: SystemRoot is the user's to
// change, and Vector does not run a tool from wherever it points.
const WINDOWS = "C:\\Windows"
export const PLUTIL = "/usr/bin/plutil"
const LS = "/bin/ls"
export const REG = path.win32.join(WINDOWS, "System32", "reg.exe")
export const POWERSHELL = path.win32.join(WINDOWS, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

// Windows accounts that only administrators control. CREATOR OWNER and OWNER RIGHTS stand for the owner, which must
// be one of these anyway.
const SYSTEM = "S-1-5-18"
const ADMINISTRATORS = "S-1-5-32-544"
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
const OWNER_STAND_INS = ["S-1-3-0", "S-1-3-4"]

// Rights that let someone change a file's contents, replace it or take it over: write and append data, delete, change
// permissions, take ownership, and the generic all and write rights.
const FILE_WRITE = 0x2 | 0x4 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000
// Rights over a folder that let someone remove or replace the files an administrator put there: delete child, delete,
// change permissions, take ownership and generic all. Creating new files is not among them: C:\ProgramData lets every
// user create files by default, and a file a user creates is theirs, which the file check refuses.
const FOLDER_WRITE = 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000
// Rights an entry of a macOS access control list can grant that let someone change a file, or add to, remove from or
// take over a folder.
const MAC_WRITE = [
  "write",
  "append",
  "delete",
  "delete_child",
  "add_file",
  "add_subdirectory",
  "writeattr",
  "writeextattr",
  "writesecurity",
  "chown",
]

export type Policy = { readonly source: string; readonly text: string }
export type Ignored = {
  readonly source: string
  readonly reason: string
  /**
   * "untrusted": a standard user could have written it, so it is left out. "unreadable": it may hold company policy,
   * but Vector could not read it or could not check who may change it; Vector Local stays on with Web access None
   * where it was on.
   */
  readonly kind: "untrusted" | "unreadable"
}
type Verdict = Pick<Ignored, "reason" | "kind">

export type Read = {
  /** Managed config files that passed the trust check, in merge order. */
  readonly files: readonly string[]
  /** The MDM profile or the Windows policy key, merged after the files. */
  readonly policies: readonly Policy[]
  /** Sources that exist but were left out, and why. */
  readonly ignored: readonly Ignored[]
}

export type AclRule = {
  readonly sid: string
  readonly rights: number
  readonly allow: boolean
  /** An inherit-only entry applies to what is created inside a folder, not to the folder itself. */
  readonly inheritOnly?: boolean
}
export type Acl = { readonly owner: string; readonly rules: readonly AclRule[] }
/** Reads the owner and access rules of each path, and the SID of the user running Vector. */
export type AclReader = (paths: readonly string[]) => {
  readonly user?: string
  readonly entries: Readonly<Record<string, Acl | undefined>>
}

/** Lists the macOS access control lists of `paths`, as `ls -lde` prints them. */
export type MacAclReader = (paths: readonly string[]) => {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error
}

export type TrustOptions = {
  readonly platform?: NodeJS.Platform
  /** Reads Windows access rules. The default asks PowerShell. */
  readonly acl?: AclReader
  /** Reads macOS access control lists. The default runs /bin/ls. */
  readonly macAcl?: MacAclReader
  /**
   * Whether the user running Vector may own the file too. Only the test managed folder allows it, since a test cannot
   * create files owned by root or Administrators. The rest of the check (no one else may write) still applies.
   */
  readonly user?: boolean
}

// The test managed folder, chosen explicitly by the test harness. No environment variable can: one would let whatever
// starts Vector swap the company's policy for a folder it owns, or drop the MDM profile and the policy key.
const testing: { directory?: string; acl?: AclReader } = {}

/**
 * Tests only: read company policy from `directory`, let the user running Vector own the files there, and leave this
 * computer's own MDM profile and policy key out, so a test never reads the machine's real company policy. Policy
 * semantics fixtures may supply their own Windows ACL reader; omitting it or clearing the directory restores the
 * real reader. Nothing in the process environment can choose either override.
 */
export function useTestDirectory(directory: string | undefined, acl?: AclReader) {
  testing.directory = directory
  testing.acl = directory === undefined ? undefined : acl
}

/** The folders that hold managed vector.json and vector.jsonc. */
export function directories() {
  if (testing.directory) return [testing.directory]
  return systemDirectories()
}

/**
 * The system's managed folders. On Windows that is C:\ProgramData\vector, plus the folder the ProgramData variable
 * names when it differs: the variable is the user's to change, but a file there still has to pass the access check.
 */
export function systemDirectories(
  platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (platform === "darwin") return ["/Library/Application Support/vector"]
  if (platform !== "win32") return ["/etc/vector"]
  const named = env.ProgramData?.trim()
  const folders = [path.win32.join("C:\\ProgramData", "vector"), ...(named ? [path.win32.join(named, "vector")] : [])]
  return folders.filter(
    (folder, index) => folders.findIndex((other) => other.toLowerCase() === folder.toLowerCase()) === index,
  )
}

/** Every managed source, with the ones a standard user could have written, or Vector could not read, left out. */
export function read(): Read {
  const user = testing.directory !== undefined
  const checked = directories()
    .flatMap((directory) => MANAGED_FILES.map((file) => path.join(directory, file)))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, verdict: check(file, { user, ...(user && testing.acl ? { acl: testing.acl } : {}) }) }))
  const policies = user ? [] : systemPolicies()
  return {
    files: checked.filter((item) => item.verdict === undefined).map((item) => item.file),
    policies: policies.filter((item) => "text" in item),
    ignored: [
      ...checked.flatMap((item) => (item.verdict ? [{ source: item.file, ...item.verdict }] : [])),
      ...policies.filter((item) => "reason" in item),
    ],
  }
}

/** Explicit periodic policy readers refresh OS-managed sources; ordinary startup reads retain their cache. */
export function refresh(): Read {
  policyCache.value = undefined
  return read()
}

/**
 * Why a managed file cannot be trusted, or undefined when only an administrator could have changed it (or it does not
 * exist). macOS and Linux: the file and every folder above it must be owned by root, and no one else may write them,
 * except a world-writable folder with the sticky bit (/tmp), whose entries only their owners can replace; on macOS no
 * access control list may let anyone but root write them either. Windows: the folder and the file must be owned by
 * Administrators, SYSTEM or TrustedInstaller, and no other account may be granted the rights to change or replace them.
 */
export function untrusted(file: string, options: TrustOptions = {}) {
  return check(file, options)?.reason
}

/**
 * Why a POSIX file or folder cannot be trusted, from its stat, or undefined when it can. Any group write counts, root's
 * own group included: on Linux a file with an access control list shows the list's mask in its group bits, so a list
 * that lets another user write always sets them.
 */
export function posixReason(
  entry: { readonly path: string; readonly uid: number; readonly mode: number },
  owners: readonly number[],
) {
  if (!owners.includes(entry.uid)) return `${entry.path} is not owned by root.`
  const writable = (entry.mode & 0o022) !== 0
  const sticky = (entry.mode & 0o170000) === 0o040000 && (entry.mode & 0o1000) !== 0
  if (writable && !sticky) return `${entry.path} can be changed by other users.`
  return undefined
}

/**
 * Who a macOS access control list lets change one of `paths`, from `ls -lde` output, or undefined. macOS checks these
 * lists before the mode bits, and stat does not show them, so only root and the wheel group may hold such a right.
 */
export function macAclReason(stdout: string, paths: readonly string[]) {
  return stdout.split("\n").reduce<{ target?: string; reason?: string }>((state, line) => {
    if (state.reason) return state
    const target = paths.find((item) => line.endsWith(` ${item}`))
    if (target && /^[-bcdlps][-rwxsStT]{9}/.test(line)) return { target }
    const entry = /^\s*\d+:\s+((?:user|group):\S+)\s+(?:inherited\s+)?allow\s+(\S+)/.exec(line)
    if (!entry || !state.target || ["user:root", "group:wheel"].includes(entry[1]!)) return state
    if (!entry[2]!.split(",").some((right) => MAC_WRITE.includes(right))) return state
    return { reason: `${state.target} lets ${entry[1]} change it.` }
  }, {}).reason
}

/** Why a Windows file or folder cannot be trusted, from its owner and access rules, or undefined when it can. */
export function windowsReason(target: string, acl: Acl, kind: "file" | "folder", owners: readonly string[]) {
  if (!owners.includes(acl.owner)) return `${target} is not owned by Administrators or SYSTEM.`
  const rights = kind === "file" ? FILE_WRITE : FOLDER_WRITE
  const grant = acl.rules.find(
    (rule) =>
      rule.allow &&
      !rule.inheritOnly &&
      !owners.includes(rule.sid) &&
      !OWNER_STAND_INS.includes(rule.sid) &&
      (rule.rights & rights) !== 0,
  )
  if (grant) return `${target} lets ${grant.sid} change it.`
  return undefined
}

/**
 * The Config value from `reg query` output for the policy key. It has to be one line of JSON in a REG_SZ (or
 * REG_EXPAND_SZ) value: a value of another type, or one that runs over several lines, is refused rather than read in
 * part.
 */
export function parseRegistry(stdout: string): { readonly text: string } | { readonly reason: string } | undefined {
  const lines = stdout.split(/\r?\n/)
  const name = new RegExp(`^\\s+${REGISTRY_VALUE}\\s+(REG_[A-Z_]+)(?:\\s+(.*?))?\\s*$`, "i")
  const index = lines.findIndex((line) => name.test(line))
  if (index === -1) return undefined
  const match = name.exec(lines[index]!)!
  const type = match[1]!.toUpperCase()
  if (type !== "REG_SZ" && type !== "REG_EXPAND_SZ")
    return {
      reason: `${REGISTRY_KEY} holds ${REGISTRY_VALUE} as ${type}. Vector reads it only as one line of JSON in a REG_SZ value.`,
    }
  // reg prints a value's own line breaks as they are, so a value on several lines leaves lines that are neither a
  // value nor a key.
  const next = lines[index + 1] ?? ""
  if (next.trim() !== "" && !/^\s+\S+\s+REG_[A-Z_]+/i.test(next) && !/^HKEY_/i.test(next))
    return {
      reason: `${REGISTRY_KEY} holds ${REGISTRY_VALUE} on more than one line. Vector reads it only as one line of JSON.`,
    }
  if (!match[2]) return undefined
  return { text: match[2] }
}

export function parseManagedPlist(json: string): string {
  const raw = JSON.parse(json)
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

/**
 * The MDM profile in `root` (/Library/Managed Preferences): the user's own, then the computer's. It gets the same
 * trust check as a managed file, and a profile Vector cannot convert is reported, not dropped.
 */
export function preferences(root: string, options: TrustOptions = {}): Policy | Ignored | undefined {
  const user = (() => {
    try {
      return os.userInfo().username || "user"
    } catch {
      return "user"
    }
  })()
  const plist = MANAGED_PLIST_DOMAINS.flatMap((domain) => [
    path.join(root, user, `${domain}.plist`),
    path.join(root, `${domain}.plist`),
  ]).find((file) => existsSync(file))
  if (!plist) return undefined
  const source = `mobileconfig:${plist}`
  const verdict = check(plist, options)
  if (verdict) return { source, ...verdict }
  const result = spawnSync(PLUTIL, ["-convert", "json", "-o", "-", plist], {
    encoding: "utf8",
    timeout: 10_000,
    env: {},
  })
  if (result.status !== 0)
    return {
      source,
      reason: `Vector could not read ${plist}: ${result.error?.message ?? (result.stderr.trim() || `plutil exited with ${result.status}`)}`,
      kind: "unreadable",
    }
  return { source, text: parseManagedPlist(result.stdout) }
}

// The MDM profile and the policy key change only through the operating system's own tools, so they are read once per
// process unless a periodic reader explicitly calls refresh(); running a tool on every startup read would slow each
// start on a company computer.
const policyCache: { value?: readonly (Policy | Ignored)[] } = {}

function systemPolicies() {
  policyCache.value ??= [
    process.platform === "darwin" ? preferences(MANAGED_PREFERENCES) : undefined,
    process.platform === "win32" ? registry() : undefined,
  ].filter((item) => item !== undefined)
  return policyCache.value
}

// `reg query` prints in the console's code page, so text outside ASCII belongs in \u escapes inside the JSON.
function registry(): Policy | Ignored | undefined {
  const source = `registry:${REGISTRY_KEY}`
  const query = (key: string) =>
    spawnSync(REG, ["query", key, "/reg:64"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: { SystemRoot: WINDOWS },
    })
  const key = query(REGISTRY_KEY)
  if (key.status === 0) {
    const value = parseRegistry(key.stdout)
    if (!value) return undefined
    if ("text" in value) return { source, text: value.text }
    return { source, reason: value.reason, kind: "unreadable" }
  }
  // reg exits with 1 both when the key is missing and when it fails. The key above it always exists, so its list of
  // keys tells the two apart.
  const parent = query(REGISTRY_PARENT)
  if (parent.status === 0 && !REGISTRY_LISTED.test(parent.stdout)) return undefined
  return {
    source,
    reason: `Vector could not read ${REGISTRY_KEY}: ${key.error?.message ?? (key.stderr.trim() || `reg exited with ${key.status}`)}`,
    kind: "unreadable",
  }
}

/**
 * Why a managed file cannot be trusted and what that means (`untrusted`: left out; `unreadable`: it may hold company
 * policy, so Vector Local stays on with Web access None), or undefined when only an administrator could have changed
 * it, or it does not exist.
 */
export function check(file: string, options: TrustOptions = {}): Verdict | undefined {
  if (!existsSync(file)) return undefined
  // The file system can still refuse (a folder above the file that Vector may not search) or change underneath it (a
  // file removed mid-check). A file Vector cannot check is one it cannot trust, and it may hold company policy.
  try {
    if ((options.platform ?? process.platform) === "win32")
      return windowsCheck(file, options.acl ?? powershellAcl, options.user === true)
    return posixCheck(file, options)
  } catch (cause) {
    return {
      reason: `Vector could not check who may change ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      kind: "unreadable",
    }
  }
}

function posixCheck(file: string, options: TrustOptions): Verdict | undefined {
  const owners = options.user === true && process.getuid ? [0, process.getuid()] : [0]
  // The folder that holds the file and the file it resolves to, each with every folder above it: a link in the
  // managed folder could point anywhere, and a folder someone else can write lets them swap the file.
  const chain = [...new Set([...ancestors(realpathSync(file)), ...ancestors(realpathSync(path.dirname(file)))])]
  const entries = chain.map((target) => ({ target, stat: statSync(target) }))
  const reason = entries
    .map((entry) => posixReason({ path: entry.target, uid: entry.stat.uid, mode: entry.stat.mode }, owners))
    .find((item) => item !== undefined)
  if (reason) return { reason, kind: "untrusted" }
  if ((options.platform ?? process.platform) !== "darwin") return undefined
  const listed = cachedListing(options.macAcl ?? lsAcl, entries)
  if (listed.status !== 0)
    return {
      reason: `Vector could not read who may change ${chain[0]}: ${listed.error?.message ?? (listed.stderr.trim() || `ls exited with ${listed.status}`)}`,
      kind: "unreadable",
    }
  const acl = macAclReason(listed.stdout, chain)
  return acl === undefined ? undefined : { reason: acl, kind: "untrusted" }
}

const lsAcl: MacAclReader = (paths) =>
  spawnSync(LS, ["-lde", ...paths], { encoding: "utf8", timeout: 10_000, env: { LC_ALL: "C" } })

// ls takes a moment and blocks the thread that runs it, and the desktop's main process reads company policy every half
// minute, so a listing is kept until a path in the chain changes: changing an access control list updates a file's
// change time, as changing its owner or mode does. A listing that failed is never kept.
const listingCache = new WeakMap<MacAclReader, Map<string, ReturnType<MacAclReader>>>()

function cachedListing(reader: MacAclReader, entries: readonly { readonly target: string; readonly stat: Stats }[]) {
  const known = listingCache.get(reader) ?? new Map<string, ReturnType<MacAclReader>>()
  listingCache.set(reader, known)
  const key = entries
    .map(
      (entry) =>
        `${entry.target}:${entry.stat.ino}:${entry.stat.uid}:${entry.stat.mode}:${entry.stat.size}:${entry.stat.mtimeMs}:${entry.stat.ctimeMs}`,
    )
    .join("|")
  const cached = known.get(key)
  if (cached) return cached
  const listed = reader(entries.map((entry) => entry.target))
  if (listed.status === 0) known.set(key, listed)
  return listed
}

function ancestors(target: string): string[] {
  const parent = path.dirname(target)
  if (parent === target) return [target]
  return [target, ...ancestors(parent)]
}

const aclCache = new WeakMap<AclReader, Map<string, ReturnType<AclReader>>>()

function windowsCheck(file: string, reader: AclReader, user: boolean): Verdict | undefined {
  const folder = path.dirname(file)
  const acl = cachedAcl(reader, [folder, file])
  const owners = [SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER, ...(user && acl.user ? [acl.user] : [])]
  return (
    [
      [folder, "folder"],
      [file, "file"],
    ] as const
  )
    .map(([target, kind]): Verdict | undefined => {
      const entry = acl.entries[target]
      if (!entry) return { reason: `Vector could not read who may change ${target}.`, kind: "unreadable" }
      const reason = windowsReason(target, entry, kind, owners)
      return reason === undefined ? undefined : { reason, kind: "untrusted" }
    })
    .find((verdict) => verdict !== undefined)
}

// PowerShell takes a moment to start, so a complete read is kept until a path changes. Failed or partial reads stay
// fail-closed for this check but are read again next time, just like a failed macOS access list lookup.
function cachedAcl(reader: AclReader, paths: readonly string[]) {
  const known = aclCache.get(reader) ?? new Map<string, ReturnType<AclReader>>()
  aclCache.set(reader, known)
  const key = paths
    .map((target) => {
      const stat = statSync(target)
      return `${target}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    })
    .join("|")
  const cached = known.get(key)
  if (cached) return cached
  const result = reader(paths)
  if (paths.every((target) => result.entries[target] !== undefined)) known.set(key, result)
  return result
}

/**
 * Reads the output of ACL_SCRIPT: "U <sid>" for the user running Vector, "O <index> <sid>" for the owner of the path at
 * that index, and "R <index> <sid> <rights> <allow 0|1> <inherit-only 0|1>" for each of its access rules. A path with
 * no owner line could not be read.
 */
export function parseAcl(stdout: string, paths: readonly string[]): ReturnType<AclReader> {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
  const entry = (index: number) => {
    const owner = lines.find((line) => line[0] === "O" && line[1] === String(index))?.[2]
    if (!owner) return undefined
    return {
      owner,
      rules: lines
        .filter((line) => line[0] === "R" && line[1] === String(index) && line.length === 6)
        .map((line) => ({
          sid: line[2]!,
          rights: Number(line[3]),
          allow: line[4] === "1",
          inheritOnly: line[5] === "1",
        }))
        .filter((rule) => Number.isInteger(rule.rights)),
    }
  }
  return {
    user: lines.find((line) => line[0] === "U")?.[1],
    entries: Object.fromEntries(paths.map((target, index) => [target, entry(index)])),
  }
}

// Owner and rules as SIDs, so the check does not depend on the language Windows names its accounts in. It calls .NET
// directly and no cmdlet, so a module of the user's earlier in PSModulePath cannot stand in for one, and the paths
// arrive one per line in a variable, not in the script.
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sid = [System.Security.Principal.SecurityIdentifier]",
  "[Console]::Out.WriteLine('U ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
  "$i = 0",
  "foreach ($p in ($env:VECTOR_ACL_PATHS -split [char]10)) {",
  "  try {",
  "    $acl = if ([System.IO.Directory]::Exists($p)) { [System.IO.Directory]::GetAccessControl($p) } else { [System.IO.File]::GetAccessControl($p) }",
  "    [Console]::Out.WriteLine('O ' + $i + ' ' + $acl.GetOwner($sid).Value)",
  "    foreach ($r in $acl.GetAccessRules($true, $true, $sid)) {",
  "      [Console]::Out.WriteLine('R ' + $i + ' ' + $r.IdentityReference.Value + ' ' + $r.FileSystemRights.value__ + ' ' + [int]($r.AccessControlType -eq 'Allow') + ' ' + [int](([int]$r.PropagationFlags -band 2) -ne 0))",
  "    }",
  "  } catch {}",
  "  $i++",
  "}",
].join("\n")

function powershellAcl(paths: readonly string[]): ReturnType<AclReader> {
  // Only what PowerShell needs: the user's own variables could load code into it (COR_PROFILER) or lock it down.
  const result = spawnSync(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ACL_SCRIPT, "utf16le").toString("base64")],
    {
      encoding: "utf8",
      env: { SystemRoot: WINDOWS, windir: WINDOWS, SystemDrive: "C:", VECTOR_ACL_PATHS: paths.join("\n") },
      timeout: 20_000,
      windowsHide: true,
    },
  )
  if (result.status !== 0) return { entries: {} }
  return parseAcl(result.stdout, paths)
}
