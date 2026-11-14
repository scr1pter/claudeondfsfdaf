import fs from "node:fs/promises"
import { DirectoryIdentityReader } from "../../src/directory-identity"
import { ReadOnlyGit } from "../../src/read-only-git"
import { ProcessIsolation } from "../../src/process-isolation"

// A fresh process owns the irreversible guard. No helper/native initialization or payload is permitted.
const handle = await fs.open(process.argv[2]!, "r")
try {
  ProcessIsolation.requireIsolation()
  const identity = await DirectoryIdentityReader.read(handle)
  const git = await ReadOnlyGit.open({
    directory: "/must-not-inspect",
    gitDirectory: "/must-not-inspect/.git",
    commonDirectory: "/must-not-inspect/.git",
  }).then(
    () => false,
    (error: unknown) =>
      error instanceof ReadOnlyGit.Unavailable && error.message.includes("required process isolation"),
  )
  console.log(JSON.stringify({ identity: identity === undefined, git }))
} finally {
  await handle.close()
}
