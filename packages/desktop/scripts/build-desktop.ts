import path from "node:path"
import { fileURLToPath } from "node:url"
import { BUILD_IDENTITY_FILE, createBuildIdentity, requiredCliVersion } from "./build-identity"
import { resolveChannel } from "./utils"
import { computerHelperBuildEnvironment } from "./computer-helper-package-build"

declare const Bun: {
  env: NodeJS.ProcessEnv
  file(file: string): { json(): Promise<unknown> }
  write(file: string, data: string): Promise<number>
  resolveSync(specifier: string, directory: string): string
  spawnSync(
    command: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stderr: "inherit"; stdout: "inherit" },
  ): { exitCode: number }
}

if (import.meta.main) {
  const packageDir = fileURLToPath(new URL("../", import.meta.url))
  const channel = resolveChannel()
  const environment = await computerHelperBuildEnvironment({
    channel,
    directory: packageDir,
    environment: { ...process.env, VECTOR_CHANNEL: channel },
  })

  const result = Bun.spawnSync(
    [
      "node",
      "--max-old-space-size=6144",
      path.join(
        path.dirname(Bun.resolveSync("electron-vite/package.json", path.dirname(fileURLToPath(import.meta.url)))),
        "bin",
        "electron-vite.js",
      ),
      "build",
    ],
    {
      cwd: packageDir,
      env: environment,
      stderr: "inherit",
      stdout: "inherit",
    },
  )

  if (result.exitCode !== 0) process.exit(result.exitCode)

  const manifest: unknown = await Bun.file(path.join(packageDir, "package.json")).json()
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("Desktop package.json has no version")
  }

  await Bun.write(
    path.join(packageDir, "out", BUILD_IDENTITY_FILE),
    `${JSON.stringify(
      createBuildIdentity({
        channel,
        version: manifest.version,
        requiredCliVersion: requiredCliVersion(
          "vectorRequiredCliVersion" in manifest ? manifest.vectorRequiredCliVersion : undefined,
          Bun.env.VECTOR_REQUIRED_CLI_VERSION,
        ),
        revision: Bun.env.GITHUB_SHA ?? Bun.env.VERCEL_GIT_COMMIT_SHA,
      }),
      null,
      2,
    )}\n`,
  )
  console.log(`Embedded ${channel} build identity in out/${BUILD_IDENTITY_FILE}`)
}
