export * as VaultGitHub from "./github"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Vault } from "@vectordevai/schema/vault"
import { VaultError } from "./error"
import { VaultRecovery } from "./recovery"
import type { VaultStore } from "./store"

// Brain Vault's free backend: a private GitHub repository the person owns, written over git with their own git
// credentials, so nothing goes to Vector. The repository must hold nothing but the vault, and it is checked to be
// private before every push: GitHub's API answers an unauthenticated read of a public repository, and 404 for one it
// will not show, so anything but 404 (or an answer that says private) refuses the push. Every push is one commit with
// no parent, sent with a lease on the commit it replaces, so a forgotten version and the pieces only it named leave
// the branch, and two computers backing up at once cannot overwrite each other. The local copy is a bare repository in
// Vector's cache; nothing is checked out.
//
// In the repository: vault.json (the wrapped key), versions/<id> (sealed manifests), versions/<id>.json (the size and
// object count of each, for listing without the key), objects/<aa>/<id> (sealed chunks) and a README.

/** How the caller runs git: the engine's Git.run (Vector Local decides each command that connects), or a test's. */
export type Git = (
  args: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: Uint8Array | string },
) => Promise<{ readonly exitCode: number; readonly stdout: Buffer; readonly stderr: string }>

/** How the caller sends the privacy check (the engine labels it brain-vault). */
export type Send = (url: string, init: RequestInit) => Promise<Response>

const BRANCH = "refs/heads/main"
const LOCAL = "refs/vault/main"
const README = `# Brain Vault\n\nEncrypted backups of a Vector Brain, made by \`vector vault backup --github\`.\n\nEverything here is encrypted on the computer that made it. Keep this repository private, and keep your recovery\ncode: without it these backups cannot be restored, by you or by anyone else.\n`
const DELETED = `# Brain Vault\n\nThis vault was deleted. Delete the repository on GitHub to remove its history too.\n`
const IDENTITY = {
  GIT_AUTHOR_NAME: "Vector Brain Vault",
  GIT_AUTHOR_EMAIL: "vault@vectordev.invalid",
  GIT_COMMITTER_NAME: "Vector Brain Vault",
  GIT_COMMITTER_EMAIL: "vault@vectordev.invalid",
}
const EMPTY_SHA = "0000000000000000000000000000000000000000"

const KeyFile = Schema.Struct({
  format: Schema.Literal("vector-vault-store"),
  version: Schema.Literal(1),
  key: Schema.Unknown,
})

/** `owner/repo` as GitHub names it, or undefined. */
export function parseRepo(input: string) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(input.trim())
  if (!match || match[2] === "." || match[2] === ".." || match[2]!.endsWith(".git")) return undefined
  return { owner: match[1]!, name: match[2]!, full: `${match[1]}/${match[2]}` }
}

/**
 * Whether GitHub shows `repo` to someone who is not signed in. Throws `public-repo` for a public repository and for any
 * answer that does not prove it private (a rate limit, an outage, a redirect after a rename).
 */
export async function checkPrivate(input: { readonly api: string; readonly repo: string; readonly send: Send }) {
  let blocked: string | undefined
  const response = await input
    .send(`${input.api.replace(/\/+$/, "")}/repos/${input.repo}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "vector-brain-vault" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    .catch((error: unknown) => {
      // Vector Local's refusal says why; any other failure reads as "could not check".
      if (error instanceof Error && error.name === "EgressBlocked") blocked = error.message
      return undefined
    })
  if (blocked) throw new VaultError("public-repo", `${blocked} Brain Vault checks a repository is private before each push, so nothing was sent.`)
  if (response?.status === 404) return
  if (response?.status === 200) {
    const body = (await response.json().catch(() => undefined)) as { private?: unknown } | undefined
    if (body?.private === true) return
    throw new VaultError(
      "public-repo",
      `${input.repo} is public. Brain Vault backs up only to a private repository; make it private or choose another.`,
    )
  }
  throw new VaultError(
    "public-repo",
    `Vector could not check that ${input.repo} is private${response ? ` (GitHub answered ${response.status})` : ""}, so nothing was sent. Try again shortly.`,
  )
}

type Entry = { readonly sha: string; readonly size: number }

export function store(options: {
  /** owner/repo */
  readonly repo: string
  /** The git URL to fetch and push, built by the caller. */
  readonly remote: string
  /** GitHub's API, for the privacy check. */
  readonly api: string
  /** The local bare repository. */
  readonly dir: string
  readonly git: Git
  readonly send: Send
  readonly keep?: number
}): VaultStore.Store {
  const repo = parseRepo(options.repo)
  if (!repo) throw new VaultError("unavailable", "Name the repository as owner/repo.")
  const label = `your GitHub repository ${repo.full}`
  const git = (args: readonly string[], more?: Parameters<Git>[1]) => options.git([`--git-dir=${options.dir}`, ...args], more)
  const index = path.join(options.dir, "vault-index")

  let tip: string | undefined
  let tree: Map<string, Entry> | undefined
  // What this run wrote and has not pushed: path → blob sha.
  const staged = new Map<string, string>()

  const failed = (what: string, result: { stderr: string }) => {
    const line = result.stderr.split(/\r?\n/).find((item) => item.trim())?.trim()
    return new VaultError("unavailable", `${what}${line ? `: ${line.slice(0, 200)}` : "."}`)
  }

  const init = async () => {
    const exists = await fs
      .stat(path.join(options.dir, "HEAD"))
      .then(() => true)
      .catch(() => false)
    if (exists) return
    await fs.mkdir(options.dir, { recursive: true })
    const result = await options.git(["init", "--bare", "-q", options.dir])
    if (result.exitCode !== 0) throw failed("Vector could not set up its copy of the vault", result)
  }

  // The branch as GitHub has it now, fetched into the local copy. Read once per store, and again after each push.
  const sync = async () => {
    if (tree) return tree
    await init()
    const listed = await git(["ls-remote", options.remote, BRANCH])
    if (listed.exitCode !== 0)
      throw failed(`Vector could not reach ${repo.full}. Check that it exists and that git can push to it`, listed)
    tip = listed.stdout.toString("utf8").trim().split(/\s+/)[0] || undefined
    const next = new Map<string, Entry>()
    if (tip) {
      const fetched = await git(["fetch", "--no-tags", "-q", options.remote, `+${BRANCH}:${LOCAL}`])
      if (fetched.exitCode !== 0) throw failed(`Vector could not fetch ${repo.full}`, fetched)
      const resolved = (await git(["rev-parse", LOCAL])).stdout.toString("utf8").trim()
      if (resolved !== tip) throw new VaultError("unavailable", `${repo.full} changed while Vector read it. Try again.`)
      const ls = await git(["ls-tree", "-r", "-l", "-z", LOCAL])
      if (ls.exitCode !== 0) throw failed(`Vector could not read ${repo.full}`, ls)
      for (const record of ls.stdout.toString("utf8").split("\0")) {
        if (!record) continue
        const tab = record.indexOf("\t")
        const [, type, sha, size] = record.slice(0, tab).trim().split(/\s+/)
        if (type !== "blob" || !sha) continue
        next.set(record.slice(tab + 1), { sha, size: Number(size) || 0 })
      }
      // An empty repository, or one holding only a README (a new repository's, or a deleted vault's), may take a vault.
      const foreign = [...next.keys()].filter((name) => !vaultPath(name))
      if (foreign.length || (!next.has("vault.json") && [...next.keys()].some((name) => name !== "README.md")))
        throw new VaultError(
          "exists",
          `${repo.full} holds files that are not a Brain Vault. Use an empty private repository of its own for the vault.`,
        )
    }
    tree = next
    return next
  }

  const blob = async (input: Uint8Array | string) => {
    const result = await git(["hash-object", "-w", "--stdin"], { input })
    if (result.exitCode !== 0) throw failed("Vector could not write the backup to its copy of the vault", result)
    return result.stdout.toString("utf8").trim()
  }

  const cat = async (name: string) => {
    const result = await git(["cat-file", "blob", `${LOCAL}:${name}`])
    if (result.exitCode !== 0) throw new VaultError("not-found", `${repo.full} has no ${name}.`)
    return result.stdout
  }

  // One commit with no parent holding the branch's tree with `changes` applied (a sha writes, undefined removes),
  // pushed only if the branch is still the commit this store read, after the privacy check.
  const push = async (changes: ReadonlyMap<string, string | undefined>, message: string) => {
    const current = await sync()
    await checkPrivate({ api: options.api, repo: repo.full, send: options.send })
    const env = { GIT_INDEX_FILE: index }
    await fs.rm(index, { force: true })
    const read = await git(tip ? ["read-tree", LOCAL] : ["read-tree", "--empty"], { env })
    if (read.exitCode !== 0) throw failed("Vector could not prepare the backup", read)
    const lines = [...changes].map(([name, sha]) =>
      sha ? `100644 ${sha}\t${name}` : current.has(name) ? `0 ${EMPTY_SHA}\t${name}` : undefined,
    )
    const info = lines.filter((line): line is string => line !== undefined).join("\n")
    if (info) {
      const updated = await git(["update-index", "--index-info"], { env, input: `${info}\n` })
      if (updated.exitCode !== 0) throw failed("Vector could not prepare the backup", updated)
    }
    const written = await git(["write-tree"], { env })
    if (written.exitCode !== 0) throw failed("Vector could not prepare the backup", written)
    // The vault's commits are not the person's: no signing prompt, no hooks of theirs.
    const commit = await git(["-c", "commit.gpgsign=false", "commit-tree", written.stdout.toString("utf8").trim(), "-m", message], {
      env: { ...env, ...IDENTITY },
    })
    if (commit.exitCode !== 0) throw failed("Vector could not prepare the backup", commit)
    const sha = commit.stdout.toString("utf8").trim()
    const pushed = await git([
      "-c",
      `core.hooksPath=${path.join(options.dir, "no-hooks")}`,
      "push",
      "-q",
      `--force-with-lease=${BRANCH}:${tip ?? ""}`,
      options.remote,
      `${sha}:${BRANCH}`,
    ])
    await fs.rm(index, { force: true })
    if (pushed.exitCode !== 0) {
      tree = undefined
      if (/stale info|rejected|fetch first|non-fast-forward/i.test(pushed.stderr))
        throw new VaultError("unavailable", `${repo.full} changed while Vector backed up (another computer?). Run it again.`)
      throw failed(`git could not push to ${repo.full}`, pushed)
    }
    await git(["update-ref", LOCAL, sha])
    tip = sha
    tree = undefined
    staged.clear()
  }

  const snapshotOf = async (version: string, current: Map<string, Entry>): Promise<Vault.Snapshot> => {
    const side = current.has(`versions/${version}.json`)
      ? await cat(`versions/${version}.json`)
          .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
          .catch(() => undefined)
      : undefined
    const decoded = Schema.decodeUnknownOption(Vault.Snapshot)(side)
    if (Option.isSome(decoded) && decoded.value.id === version) return decoded.value
    return { id: version, createdAt: Number(version.slice(1, 14)), bytes: current.get(`versions/${version}`)?.size ?? 0, objects: 0 }
  }

  const self: VaultStore.Store = {
    label,
    keep: options.keep ?? Vault.LIMIT.githubVersions,
    readKey: async () => {
      const current = await sync()
      const pending = staged.get("vault.json")
      if (!pending && !current.has("vault.json")) return undefined
      const bytes = pending
        ? (await git(["cat-file", "blob", pending])).stdout
        : await cat("vault.json")
      const file = Schema.decodeUnknownOption(KeyFile)(
        (() => {
          try {
            return JSON.parse(bytes.toString("utf8")) as unknown
          } catch {
            return undefined
          }
        })(),
      )
      if (Option.isNone(file)) throw new VaultError("damaged", `The vault's key record in ${repo.full} is damaged.`)
      return VaultRecovery.decodeWrapped(file.value.key)
    },
    writeKey: async (key) => {
      await sync()
      if (staged.has("vault.json") || tree?.has("vault.json")) {
        const held = await self.readKey()
        if (held && held.vault !== key.vault) throw new VaultError("exists", `${repo.full} already holds another vault.`)
        if (held) return
      }
      staged.set("vault.json", await blob(`${JSON.stringify({ format: "vector-vault-store", version: 1, key }, null, 2)}\n`))
      staged.set("README.md", await blob(README))
    },
    prepare: async (_version, objects) => {
      const current = await sync()
      return new Set(objects.filter((ref) => !current.has(objectPath(ref.id)) && !staged.has(objectPath(ref.id))).map((ref) => ref.id))
    },
    putObject: async (_version, id, bytes) => {
      staged.set(objectPath(id), await blob(bytes))
    },
    commit: async (version, manifest, objects, prune) => {
      const current = await sync()
      if (!staged.has("vault.json") && !current.has("vault.json"))
        throw new VaultError("not-found", `${repo.full} holds no vault key; Vector writes it with the first backup.`)
      const missing = objects.filter((ref) => !current.has(objectPath(ref.id)) && !staged.has(objectPath(ref.id)))
      if (missing.length) throw new VaultError("size-mismatch", "A piece of this backup was not written.")
      const sizes = new Map(objects.map((ref) => [ref.id, ref.size]))
      const snapshot: Vault.Snapshot = {
        id: version,
        createdAt: Number(version.slice(1, 14)),
        bytes: manifest.byteLength + [...sizes.values()].reduce((sum, size) => sum + size, 0),
        objects: objects.length,
      }
      const changes = new Map<string, string | undefined>(staged)
      changes.set(`versions/${version}`, await blob(manifest))
      changes.set(`versions/${version}.json`, await blob(`${JSON.stringify(snapshot)}\n`))
      for (const id of prune?.versions ?? []) {
        changes.set(`versions/${id}`, undefined)
        changes.set(`versions/${id}.json`, undefined)
      }
      for (const id of prune?.objects ?? []) if (!sizes.has(id)) changes.set(objectPath(id), undefined)
      await push(changes, `Brain Vault backup ${version}`)
      return snapshot
    },
    list: async () => {
      const current = await sync()
      const versions = [...current.keys()]
        .map((name) => /^versions\/(v\d{13}-[0-9a-f]{8})$/.exec(name)?.[1])
        .filter((id): id is string => id !== undefined)
        .toSorted((a, b) => b.localeCompare(a))
      const snapshots = await Promise.all(versions.map((version) => snapshotOf(version, current)))
      const storedBytes = [...current]
        .filter(([name]) => name.startsWith("objects/") || name.startsWith("versions/"))
        .reduce((sum, [, entry]) => sum + entry.size, 0)
      return { snapshots, storedBytes }
    },
    readManifest: async (version) => {
      const current = await sync()
      if (!current.has(`versions/${version}`)) throw new VaultError("not-found", `No backup version ${version}.`)
      return cat(`versions/${version}`)
    },
    readObjects: async (_version, ids) => {
      await sync()
      const found = new Map<string, Uint8Array>()
      if (!tip || ids.length === 0) return found
      const result = await git(["cat-file", "--batch"], {
        input: `${ids.map((id) => `${LOCAL}:${objectPath(id)}`).join("\n")}\n`,
      })
      if (result.exitCode !== 0) throw failed(`Vector could not read ${repo.full}`, result)
      let offset = 0
      for (const id of ids) {
        const end = result.stdout.indexOf(0x0a, offset)
        if (end < 0) break
        const head = result.stdout.subarray(offset, end).toString("utf8")
        offset = end + 1
        const match = /^[0-9a-f]{40,64} blob (\d+)$/.exec(head)
        if (!match) continue
        const size = Number(match[1])
        found.set(id, Buffer.from(result.stdout.subarray(offset, offset + size)))
        offset += size + 1
      }
      return found
    },
    forget: async (version, prune) => {
      const current = await sync()
      if (!current.has(`versions/${version}`)) throw new VaultError("not-found", `No backup version ${version}.`)
      const changes = new Map<string, string | undefined>([
        [`versions/${version}`, undefined],
        [`versions/${version}.json`, undefined],
      ])
      for (const id of prune?.objects ?? []) changes.set(objectPath(id), undefined)
      await push(changes, `Brain Vault forgets ${version}`)
    },
    destroy: async () => {
      const current = await sync()
      if (!tip) return
      const changes = new Map<string, string | undefined>([...current.keys()].map((name) => [name, undefined]))
      changes.set("README.md", await blob(DELETED))
      await push(changes, "Brain Vault deleted")
    },
    objects: async () => {
      const current = await sync()
      const names = [...current.keys(), ...staged.keys()]
      return new Set(
        names.map((name) => /^objects\/[0-9a-f]{2}\/([0-9a-f]{64})$/.exec(name)?.[1]).filter((id): id is string => !!id),
      )
    },
  }
  return self
}

function objectPath(id: string) {
  return `objects/${id.slice(0, 2)}/${id}`
}

function vaultPath(name: string) {
  return (
    name === "README.md" ||
    name === "vault.json" ||
    /^versions\/v\d{13}-[0-9a-f]{8}(\.json)?$/.test(name) ||
    /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(name)
  )
}
