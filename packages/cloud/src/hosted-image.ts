// The image workflow's steps that need code (contract WP A58, §6.2 `vector-hosted-image.yml`; the image itself is WP
// A54's packages/hosted-computer). The workflow runs in the protected hosted-production environment:
// - `cli`: puts the Vector CLI for Linux (musl, x86-64) at packages/hosted-computer/bin/vector, from a release already
//   published to Vector's download store, by exact version, never a moving tag. The manifest is decoded with the same
//   rules every installer uses, the archive's size and SHA-256 must match it, the archive may hold only the binary and
//   its notices, and the binary must be an x86-64 ELF. It writes the release's source commit to GITHUB_OUTPUT, so the
//   workflow can require it on protected main as well.
// - `login`: signs Docker in to the hosted team's container registry with the Vercel CLI the budget workflow pins
//   (`vercel vcr login docker`), the token in the environment only and the CLI's output never echoed.
// - `tag`: the registry tag for one image generation, from the owner's repository variable, checked.
// - `digest`: the pushed image's digest reference in that repository, from `docker inspect` (stdin), for the bake.

import { appendFile, chmod, copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extract, list } from "tar"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { cliNotices } from "./cli-release-package"
import { vercelCli, type Cli } from "./hosted-budget"

/** The computers are x86-64 (the hosted provider builds and runs linux/amd64), on the same target the CLI container uses. */
export const IMAGE_CLI_TARGET = "linux-x64-baseline-musl" satisfies CliRelease.Target
/** The hosted team's registry. The image is named in the owner's repository: vcr.vercel.com/<team>/<project>/<name>. */
export const REGISTRY = "vcr.vercel.com"
// Lower-case letters, digits, dots and hyphens only: bake-snapshot.ts accepts nothing else in an image reference.
const REPOSITORY = /^vcr\.vercel\.com\/[a-z0-9][a-z0-9-]{0,99}\/[a-z0-9][a-z0-9-]{0,99}\/[a-z0-9][a-z0-9.-]{0,99}$/
const GENERATION = /^[1-9][0-9]{0,5}$/

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

async function body(fetcher: Fetcher, url: string, limit: number) {
  const response = await fetcher(url, { redirect: "error", headers: { accept: "*/*" } })
  if (response.status !== 200) throw new Error(`Vector's download store answered ${response.status} for ${url}.`)
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (declared > limit) throw new Error(`${url} is larger than expected.`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limit) throw new Error(`${url} is larger than expected.`)
  return bytes
}

/** Checks the release archive against its manifest entry and writes only its `vector` binary to `output`. */
export async function unpackImageCli(input: { bytes: Uint8Array; asset: CliRelease.Asset; output: string }) {
  const { bytes, asset } = input
  if (bytes.byteLength !== asset.size || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error("The CLI archive does not match its release manifest.")
  if (await stat(input.output).then(() => true, () => false))
    throw new Error(`${input.output} already exists; start from a clean checkout.`)
  const temporary = await mkdtemp(path.join(os.tmpdir(), "vector-image-cli-"))
  try {
    const archive = path.join(temporary, "verified.tar.gz")
    await Bun.write(archive, bytes)
    const expected: readonly string[] = ["vector", ...cliNotices]
    const seen: string[] = []
    let invalid = false
    await list({
      file: archive,
      strict: true,
      onReadEntry: (entry) => {
        if (
          !expected.includes(entry.path) ||
          seen.includes(entry.path) ||
          entry.type !== "File" ||
          entry.size <= 0 ||
          entry.size > CliRelease.MAX_ARCHIVE_BYTES
        )
          invalid = true
        if (seen.length < expected.length + 1) seen.push(entry.path)
      },
    })
    if (invalid || seen.length !== expected.length) throw new Error("The CLI archive holds something besides the binary and its notices.")
    const unpacked = path.join(temporary, "unpacked")
    await mkdir(unpacked)
    await extract({ file: archive, cwd: unpacked, strict: true, preservePaths: false })
    const binary = path.join(unpacked, "vector")
    const header = await Bun.file(binary).slice(0, 64).bytes()
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    if (header.length < 64 || view.getUint32(0, false) !== 0x7f454c46 || header[4] !== 2 || header[5] !== 1 || view.getUint16(18, true) !== 62)
      throw new Error("The CLI binary is not a 64-bit x86 Linux program.")
    await mkdir(path.dirname(input.output), { recursive: true })
    await copyFile(binary, input.output)
    await chmod(input.output, 0o755)
    return { sha256: asset.sha256 }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** The published release's x86-64 musl CLI, by exact version, checked; answers the release's source commit. */
export async function fetchImageCli(input: { origin: string; version: string; output: string; fetcher: Fetcher }) {
  if (!/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com$/.test(input.origin))
    throw new Error("Set VECTOR_CLI_BLOB_ORIGIN to Vector's download store.")
  // An exact version only: a channel name ("latest", "beta") moves, and archivePath refuses it.
  try {
    CliRelease.archivePath(input.version, IMAGE_CLI_TARGET)
  } catch {
    throw new Error("Name an exact published CLI version, such as 1.99.120.")
  }
  const manifestUrl = `${input.origin}/${CliRelease.manifestPath(input.version)}`
  const text = new TextDecoder().decode(await body(input.fetcher, manifestUrl, CliRelease.MAX_MANIFEST_BYTES))
  const manifest = CliRelease.decode(JSON.parse(text), input.origin)
  if (manifest.version !== input.version) throw new Error("The CLI release manifest names another version.")
  const asset = CliRelease.select(manifest, IMAGE_CLI_TARGET)
  const bytes = await body(input.fetcher, asset.url, asset.size)
  const unpacked = await unpackImageCli({ bytes, asset, output: input.output })
  return { version: manifest.version, sourceRevision: manifest.sourceRevision, sha256: unpacked.sha256 }
}

/** The owner's registry repository, checked: vcr.vercel.com/<team>/<project>/<name>, nothing else. */
export function registryRepository(value: string | undefined) {
  const repository = value?.trim() ?? ""
  return REPOSITORY.test(repository) ? repository : undefined
}

/** The tag for one generation. Each generation is pushed once; the workflow refuses a tag the registry already has. */
export function imageTag(repository: string, generation: string) {
  const checked = registryRepository(repository)
  if (!checked) throw new Error("The registry repository is not vcr.vercel.com/<team>/<project>/<name>.")
  if (!GENERATION.test(generation)) throw new Error("The generation must be a whole number from 1.")
  return `${checked}:g${generation}`
}

/** The digest reference the push produced, from `docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}'`. */
export function pickDigest(repository: string, output: string) {
  const found = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${repository}@sha256:`) && /@sha256:[a-f0-9]{64}$/.test(line))
  return found.length === 1 ? found[0] : undefined
}

/** `vercel vcr login docker` with the hosted team's token in the environment, its output never echoed. */
export async function loginRegistry(input: { token: string; team: string; project: string; cli?: Cli }) {
  if (!input.token) throw new Error("VECTOR_HOSTED_VERCEL_TOKEN is not set in hosted-production.")
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(input.team) || !/^[A-Za-z0-9_-]{4,128}$/.test(input.project))
    throw new Error("Set VECTOR_HOSTED_VERCEL_TEAM_ID and VECTOR_HOSTED_VERCEL_PROJECT_ID in hosted-production.")
  // The CLI links the hosted project from VERCEL_ORG_ID and VERCEL_PROJECT_ID, which the workflow step sets.
  const result = await (input.cli ?? vercelCli(input.token))(["vcr", "login", "docker"])
  if (result.code !== 0) throw new Error("The Vercel CLI could not sign Docker in to the hosted team's registry.")
}

async function main(argv: readonly string[]) {
  const [command] = argv
  const env = process.env
  if (command === "cli") {
    const at = argv.indexOf("--output")
    const output = at >= 0 ? argv[at + 1] : undefined
    if (!output) throw new Error("Pass --output <path>.")
    const result = await fetchImageCli({
      origin: env.VECTOR_CLI_BLOB_ORIGIN?.trim() ?? "",
      version: env.VECTOR_HOSTED_CLI_VERSION?.trim() ?? "",
      output: path.resolve(output),
      fetcher: (url, init) => fetch(url, init),
    })
    console.log(`Vector CLI ${result.version} (${IMAGE_CLI_TARGET}, sha256 ${result.sha256}) from source ${result.sourceRevision}.`)
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `source=${result.sourceRevision}\n`)
    return 0
  }
  if (command === "login") {
    await loginRegistry({
      token: env.VECTOR_HOSTED_VERCEL_TOKEN?.trim() ?? "",
      team: env.VERCEL_ORG_ID?.trim() ?? "",
      project: env.VERCEL_PROJECT_ID?.trim() ?? "",
    })
    console.log("Docker is signed in to the hosted team's registry.")
    return 0
  }
  if (command === "tag") {
    console.log(imageTag(env.VECTOR_HOSTED_IMAGE_REPOSITORY ?? "", env.VECTOR_IMAGE_GENERATION ?? ""))
    return 0
  }
  if (command === "digest") {
    const repository = registryRepository(env.VECTOR_HOSTED_IMAGE_REPOSITORY)
    const digest = repository && pickDigest(repository, await new Response(Bun.stdin.stream()).text())
    if (!digest) throw new Error("The pushed image has no single digest in the hosted team's registry.")
    console.log(digest)
    return 0
  }
  throw new Error("Usage: bun hosted-image.ts cli --output <path> | login | tag | digest")
}

if (import.meta.main)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error((error as Error).message)
      process.exit(1)
    },
  )
