import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { GithubAgents } from "@vectordevai/core/github-agents"

/** The artifact's download as the runner uploads it: a zip that holds session.vsa. */
export async function artifactZip(bytes: Uint8Array) {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add(GithubAgents.SESSION_FILE, new Uint8ArrayReader(Uint8Array.from(bytes)), {
    level: 0,
    useWebWorkers: false,
    useCompressionStream: false,
  })
  return writer.close()
}
