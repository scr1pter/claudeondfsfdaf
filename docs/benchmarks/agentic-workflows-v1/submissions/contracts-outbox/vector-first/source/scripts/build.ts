import { cp, mkdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
const dataDirectory = process.env.DATA_DIR
if (!dataDirectory || !isAbsolute(dataDirectory) || !relative(resolve("."), dataDirectory).startsWith(".." + sep)) throw new Error("Build requires DATA_DIR outside application source")
const output = join(dataDirectory, "build")
await mkdir(output, { recursive: true })
await cp("web", output, { recursive: true })
console.log("Copied the browser application to " + output)
