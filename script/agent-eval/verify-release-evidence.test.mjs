import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { sha256, verifyArchive, verifyExtracted, verifyRun } from "./verify-release-evidence.mjs"

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "vector-release-identity-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archive = path.join(root, "archive.zip")
  await writeFile(archive, "fixture archive bytes")
  const expected = {
    schemaVersion: 1,
    repository: "owner/repo",
    repositoryId: 1,
    workflow: ".github/workflows/release.yml",
    runId: 2,
    attempt: 1,
    sourceSha: "a".repeat(40),
    channel: "prod",
    version: "1.99.112",
    platform: "linux-x64",
    artifacts: { linux: { id: 3, name: "linux-release", size: 21, sha256: await sha256(archive) } },
  }
  const run = {
    id: 2,
    run_attempt: 1,
    path: expected.workflow,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: expected.sourceSha,
    repository: { id: 1, full_name: expected.repository },
    head_repository: { id: 1 },
    status: "completed",
    conclusion: "success",
  }
  const artifact = {
    id: 3,
    name: "linux-release",
    expired: false,
    digest: `sha256:${expected.artifacts.linux.sha256}`,
    size_in_bytes: 21,
    workflow_run: { id: 2, head_sha: expected.sourceSha, head_branch: "main", repository_id: 1, head_repository_id: 1 },
  }
  return { root, archive, expected, run, artifact }
}

test("a release must bind successful workflow, source, attempt and repository together", async (t) => {
  const f = await fixture(t)
  verifyRun(f.expected, f.run)
  for (const patch of [
    { conclusion: "failure" },
    { status: "in_progress" },
    { run_attempt: 2 },
    { head_branch: "feature" },
    { head_sha: "b".repeat(40) },
    { head_repository: { id: 9 } },
    { path: ".github/workflows/test.yml" },
  ])
    assert.throws(() => verifyRun(f.expected, { ...f.run, ...patch }))
})

test("archive admission checks immutable metadata and actual bytes before extraction", async (t) => {
  const f = await fixture(t)
  await verifyArchive(f.expected, "linux", f.artifact, f.archive)
  for (const patch of [
    { id: 4 },
    { expired: true },
    { digest: `sha256:${"b".repeat(64)}` },
    { size_in_bytes: 99 },
    { workflow_run: { ...f.artifact.workflow_run, id: 7 } },
    { workflow_run: { ...f.artifact.workflow_run, head_repository_id: 9 } },
  ])
    await assert.rejects(verifyArchive(f.expected, "linux", { ...f.artifact, ...patch }, f.archive))
  await writeFile(f.archive, "fixture archive BYTES")
  await assert.rejects(verifyArchive(f.expected, "linux", f.artifact, f.archive), /digest differs/)
})

test("extracted provenance refuses stale channels, manifests and catalogs", async (t) => {
  const f = await fixture(t)
  const files = Object.fromEntries(
    ["build", "manifest", "catalog", "entry", "installer", "asar"].map((name) => [name, path.join(f.root, name)]),
  )
  const build = { schemaVersion: 1, channel: "prod", version: f.expected.version, revision: f.expected.sourceSha }
  await writeFile(files.build, JSON.stringify(build))
  await writeFile(files.manifest, JSON.stringify({ name: "vector-desktop", version: f.expected.version }))
  for (const name of ["catalog", "entry", "installer", "asar"]) await writeFile(files[name], `${name} bytes`)
  f.expected.catalogSha256 = await sha256(files.catalog)
  f.expected.artifacts.catalog = { id: 4, sha256: "c".repeat(64) }
  const result = await verifyExtracted(f.expected, files)
  assert.equal(result.entrySha256, await sha256(files.entry))
  assert.equal(result.artifact.asarSha256, await sha256(files.asar))
  assert.match(result.scope, /not the full Electron/)
  await writeFile(files.build, JSON.stringify({ ...build, channel: "dev" }))
  await assert.rejects(verifyExtracted(f.expected, files), /channel differs/)
  await writeFile(files.build, JSON.stringify(build))
  await writeFile(files.manifest, JSON.stringify({ name: "vector-desktop", version: "1.99.111" }))
  await assert.rejects(verifyExtracted(f.expected, files), /manifest version differs/)
  await writeFile(files.manifest, JSON.stringify({ name: "vector-desktop", version: f.expected.version }))
  await writeFile(files.catalog, "different catalog")
  await assert.rejects(verifyExtracted(f.expected, files), /catalog differs/)
})
