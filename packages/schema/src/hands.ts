export * as Hands from "./hands"

/**
 * The feature's brand constants (build contract section 2.1). Every user-visible use of the feature's name reads
 * this file, and the name is written only in NAME, so a rename touches only this file, the docs slug and one docs
 * redirect.
 *
 * Renaming: change only NAME, SHORT, MENTION and the words in helperName. Never change ID, MARKER or the helper
 * bundle id: the engine, saved settings and mention markers key on ID and MARKER, and macOS ties the user's Screen
 * Recording and Accessibility grants to the helper's bundle id. BANNER is the owner's fixed sentence and is not built
 * from NAME.
 *
 * Internal identifiers stay "computer" everywhere (tool and permission ids, config key, Settings tab, IPC prefix,
 * file names). This file has no imports, so any surface (renderer, desktop main, preload, overlay pages) can read it.
 * packages/app/src/features/computer/brand-guard.test.ts fails when the name is written anywhere else.
 */

/** The feature's name. Every user-visible use of the name reads this. */
export const NAME = "Vector Hands"

/** The short name, used where "Vector" is already clear from context. */
export const SHORT = "Hands"

/** The composer mention, shown as @Hands. */
export const MENTION = "Hands"

/** Words that find the @Hands mention and the Settings tab. Search only, never displayed. */
export const MENTION_KEYWORDS: readonly string[] = Object.freeze([
  "computer",
  "computer use",
  "screen",
  "use my computer",
  "mouse",
  "keyboard",
  "hands",
])

/** The top banner while Hands works. The owner's fixed sentence; not built from NAME. */
export const BANNER = "Vector is using your computer"

/** The docs slug. */
export const DOCS = "vector-hands"

/** The engine tool id. Never changes. */
export const ID = "computer"

/** The mention marker's metadata key (section 2.5). Never changes; equals Computer.MENTION_KEY. */
export const MARKER = "vector.computer.mention"

/** The key that stops Hands while it works in the foreground. */
export const STOP_KEY = "Escape"

/** The default stop chord per platform, as Electron accelerators. The user can change it. */
export const STOP_CHORD: Readonly<{ darwin: string; win32: string }> = Object.freeze({
  darwin: "Command+Shift+Escape",
  win32: "Control+Alt+Shift+Escape",
})

/** Vector's release channels, as desktop main names them. */
export type Channel = "prod" | "beta" | "dev"

export const CHANNELS: readonly Channel[] = Object.freeze(["prod", "beta", "dev"])

/** The helper's bundle id suffix. Equals ComputerApps.HELPER_SUFFIX; never under Electron's `${appId}.helper*`. */
const HELPER_SUFFIX = "computer"

/**
 * The macOS helper's bundle id for a Vector app id: `${appId}.computer`. It must never change after shipping,
 * because macOS ties privacy grants to it.
 */
export function helperBundleId(appId: string): string {
  return `${appId}.${HELPER_SUFFIX}`
}

const CHANNEL_WORD: Readonly<Record<Channel, string>> = Object.freeze({ prod: "", beta: "Beta", dev: "Dev" })

/**
 * The helper app's display name per channel, as System Settings lists it: NAME, then "Beta" or "Dev" outside the
 * prod channel. An unknown channel is treated as dev, as desktop main does.
 */
export function helperName(channel: Channel): string {
  const word = Object.hasOwn(CHANNEL_WORD, channel) ? CHANNEL_WORD[channel] : CHANNEL_WORD.dev
  return word ? `${NAME} ${word}` : NAME
}
