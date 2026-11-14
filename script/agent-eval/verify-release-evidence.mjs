// Bind an offline study to the immutable, published release before executing its bytes.
// GitHub downloads happen in the workflow; this module never reads credentials or makes network requests.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

export async function sha256(file) {
  const hash = createHash("sha256")
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest("hex")
}

export function verifyRun(expected, run) {
  assert.equal(expected.schemaVersion, 1, "Unsupported evidence identity")
  assert.match(expected.sourceSha, /^[a-f0-9]{40}$/, "Missing release source SHA")
  assert.equal(expected.channel, "prod", "A development build is not a release baseline")
  assert.equal(run.id, expected.runId, "Wrong release run")
  assert.equal(run.run_attempt, expected.attempt, "Wrong release attempt")
  assert.equal(run.path, expected.workflow, "Wrong release workflow")
  assert.equal(run.event, "workflow_dispatch", "Unexpected release trigger")
  assert.equal(run.head_branch, "main", "Release must come from main")
  assert.equal(run.head_sha, expected.sourceSha, "Wrong release source")
  assert.equal(run.repository?.id, expected.repositoryId, "Wrong repository")
  assert.equal(run.repository?.full_name, expected.repository, "Wrong repository name")
  assert.equal(run.head_repository?.id, expected.repositoryId, "Fork artifacts are not a release baseline")
  assert.equal(run.status, "completed", "Release is not completed")
  assert.equal(run.conclusion, "success", "Release was not successful")
}

export async function verifyArchive(expected, name, artifact, file) {
  const pinned = expected.artifacts[name]
  assert.ok(pinned, "Unknown release artifact")
  assert.match(pinned.sha256, /^[a-f0-9]{64}$/, "Missing pinned artifact digest")
  assert.equal(artifact.id, pinned.id, "Wrong artifact ID")
  assert.equal(artifact.name, pinned.name, "Wrong artifact name")
  assert.equal(artifact.expired, false, "Release artifact expired; do not silently rebuild it")
  assert.equal(artifact.digest, `sha256:${pinned.sha256}`, "Artifact metadata digest changed")
  assert.equal(artifact.size_in_bytes, pinned.size, "Artifact metadata size changed")
  assert.equal(artifact.workflow_run?.id, expected.runId, "Artifact belongs to a different run")
  assert.equal(artifact.workflow_run?.head_sha, expected.sourceSha, "Artifact belongs to different source")
  assert.equal(artifact.workflow_run?.head_branch, "main", "Artifact did not come from main")
  assert.equal(artifact.workflow_run?.repository_id, expected.repositoryId, "Artifact belongs to another repository")
  assert.equal(artifact.workflow_run?.head_repository_id, expected.repositoryId, "Artifact came from a fork")
  assert.equal((await stat(file)).size, pinned.size, "Downloaded archive size differs")
  assert.equal(await sha256(file), pinned.sha256, "Downloaded archive digest differs")
}

export async function verifyExtracted(expected, files) {
  const build = JSON.parse(await readFile(files.build, "utf8"))
  const manifest = JSON.parse(await readFile(files.manifest, "utf8"))
  assert.equal(build.schemaVersion, 1, "Unknown packaged build identity")
  assert.equal(build.channel, expected.channel, "Packaged channel differs")
  assert.equal(build.version, expected.version, "Packaged version differs")
  assert.equal(build.revision, expected.sourceSha, "Packaged source differs")
  assert.equal(manifest.name, "vector-desktop", "Wrong packaged application")
  assert.equal(manifest.version, expected.version, "Application manifest version differs")
  assert.equal(await sha256(files.catalog), expected.catalogSha256, "Release catalog differs")
  return {
    schemaVersion: 1,
    sourceSha: expected.sourceSha,
    version: expected.version,
    channel: expected.channel,
    platform: expected.platform,
    entrySha256: await sha256(files.entry),
    catalogSha256: expected.catalogSha256,
    artifact: {
      repository: expected.repository,
      runId: expected.runId,
      runAttempt: expected.attempt,
      artifactId: expected.artifacts.linux.id,
      archiveSha256: expected.artifacts.linux.sha256,
      installerSha256: await sha256(files.installer),
      asarSha256: await sha256(files.asar),
      catalogArtifactId: expected.artifacts.catalog.id,
      catalogArchiveSha256: expected.artifacts.catalog.sha256,
    },
    scope: "Exact packaged sidecar bytes hosted under Node with an IPC adapter; not the full Electron application",
  }
}

async function main(args) {
  const [mode, identityFile, directory] = args
  assert.ok(
    args.length === 3 && (mode === "archives" || mode === "extracted"),
    "Usage: node verify-release-evidence.mjs archives|extracted IDENTITY_JSON WORK_DIRECTORY",
  )
  const expected = JSON.parse(await readFile(identityFile, "utf8"))
  const root = path.resolve(directory)
  verifyRun(expected, JSON.parse(await readFile(path.join(root, "run.json"), "utf8")))
  // Reverify archives before the extracted entry can be admitted, including a resumed workflow invocation.
  for (const name of ["linux", "catalog"])
    await verifyArchive(
      expected,
      name,
      JSON.parse(await readFile(path.join(root, `${name}.json`), "utf8")),
      path.join(root, `${name}.zip`),
    )
  if (mode === "archives") return
  const resources = path.join(root, "image", "squashfs-root", "resources")
  const app = path.join(root, "app")
  const identity = await verifyExtracted(expected, {
    build: path.join(resources, "vector-build.json"),
    manifest: path.join(app, "package.json"),
    catalog: path.join(root, "catalog", "api.json"),
    entry: path.join(app, "out", "main", "sidecar.js"),
    installer: path.join(root, "linux", expected.installer),
    asar: path.join(resources, "app.asar"),
  })
  await writeFile(path.join(root, "provenance.json"), `${JSON.stringify(identity, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main(process.argv.slice(2))
