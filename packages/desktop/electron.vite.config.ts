import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@vectordevai/app/vite"
import * as fs from "node:fs/promises"

import manifest from "./package.json"
import { requiredCliVersion } from "./scripts/build-identity"

const VECTOR_SERVER_DIST = "../engine/dist/node"

const channel = (() => {
  const raw = process.env.VECTOR_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.VECTOR_CHANNEL === "latest") return "prod"
  return "dev"
})()

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.VECTOR_CHANNEL": JSON.stringify(channel),
      // Enabled only by the verified C9 release build, never by a running desktop's environment.
      VECTOR_COMPUTER_RESET_VERIFIED: JSON.stringify(process.env.VECTOR_COMPUTER_RESET_VERIFIED === "1"),
      "import.meta.env.VECTOR_REQUIRED_CLI_VERSION": JSON.stringify(
        requiredCliVersion(manifest.vectorRequiredCliVersion, process.env.VECTOR_REQUIRED_CLI_VERSION),
      ),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
      },
      // Keep the platform-neutral loader external. It chooses the matching
      // native PTY package when the installed app starts, so cross-arch and
      // cross-platform installers never inherit the build machine's binary.
      externalizeDeps: { include: ["@lydell/node-pty"] },
    },
    plugins: [
      {
        name: "vector:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:vector-server") return this.resolve(`${VECTOR_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "vector:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(VECTOR_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${VECTOR_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts", "computer-overlay": "src/preload/computer-overlay.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      // Maps are made only for the private Sentry upload, which deletes them afterwards. A customer build without it
      // ships no original sources.
      sourcemap: sentry ? "hidden" : false,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
