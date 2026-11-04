import { sentryVitePlugin } from "@sentry/vite-plugin"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import desktopPlugin from "./vite"
import { phoneBuildId, phoneBuildPlugin } from "./src/phone/build"

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
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

const app: UserConfig = {
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    // Maps are made only for the private Sentry upload, which deletes them afterwards. A build without it ships no
    // original sources.
    sourcemap: sentry ? "hidden" : false,
  },
}

/**
 * The phone app (WP A38), a separate entry: `vite build --mode phone` builds src/phone into dist-phone for
 * https://remote.vectordev.ai/phone/. It shares no chunk, plugin or stylesheet with the app above, carries no source
 * maps, and its page holds no inline script or style, so the phone origin's strict CSP allows it.
 */
function phone(): UserConfig {
  const appRoot = fileURLToPath(new URL(".", import.meta.url))
  const outDir = fileURLToPath(new URL("./dist-phone", import.meta.url))
  const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string
  const build = phoneBuildId(process.env, version)
  return {
    root: fileURLToPath(new URL("./src/phone", import.meta.url)),
    base: "/phone/",
    publicDir: false,
    plugins: [phoneBuildPlugin({ appRoot, outDir, build }), solidPlugin()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    define: { __VECTOR_PHONE_BUILD__: JSON.stringify(build) },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
    },
  }
}

export default defineConfig(({ mode }) => (mode === "phone" ? phone() : app))
