import { cp, mkdir } from "node:fs/promises"
await mkdir("dist", { recursive: true })
await cp("web", "dist", { recursive: true })
console.log("Copied the browser application to dist")
