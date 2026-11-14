import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"
import { createRequire } from "node:module"
import path from "node:path"

const vectorDesktopEntry = "resources/linux/vector-desktop.desktop"

const channels = [
  { channel: "dev", appId: "ai.vector.app.dev", executableName: "vector-desktop-dev" },
  { channel: "beta", appId: "ai.vector.app.beta", executableName: "vector-desktop-beta" },
  { channel: "prod", appId: "ai.vector.app", executableName: "vector-desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.VECTOR_CHANNEL
    process.env.VECTOR_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.VECTOR_CHANNEL
    else process.env.VECTOR_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.executableName)
    expect(config.linux?.executableName).not.toContain(".app")
    expect(config.linux?.syncDesktopName).toBe(true)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.extraResources).toContainEqual({
      from: "out/vector-build.json",
      to: "vector-build.json",
    })
    expect(config.mac?.extraFiles).toEqual([
      {
        from: path.join(import.meta.dirname, "native/out/darwin/VectorComputer.app"),
        to: "Helpers/VectorComputer.app",
      },
    ])
    expect(typeof config.mac?.sign).toBe("function")
    expect(config.mac?.extraResources).toContainEqual({
      from: path.join(import.meta.dirname, "native/out/darwin/computer-helper.json"),
      to: "computer-helper.json",
    })
    expect(config.win?.extraResources).toEqual([
      {
        from: path.join(import.meta.dirname, "native/out/win32/${arch}"),
        to: "computer",
        filter: ["vector-computer.exe", "computer-helper.json"],
      },
    ])
    expect(config.win?.signExts).toEqual(["!vector-computer.exe"])
    expect(config.files).toEqual(["out/**/*", "resources/**/*"])
    if (channel.channel === "dev") {
      expect(config.electronFuses).toBeUndefined()
      return
    }
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    })
  })
}

test("ships the branded Vector Linux launcher", async () => {
  const previous = process.env.VECTOR_CHANNEL
  process.env.VECTOR_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.VECTOR_CHANNEL
  else process.env.VECTOR_CHANNEL = previous

  expect(config.deb?.fpm?.[0]).toEndWith(`${vectorDesktopEntry}=/usr/share/applications/vector-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${vectorDesktopEntry}=/usr/share/applications/vector-desktop.desktop`)

  const desktop = await Bun.file(vectorDesktopEntry).text()
  expect(desktop).toContain("Name=Vector")
  expect(desktop).toContain("Exec=/opt/Vector/vector-desktop %U")
  expect(desktop).toContain("Icon=vector-desktop")
  expect(desktop).toContain("StartupWMClass=ai.vector.app")
})

test("allows only an explicit unsigned production package to skip platform verification", async () => {
  const previous = {
    allowUnsignedRelease: process.env.VECTOR_ALLOW_UNSIGNED_RELEASE,
    channel: process.env.VECTOR_CHANNEL,
    githubActions: process.env.GITHUB_ACTIONS,
    publisherName: process.env.VECTOR_WINDOWS_PUBLISHER_NAME,
  }
  process.env.VECTOR_ALLOW_UNSIGNED_RELEASE = "true"
  process.env.VECTOR_CHANNEL = "prod"
  process.env.GITHUB_ACTIONS = "true"
  delete process.env.VECTOR_WINDOWS_PUBLISHER_NAME

  const module = await import("./electron-builder.config.ts?unsigned=prod")
  const config = module.default as Configuration

  if (previous.allowUnsignedRelease === undefined) delete process.env.VECTOR_ALLOW_UNSIGNED_RELEASE
  else process.env.VECTOR_ALLOW_UNSIGNED_RELEASE = previous.allowUnsignedRelease
  if (previous.channel === undefined) delete process.env.VECTOR_CHANNEL
  else process.env.VECTOR_CHANNEL = previous.channel
  if (previous.githubActions === undefined) delete process.env.GITHUB_ACTIONS
  else process.env.GITHUB_ACTIONS = previous.githubActions
  if (previous.publisherName === undefined) delete process.env.VECTOR_WINDOWS_PUBLISHER_NAME
  else process.env.VECTOR_WINDOWS_PUBLISHER_NAME = previous.publisherName

  expect(config.mac?.identity).toBeNull()
  expect(config.mac?.sign).toBeUndefined()
  expect(config.mac?.notarize).toBe(false)
  expect(config.mac?.hardenedRuntime).toBe(true)
  expect(typeof config.afterPack).toBe("function")
  expect(config.electronFuses?.resetAdHocDarwinSignature).toBe(true)
  expect(config.electronFuses?.onlyLoadAppFromAsar).toBe(true)
  expect(config.electronFuses?.enableEmbeddedAsarIntegrityValidation).toBe(true)
  expect(config.win?.signExecutable).toBe(false)
  expect(config.win?.verifyUpdateCodeSignature).toBe(false)
  expect(config.win?.signtoolOptions).toBeUndefined()
})

test("electron-builder merges common and macOS notices into packaged Resources", async () => {
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"))
  const { getFileMatchers } = await import(builderRequire.resolve("app-builder-lib/out/fileMatcher.js"))
  const config = (await import("./electron-builder.config.ts?license-merge")).default
  const destination = path.join(import.meta.dirname, "dist/license-test/Vector.app/Contents/Resources")
  const matchers: { from: string; to: string }[] = getFileMatchers(config, "extraResources", destination, {
    defaultSrc: import.meta.dirname,
    customBuildOptions: config.mac,
    globalOutDir: path.join(import.meta.dirname, "dist"),
    macroExpander: (value: string) => value,
  })
  for (const name of [
    "LICENSE.txt",
    "THIRD_PARTY_NOTICES.md",
    "DEPENDENCY_NOTICES.md",
    "Electron-LICENSE.txt",
    "LICENSES.chromium.html",
  ]) {
    const matching = matchers.filter((entry) => entry.to === path.join(destination, name))
    expect(matching.length).toBe(1)
    expect(await Bun.file(matching[0]!.from).exists()).toBe(true)
    expect((await Bun.file(matching[0]!.from).text()).length).toBeGreaterThan(100)
  }
})

test("electron-builder expands the Windows architecture and adds no helper to Linux resources", async () => {
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"))
  const { getFileMatchers } = await import(builderRequire.resolve("app-builder-lib/out/fileMatcher.js"))
  const config = (await import("./electron-builder.config.ts?computer-resources")).default
  const destination = path.join(import.meta.dirname, "dist/computer-resource-test/resources")
  for (const architecture of ["x64", "arm64"]) {
    const matchers: { from: string; to: string; patterns: string[] }[] = getFileMatchers(
      config,
      "extraResources",
      destination,
      {
        defaultSrc: import.meta.dirname,
        customBuildOptions: config.win,
        globalOutDir: path.join(import.meta.dirname, "dist"),
        macroExpander: (value: string) => value.replaceAll("${arch}", architecture),
      },
    )
    const helper = matchers.filter((entry) => entry.to === path.join(destination, "computer"))
    expect(helper).toHaveLength(1)
    expect(helper[0]!.from).toBe(path.join(import.meta.dirname, "native/out/win32", architecture))
    expect(helper[0]!.patterns).toEqual(["vector-computer.exe", "computer-helper.json"])
  }
  const linux: { from: string; to: string }[] = getFileMatchers(config, "extraResources", destination, {
    defaultSrc: import.meta.dirname,
    customBuildOptions: config.linux,
    globalOutDir: path.join(import.meta.dirname, "dist"),
    macroExpander: (value: string) => value,
  })
  expect(
    linux.some((entry) => entry.from.includes("computer-helper") || entry.to === path.join(destination, "computer")),
  ).toBe(false)
})
