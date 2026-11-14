import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig, mergeConfig } from "vite"
import appConfig from "../vite.config"

// Compile the App and every regression fixture before browsers start. Preview
// serves stable chunks without dev optimizer generations invalidating imports.
export default defineConfig(async (env) => mergeConfig(await appConfig(env), {
  build: {
    outDir: "dist-e2e",
    rollupOptions: {
      input: [
        fileURLToPath(new URL("../index.html", import.meta.url)),
        ...readdirSync(new URL("./fixtures", import.meta.url))
          .filter((name) => name.endsWith(".html"))
          .sort()
          .map((name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))),
      ],
    },
  },
}))
