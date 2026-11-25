import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { validateArtifact } from "../../../script/diagnose-direct-windows-holder.mjs"
import { integrationRunner } from "./scope.ts"

async function artifactFile(file, limit) {
  const info = await lstat(file)
  if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > limit) throw new Error("Invalid fixture file")
  const bytes = await readFile(file)
  if (bytes.length !== info.size) throw new Error("Unstable fixture file")
  return bytes
}

try {
  const runner = integrationRunner()
  const artifact = path.join(runner.temporary, "vector-direct-holder")
  if (
    !(await lstat(artifact)).isDirectory() ||
    (await realpath(artifact)).toLowerCase() !== artifact.toLowerCase() ||
    (await readdir(artifact)).sort().join("|") !== "holder.exe|receipt.json"
  ) {
    throw new Error("Invalid fixture artifact directory")
  }
  const receipt = await artifactFile(path.join(artifact, "receipt.json"), 1024)
  const bytes = await artifactFile(path.join(artifact, "holder.exe"), 1_048_576)
  validateArtifact(runner, receipt, bytes, process.env.VECTOR_DIRECT_HOLDER_PAYLOAD_DIGEST)
  const provenance = JSON.parse(receipt.toString("utf8"))
  for (const [file, digest] of [
    ["windows-holder.ts", provenance.sourceSHA],
    ["windows-process.ts", provenance.processSHA],
  ]) {
    const source = await readFile(new URL(`../../../src/tool/shell/${file}`, import.meta.url), "utf8")
    if (createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex") !== digest)
      throw new Error("The integration checkout does not match the compiled holder")
  }
  const asset = {
    run: runner.run,
    attempt: runner.attempt,
    revision: runner.revision,
    base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
  await writeFile(new URL("./asset.generated.ts", import.meta.url), `export const asset = ${JSON.stringify(asset)}\n`, {
    flag: "wx",
  })
  console.log("Verified and embedded the paired Windows x64 holder for integration.")
} catch {
  console.error("The direct Windows holder could not be verified and embedded for this test job.")
  process.exitCode = 1
}
