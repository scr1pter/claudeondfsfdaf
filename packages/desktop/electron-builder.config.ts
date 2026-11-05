import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Arch } from "electron-builder"
import type { Configuration } from "electron-builder"
import { APP_IDS, EXECUTABLE_NAMES } from "./scripts/channel-ids"
import { verifyNativeModules } from "./scripts/verify-native"
import { computerHelperPaths } from "./scripts/computer-helper-package"
import {
  computerHelperSkipRequested,
  loadComputerHelperSigningNode,
  prepareComputerHelperNode,
} from "./scripts/computer-helper-package-node"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const desktopEntry = path.join(packageDir, "resources", "linux", "vector-desktop.desktop")
const desktopEntryFpm = `${desktopEntry}=/usr/share/applications/vector-desktop.desktop`
const signMac = process.env.VECTOR_SIGN_MAC === "true"
const notarizeMac = process.env.VECTOR_NOTARIZE === "true"
const signDmg = process.env.VECTOR_SIGN_DMG === "true"
const allowUnsignedRelease = process.env.VECTOR_ALLOW_UNSIGNED_RELEASE === "true"
const windowsPublisherName = process.env.VECTOR_WINDOWS_PUBLISHER_NAME?.trim()
const updateBaseUrl = "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases"
const releaseElectronFuses = {
  // The server sidecar uses utilityProcess.fork, so packaged releases do not
  // depend on Electron's Node-compatible executable mode.
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
} satisfies NonNullable<Configuration["electronFuses"]>

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.VECTOR_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()
const unsignedMac = allowUnsignedRelease && !signMac && channel !== "dev"
const skipComputerHelper = computerHelperSkipRequested(channel, process.env)
const macComputerHelper = skipComputerHelper ? undefined : computerHelperPaths("darwin", channel, undefined, packageDir)
const windowsComputerHelper = skipComputerHelper
  ? undefined
  : computerHelperPaths("win32", channel, undefined, packageDir)

if (process.env.GITHUB_ACTIONS === "true" && channel === "prod" && !allowUnsignedRelease) {
  if (process.platform === "darwin" && (!signMac || !notarizeMac || !signDmg)) {
    throw new Error("Production macOS artifacts must be signed and notarized.")
  }
  if (process.platform === "win32" && !windowsPublisherName) {
    throw new Error("Production Windows artifacts require VECTOR_WINDOWS_PUBLISHER_NAME.")
  }
}

const getBase = (appId: string, executableName: string): Configuration => ({
  // Updater artifacts are immutable by version. Publishing latest*.yml last can
  // then switch clients to a complete new set without invalidating the files
  // referenced by the previous release metadata.
  artifactName: "vector-desktop-${version}-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.vector.app" becomes
  // "ai.vector.app.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    name: "vector-desktop",
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
  afterPack: async (context) => {
    const platform = context.electronPlatformName
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return
    const helper = await prepareComputerHelperNode(context, {
      channel,
      directory: packageDir,
      environment: process.env,
    })
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    const resources =
      platform === "darwin" ? path.join(app, "Contents", "Resources") : path.join(context.appOutDir, "resources")
    const arch = Arch[context.arch]
    for (const target of arch === "universal" ? ["x64", "arm64"] : [arch])
      await verifyNativeModules(resources, platform, target, { skipComputerHelper })
    if (platform !== "darwin" || skipComputerHelper) return
    if (!helper || helper.manifests.length !== 1 || helper.manifests[0]?.platform !== "darwin")
      throw new Error("The verified macOS computer helper manifest is missing.")
    const signer = await loadComputerHelperSigningNode({ directory: packageDir, environment: process.env })
    await signer.prepareComputerHelperMacSigning(
      { app, channel, sourceManifest: helper.manifests[0] },
      { directory: packageDir, environment: process.env },
    )
    if (unsignedMac)
      await signer.installUnsignedMacComputerHelperFuses(
        context.packager,
        { channel, signUnsignedMac },
        { directory: packageDir, environment: process.env },
      )
  },
  extraResources: [
    {
      // Written by the same build invocation that compiles CHANNEL into the
      // main process. Package verification compares this marker with the
      // bundle id and feed, preventing stale dev output from becoming a
      // production-looking app with its updater silently disabled.
      from: `out/vector-build.json`,
      to: `vector-build.json`,
    },
    {
      from: "resources/icons/",
      to: "icons/",
      filter: ["**/*"],
    },
    {
      from: path.join(rootDir, "LICENSE"),
      to: "LICENSE.txt",
    },
    {
      from: path.join(rootDir, "THIRD_PARTY_NOTICES.md"),
      to: "THIRD_PARTY_NOTICES.md",
    },
    {
      from: path.join(rootDir, "DEPENDENCY_NOTICES.md"),
      to: "DEPENDENCY_NOTICES.md",
    },
  ],
  mac: {
    extraFiles: macComputerHelper?.extraFiles ?? [],
    extraResources: [
      { from: "node_modules/electron/dist/LICENSE", to: "Electron-LICENSE.txt" },
      { from: "node_modules/electron/dist/LICENSES.chromium.html", to: "LICENSES.chromium.html" },
      ...(macComputerHelper?.extraResources ?? []),
    ],
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    extendInfo: {
      NSMicrophoneUsageDescription:
        "Vector uses microphone access only when you start voice dictation or a voice-enabled agent session.",
    },
    hardenedRuntime: true,
    // Even identity "-" enumerates keychains in the pinned builder. Apply the
    // ad-hoc signature ourselves, then let fuse reset re-seal the modified app.
    identity: signMac ? undefined : unsignedMac ? null : "-",
    sign:
      unsignedMac || skipComputerHelper
        ? undefined
        : async (options, packager) => {
            const signer = await loadComputerHelperSigningNode({ directory: packageDir, environment: process.env })
            await signer.signMacWithComputerHelper(options, packager, {
              directory: packageDir,
              environment: process.env,
            })
          },
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: notarizeMac,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: signDmg,
  },
  protocols: {
    name: "Vector",
    schemes: ["vector"],
  },
  win: {
    extraResources: windowsComputerHelper?.extraResources ?? [],
    // The helper manifest/pin describe its final bytes; release signing happens before the desktop build.
    signExts: ["!vector-computer.exe"],
    icon: `resources/icons/icon.ico`,
    signExecutable: !allowUnsignedRelease,
    signtoolOptions: allowUnsignedRelease
      ? undefined
      : {
          publisherName: windowsPublisherName ? [windowsPublisherName] : undefined,
          sign: signWindows,
          signingHashAlgorithms: ["sha256"],
        },
    target: ["nsis"],
    verifyUpdateCodeSignature: !allowUnsignedRelease,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    // @electron/fuses treats any path containing ".app" as a macOS bundle.
    // Keep the Linux binary distinct from the reverse-DNS application ID.
    executableName,
    syncDesktopName: true,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId, EXECUTABLE_NAMES[channel])
  const electronFuses = unsignedMac
    ? { ...releaseElectronFuses, resetAdHocDarwinSignature: true }
    : releaseElectronFuses

  if (channel === "dev") {
    return {
      ...base,
      appId,
      productName: "Vector Dev",
      rpm: { packageName: "vector-dev" },
    }
  }
  if (channel === "beta") {
    return {
      ...base,
      appId,
      productName: "Vector Beta",
      protocols: { name: "Vector Beta", schemes: ["vector"] },
      publish: { provider: "generic", url: `${updateBaseUrl}/vector-beta-updates` },
      rpm: { packageName: "vector-beta" },
      electronFuses,
    }
  }
  return {
    ...base,
    appId,
    productName: "Vector",
    protocols: { name: "Vector", schemes: ["vector"] },
    publish: { provider: "generic", url: `${updateBaseUrl}/vector-updates` },
    deb: { fpm: [desktopEntryFpm] },
    rpm: { packageName: "vector", fpm: [desktopEntryFpm] },
    electronFuses,
  }
}

export async function signUnsignedMac(appPath: string) {
  const signer = await loadComputerHelperSigningNode({ directory: packageDir, environment: process.env })
  return signer.signUnsignedMacWithComputerHelper(
    { app: appPath, channel },
    { directory: packageDir, environment: process.env },
  )
}

export default getConfig()
