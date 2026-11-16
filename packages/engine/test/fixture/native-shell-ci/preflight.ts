import fs from "node:fs/promises"
import { constants } from "node:fs"
import { DirectoryIdentityReader } from "@vectordevai/core/directory-identity"
import { ROOT, CONTROL, READER_SHA, control, need } from "./common"

const selected = control()
need(
  process.argv.length === 2 &&
    process.getuid?.() !== 0 &&
    (process.versions.bun === undefined ? process.versions.node === "24.15.0" : process.versions.bun === "1.3.14"),
)
const runtime = await fs.realpath(process.execPath)
need(runtime === `${ROOT}/runtime/node` || runtime === `${selected.runtime === "bun" ? ROOT : CONTROL}/runtime/bun`)
const handle = await fs.open(`${CONTROL}/probe`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
try {
  const before = await handle.stat({ bigint: true })
  const proof = await DirectoryIdentityReader.read(handle)
  const after = await handle.stat({ bigint: true })
  need(
    proof &&
      before.isDirectory() &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.mode === after.mode &&
      proof.dev === before.dev.toString() &&
      proof.ino === before.ino.toString(),
  )
  process.stdout.write(
    JSON.stringify({
      v: 1,
      runtime: process.versions.bun ? "bun" : "node",
      readerSHA256: READER_SHA,
      sourceRevision: selected.sourceRevision,
      info: proof,
    }) + "\n",
  )
} finally {
  await handle.close()
}
