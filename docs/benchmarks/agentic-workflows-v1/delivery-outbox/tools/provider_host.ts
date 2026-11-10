// Independent fixture qualification host, never copied into a coding workspace.
import { pathToFileURL } from "node:url"
const { startProvider } = await import(pathToFileURL(Bun.argv[2]!).href) as typeof import("../seed/fixtures/provider")
const provider = startProvider(Bun.argv[3]!)
console.log(JSON.stringify({ ready: true, origin: provider.origin }))
