import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { Hands } from "@vectordevai/schema/hands"
import { PositiveInt } from "@vectordevai/schema/schema"
import { APP_IDS, EXECUTABLE_NAMES } from "./channel-ids"

/**
 * Vector Hands' shared helper inputs (build contract section 2.11, C1).
 *
 * `generateBlocklist()` writes `native/computer-helper/blocklist.json` from `ComputerApps`, so both native helpers
 * judge apps from the same table as the engine and desktop main; the committed file is checked against a fresh
 * render. `generateIdentitySources(outDir)` renders `Identity.swift`, `identity.h` and `blocklist.h` from
 * `identity.json`, the committed `blocklist.json` and the channel ids, as build outputs for C2's helper builds.
 *
 * Usage, from packages/desktop: `bun ./scripts/computer-helper-identity.ts` regenerates blocklist.json;
 * `bun ./scripts/computer-helper-identity.ts --out <dir>` renders the sources from the committed files and refuses a
 * stale blocklist.json or an identity.json that disagrees with the shared constants. It uses `node:` APIs, not Bun's,
 * so the desktop typecheck covers it, but it runs under Bun only: the schema package ships TypeScript sources with
 * extensionless imports, which plain Node cannot resolve without a bundle (C1.1).
 */

const helperDir = fileURLToPath(new URL("../native/computer-helper/", import.meta.url))
export const IDENTITY_FILE = path.join(helperDir, "identity.json")
export const BLOCKLIST_FILE = path.join(helperDir, "blocklist.json")

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export interface Identity extends Schema.Schema.Type<typeof Identity> {}
export const Identity = Schema.Struct({
  displayName: Text,
  helperVersion: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
  protocol: Schema.Struct({ min: PositiveInt, max: PositiveInt }),
  bundleIdSuffix: Text,
  mac: Schema.Struct({ bundle: Text, executable: Text, minimumSystemVersion: Text }),
  windows: Schema.Struct({ executable: Text, minimumBuild: PositiveInt }),
})

export function readIdentity(file = IDENTITY_FILE): Identity {
  return Schema.decodeUnknownSync(Schema.fromJsonString(Identity), { onExcessProperty: "error" })(
    readFileSync(file, "utf8"),
  )
}

/**
 * The blocklist the helpers load. `rules` spells out `ComputerApps.category` in order, so a helper can implement
 * the same decision from the data; `entries` keep `TABLE`'s order (never entries first), and only `default-blocked`
 * entries are removable.
 */
export function renderBlocklist() {
  const never = [...ComputerApps.NEVER]
  const file = {
    schemaVersion: 1,
    source: "packages/schema/src/computer-apps.ts",
    match: {
      case: "insensitive",
      wildcard: "a pattern ending in * matches by prefix",
      macos: "the identity's bundleId against macos",
      windows:
        "windowClass first when the window's class is known, then aumid for an aumid identity or binary (the original file name from the signed image) for an exe identity",
    },
    never,
    noAlways: [...ComputerApps.NO_ALWAYS],
    clickOnly: [...ComputerApps.CLICK_ONLY],
    reasons: Object.fromEntries(never.map((category) => [category, neverReason(category)])),
    rules: [
      {
        id: "never",
        rule: "The first entry, in order, whose patterns match the identity decides when its category is in never.",
      },
      {
        id: "child-shell",
        rule: "An app whose process tree has a child shell or REPL is terminal, unless its listed category is developer.",
      },
      { id: "system-ui", rule: "A system-ui entry is visible in frames and is never a grant target." },
      {
        id: "system",
        rule: "A system identity (an OS platform binary) is security unless it matches a benign-system or default-blocked entry. A macOS benign-system entry matches only an identity with apple: true.",
      },
      { id: "listed", rule: "Otherwise the first matching entry's category, else general." },
      {
        id: "enforce",
        rule: "Helpers refuse every target whose category is in never with protected, whatever the session approved. Default-blocked entries are the desktop's verdict: a helper never refuses an app only because it is default-blocked, since the user can unblock it.",
      },
      {
        id: "click-only",
        rule: "Helpers refuse text input into an app whose category is in clickOnly with blocked, after the owner and secure-field checks. Text input is input.type, ui.setValue, and an input.key or input.hold that types: its combo holds a key other than a modifier or a key that never types (Enter, Return, Tab, Backspace, Delete, Escape, the arrows, Home, End, Page Up, Page Down, Insert, Help, Caps Lock, Num Lock, Scroll Lock, Print Screen, Pause, the context menu key, F1 to F24, the media and volume keys), and no shortcut modifier. Command, Win and Control are shortcut modifiers, except that on Windows Ctrl+Alt is AltGraph; on Windows Alt is one too unless a numpad key comes with it (an Alt code). Shift, AltGraph and Fn keep a key's text, and so does Option on macOS. The list fails closed: a key name it does not know counts as typing. Clicks, shortcuts and navigation or editing keys stay allowed.",
      },
    ],
    entries: ComputerApps.TABLE.map((entry) => {
      const list = listOf(entry)
      return {
        key: entry.key,
        name: entry.name,
        category: entry.category,
        list,
        ...(list === "never" || list === "default-blocked" ? { removable: list === "default-blocked" } : {}),
        ...(entry.macos ? { macos: [...entry.macos] } : {}),
        ...(entry.windows
          ? {
              windows: {
                ...(entry.windows.aumid ? { aumid: [...entry.windows.aumid] } : {}),
                ...(entry.windows.windowClass ? { windowClass: [...entry.windows.windowClass] } : {}),
                ...(entry.windows.binary ? { binary: [...entry.windows.binary] } : {}),
              },
            }
          : {}),
      }
    }),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/** Write blocklist.json and return its text. */
export function generateBlocklist(file = BLOCKLIST_FILE) {
  const text = renderBlocklist()
  writeFileSync(file, text)
  return text
}

/**
 * Render the helpers' generated sources into `outDir` and return their paths. Refuses when the committed
 * blocklist.json differs from a fresh render, so a build never compiles against a stale never-list, and when the
 * identity disagrees with the shared constants.
 */
export function generateIdentitySources(
  outDir: string,
  files: { identity?: string; blocklist?: string } = {},
): string[] {
  const identity = readIdentity(files.identity)
  const blocklist = readFileSync(files.blocklist ?? BLOCKLIST_FILE, "utf8")
  if (blocklist !== renderBlocklist())
    throw new Error("blocklist.json is stale: run `bun ./scripts/computer-helper-identity.ts` in packages/desktop")
  const channels = requireConsistent(identity)
  const sources = {
    "Identity.swift": swiftSource(identity, channels, blocklist),
    "identity.h": identityHeader(identity, channels),
    "blocklist.h": blocklistHeader(blocklist),
  }
  mkdirSync(outDir, { recursive: true })
  return Object.entries(sources).map(([name, text]) => {
    const file = path.join(outDir, name)
    writeFileSync(file, text)
    return file
  })
}

function listOf(entry: ComputerApps.AppMatcher) {
  if (ComputerApps.isNever(entry.category)) return "never"
  if (entry.category === "system-ui") return "system-ui"
  if (ComputerApps.DEFAULT_BLOCKED.includes(entry)) return "default-blocked"
  if (ComputerApps.BENIGN_SYSTEM.includes(entry)) return "benign-system"
  return "categorized"
}

// The reason each never category reports, read from the module's own verdict for one of its macOS entries, so the
// file cannot drift from `builtinRule`.
function neverReason(category: ComputerApps.AppCategory) {
  const pattern = ComputerApps.TABLE.find((entry) => entry.category === category && entry.macos?.length)?.macos?.[0]
  const rule = pattern
    ? ComputerApps.builtinRule({
        platform: "macos",
        bundleId: pattern.replace(/\*$/, "x"),
        apple: false,
        system: false,
        verified: true,
        name: category,
      })
    : undefined
  if (rule?.category !== category || rule.removable) throw new Error(`No built-in rule reports the ${category} reason`)
  return rule.reason
}

function requireConsistent(identity: Identity) {
  if (Object.values(APP_IDS).toSorted().join() !== [...ComputerApps.VECTOR_APP_IDS].toSorted().join())
    throw new Error("The desktop channel ids differ from ComputerApps.VECTOR_APP_IDS")
  const binaries: readonly string[] = ComputerApps.VECTOR_WINDOWS_BINARIES
  const executables = [...Object.values(EXECUTABLE_NAMES).map((name) => `${name}.exe`), identity.windows.executable]
  const missing = executables.filter((name) => !binaries.includes(name))
  if (missing.length) throw new Error(`ComputerApps.VECTOR_WINDOWS_BINARIES lacks ${missing.join(", ")}`)
  if (identity.bundleIdSuffix !== ComputerApps.HELPER_SUFFIX)
    throw new Error("identity.json bundleIdSuffix differs from ComputerApps.HELPER_SUFFIX")
  if (identity.protocol.min > Computer.PROTOCOL || identity.protocol.max < Computer.PROTOCOL)
    throw new Error(`identity.json protocol does not include ${Computer.PROTOCOL}`)
  // Exactly the shared name, so every channel's helperName is displayName plus its channel word.
  if (identity.displayName !== Hands.NAME) throw new Error("identity.json displayName differs from Hands.NAME")
  return Hands.CHANNELS.map((channel) => {
    const helperName = Hands.helperName(channel)
    if (helperName !== identity.displayName && !helperName.startsWith(`${identity.displayName} `))
      throw new Error(`Hands.helperName(${channel}) is not identity.json displayName plus a channel word`)
    return {
      name: channel,
      appId: APP_IDS[channel],
      helperBundleId: Hands.helperBundleId(APP_IDS[channel]),
      helperName,
      electronHelperIds: ComputerApps.ELECTRON_HELPER_SUFFIXES.map((suffix) => `${APP_IDS[channel]}.${suffix}`),
      windowsExecutable: `${EXECUTABLE_NAMES[channel]}.exe`,
    }
  })
}

type Channel = ReturnType<typeof requireConsistent>[number]

const HEADER = (comment: string) =>
  `${comment} Generated by packages/desktop/scripts/computer-helper-identity.ts from identity.json, blocklist.json\n` +
  `${comment} and scripts/channel-ids.ts. Do not edit.\n`

function swiftSource(identity: Identity, channels: Channel[], blocklist: string) {
  if (blocklist.includes('"""#') || blocklist.includes("\\#"))
    throw new Error("blocklist.json would end the Swift raw string")
  const strings = (values: readonly string[]) => `[${values.map(literal).join(", ")}]`
  return [
    HEADER("//"),
    "enum Identity {",
    "  struct Channel {",
    "    let name: String",
    "    let appId: String",
    "    let helperBundleId: String",
    "    let helperName: String",
    "    let electronHelperIds: [String]",
    "    let windowsExecutable: String",
    "  }",
    "",
    `  static let displayName = ${literal(identity.displayName)}`,
    `  static let helperVersion = ${literal(identity.helperVersion)}`,
    `  static let protocolMin = ${identity.protocol.min}`,
    `  static let protocolMax = ${identity.protocol.max}`,
    `  static let bundleIdSuffix = ${literal(identity.bundleIdSuffix)}`,
    `  static let bundle = ${literal(identity.mac.bundle)}`,
    `  static let executable = ${literal(identity.mac.executable)}`,
    `  static let minimumSystemVersion = ${literal(identity.mac.minimumSystemVersion)}`,
    "  static let channels: [Channel] = [",
    ...channels.map(
      (channel) =>
        `    Channel(name: ${literal(channel.name)}, appId: ${literal(channel.appId)}, helperBundleId: ${literal(channel.helperBundleId)}, helperName: ${literal(channel.helperName)}, electronHelperIds: ${strings(channel.electronHelperIds)}, windowsExecutable: ${literal(channel.windowsExecutable)}),`,
    ),
    "  ]",
    `  static let vectorBundleIds: [String] = ${strings(vectorBundleIds(channels))}`,
    `  static let vectorWindowsBinaries: [String] = ${strings(ComputerApps.VECTOR_WINDOWS_BINARIES)}`,
    "}",
    "",
    "// blocklist.json, verbatim.",
    "enum Blocklist {",
    '  static let json = #"""',
    // The line break before the closing delimiter is not part of a Swift string, so the file's own final one stays.
    blocklist,
    '"""#',
    "}",
    "",
  ].join("\n")
}

function identityHeader(identity: Identity, channels: Channel[]) {
  const array = (name: string, values: readonly string[]) =>
    `inline constexpr std::array<std::string_view, ${values.length}> ${name} = {${values.map(literal).join(", ")}};`
  return [
    HEADER("//"),
    "#pragma once",
    "",
    "#include <array>",
    "#include <string_view>",
    "",
    "namespace vector::computer::identity {",
    "",
    "struct Channel {",
    "  std::string_view name;",
    "  std::string_view appId;",
    "  std::string_view helperBundleId;",
    "  std::string_view helperName;",
    "  std::string_view windowsExecutable;",
    "};",
    "",
    `inline constexpr std::string_view kDisplayName = ${literal(identity.displayName)};`,
    `inline constexpr std::string_view kHelperVersion = ${literal(identity.helperVersion)};`,
    `inline constexpr int kProtocolMin = ${identity.protocol.min};`,
    `inline constexpr int kProtocolMax = ${identity.protocol.max};`,
    `inline constexpr std::string_view kBundleIdSuffix = ${literal(identity.bundleIdSuffix)};`,
    `inline constexpr std::string_view kExecutable = ${literal(identity.windows.executable)};`,
    `inline constexpr int kMinimumBuild = ${identity.windows.minimumBuild};`,
    `inline constexpr std::array<Channel, ${channels.length}> kChannels = {{`,
    ...channels.map(
      (channel) =>
        `    {${[channel.name, channel.appId, channel.helperBundleId, channel.helperName, channel.windowsExecutable].map(literal).join(", ")}},`,
    ),
    "}};",
    array("kVectorBundleIds", vectorBundleIds(channels)),
    array("kVectorWindowsBinaries", ComputerApps.VECTOR_WINDOWS_BINARIES),
    "",
    "}  // namespace vector::computer::identity",
    "",
  ].join("\n")
}

// MSVC limits one string literal to about 16 KB, so the JSON is embedded verbatim in line-aligned parts of at most
// 8 KB; joined in order they are the file.
function blocklistHeader(blocklist: string) {
  if (blocklist.includes(')json"')) throw new Error("blocklist.json would end the C++ raw string")
  const parts = blocklist.split(/(?<=\n)/).reduce<string[]>((result, line) => {
    const last = result.at(-1)
    if (last !== undefined && last.length + line.length <= 8192) result[result.length - 1] = last + line
    else result.push(line)
    return result
  }, [])
  return [
    HEADER("//"),
    "#pragma once",
    "",
    "#include <array>",
    "#include <string_view>",
    "",
    "namespace vector::computer::blocklist {",
    "",
    "// blocklist.json, verbatim, in parts; join them in order.",
    `inline constexpr std::array<std::string_view, ${parts.length}> kJsonParts = {`,
    ...parts.map((part) => `R"json(${part})json",`),
    "};",
    "",
    "}  // namespace vector::computer::blocklist",
    "",
  ].join("\n")
}

function vectorBundleIds(channels: Channel[]) {
  return channels.flatMap((channel) => [channel.appId, channel.helperBundleId, ...channel.electronHelperIds])
}

// A string literal valid in Swift and C++ alike: printable ASCII only, with quotes and backslashes escaped.
function literal(value: string) {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new Error(`Generated strings must be printable ASCII: ${value}`)
  return JSON.stringify(value)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs({ options: { out: { type: "string" } }, strict: true }).values
  if (args.out === undefined) {
    generateBlocklist()
    console.log(`Wrote ${BLOCKLIST_FILE}`)
  } else {
    for (const file of generateIdentitySources(path.resolve(args.out))) console.log(`Wrote ${file}`)
  }
}
