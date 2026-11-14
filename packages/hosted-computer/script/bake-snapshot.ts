import type { Sandbox } from "@vercel/sandbox"
import { randomBytes } from "node:crypto"
import { IMAGE_MAX_BYTES } from "../src/limits"

/*
 * Bakes the cloud computer's base snapshot (contract WP A54; the image workflow, WP A58, runs it in the protected
 * hosted-production environment). It starts one sandbox on the hosted team from the image just pushed, pinned by
 * digest, with no network at all, checks the image there (generation, the base archive against the digest boot.sh was
 * stamped with, no setuid file, no sudo, the agent's uid, at most 6 GB on disk), stops it so the provider saves its
 * disk, and prints the snapshot id for VECTOR_HOSTED_BASE_SNAPSHOT.
 *
 * The bake sandbox is never tagged `vector-mode`, so the reconciler (WP A52) never takes it for a subscriber's computer.
 * It runs only when someone starts it, with the hosted team's own settings; nothing in the repository holds them.
 *
 *   bun script/bake-snapshot.ts --image <registry image>@sha256:<digest> --generation <n>
 *   (VECTOR_HOSTED_VERCEL_TOKEN, VECTOR_HOSTED_VERCEL_TEAM_ID, VECTOR_HOSTED_VERCEL_PROJECT_ID)
 */

export type BakeSdk = Pick<typeof Sandbox, "create">
export type Credentials = { token: string; teamId: string; projectId: string }

const IMAGE = /^[a-z0-9][a-z0-9._/-]{0,250}@sha256:[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9_-]{4,128}$/

/** The check run inside the bake sandbox, as root. Its last line is `ok <bytes on disk>`. */
export function selfCheck(generation: number) {
  return [
    "set -eu",
    `[ "$(cat /usr/lib/vector/GENERATION)" = "${generation}" ]`,
    `stamped=$(sed -n 's/^readonly BASE_SHA256="\\([a-f0-9]\\{64\\}\\)"$/\\1/p' /opt/vector/boot.sh)`,
    `[ -n "$stamped" ]`,
    `[ "$(sha256sum /usr/lib/vector/base/base.tar | cut -d' ' -f1)" = "$stamped" ]`,
    `[ -z "$(find / -xdev -type f -perm /6000 2>/dev/null | head -n 1)" ]`,
    "! command -v sudo >/dev/null 2>&1",
    `[ "$(id -u agent)" = "10001" ]`,
    `bytes=$(du -sxb / | cut -f1)`,
    `[ "$bytes" -le ${IMAGE_MAX_BYTES} ]`,
    `echo "ok $bytes"`,
  ].join("\n")
}

export async function bakeSnapshot(input: {
  sdk: BakeSdk
  credentials: Credentials
  image: string
  generation: number
  log?: (line: string) => void
}) {
  const log = input.log ?? (() => {})
  if (!IMAGE.test(input.image)) throw new Error("The image must be pinned by digest (<image>@sha256:<64 hex>).")
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("The generation must be a positive number.")
  const { token, teamId, projectId } = input.credentials
  if (!token || !ID.test(teamId) || !ID.test(projectId)) throw new Error("The hosted team's settings are incomplete.")
  const sandbox = await input.sdk.create({
    name: `vector-bake-g${input.generation}-${randomBytes(4).toString("hex")}`,
    image: input.image,
    persistent: true,
    snapshotExpiration: 0,
    resources: { vcpus: 2 },
    timeout: 30 * 60_000,
    region: "iad1",
    ports: [],
    networkPolicy: "deny-all",
    tags: { "vector-bake": String(input.generation) },
    token,
    teamId,
    projectId,
  })
  let stopped = false
  try {
    const check = await sandbox.runCommand({ cmd: "/bin/sh", args: ["-c", selfCheck(input.generation)], sudo: true })
    const output = (await check.stdout()).trim().split("\n").pop() ?? ""
    const match = /^ok (\d+)$/.exec(output)
    if (check.exitCode !== 0 || !match) throw new Error("The image failed its check in the bake sandbox.")
    log(`image checked: ${match[1]} bytes on disk`)
    const result = await sandbox.stop()
    stopped = true
    const snapshot = result.snapshot
    if (!snapshot?.id || snapshot.status !== "created") throw new Error("The provider did not save a snapshot.")
    if (snapshot.sizeBytes > IMAGE_MAX_BYTES) throw new Error("The snapshot is larger than the image may be.")
    return { snapshotId: snapshot.id, sizeBytes: snapshot.sizeBytes }
  } finally {
    if (!stopped) await sandbox.stop().catch(() => {})
  }
}

async function main(argv: string[]) {
  const value = (name: string) => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const image = value("--image") ?? ""
  const generation = Number(value("--generation"))
  const credentials = {
    token: process.env.VECTOR_HOSTED_VERCEL_TOKEN?.trim() ?? "",
    teamId: process.env.VECTOR_HOSTED_VERCEL_TEAM_ID?.trim() ?? "",
    projectId: process.env.VECTOR_HOSTED_VERCEL_PROJECT_ID?.trim() ?? "",
  }
  const { Sandbox } = await import("@vercel/sandbox")
  const baked = await bakeSnapshot({ sdk: Sandbox, credentials, image, generation, log: (line) => console.log(line) })
  console.log(`VECTOR_HOSTED_BASE_SNAPSHOT=${baked.snapshotId}`)
}

if (import.meta.main)
  main(process.argv.slice(2)).catch((error) => {
    console.error((error as Error).message)
    process.exit(1)
  })
