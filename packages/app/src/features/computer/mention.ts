export * as ComputerMention from "./mention"

import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { safeLabel } from "../../context/permission-policy"
import type { Prompt } from "../../context/prompt"
import type { dict } from "../../i18n/en"
import type { ComputerOnboarding } from "./onboarding-model"

type App = Awaited<ReturnType<Computer.ComputerPlatform["apps"]>>[number]
type Policy = Readonly<Pick<Computer.ComputerPolicy, "enabled" | "defaultAccess" | "apps">>
type CopyKey = Extract<
  keyof typeof dict,
  "computer.mention.description" | "computer.mention.off" | "computer.mention.companyDenied"
>

export type FeatureOption = {
  type: "computer"
  display: string
  /** Localization key; the popover resolves it in the active language, with the feature's name. */
  description: CopyKey | ComputerOnboarding.BlockedKey
  search: string
  ready: boolean
}

export type AppOption = {
  type: "app"
  key: string
  name: string
  display: string
  search: string
  icon?: string
  running: boolean
  /** Localization key; a present reason prevents selection. */
  disabled?: Extract<CopyKey, "computer.mention.companyDenied">
}

/**
 * The @Hands row. Not ready reads "Off — set it up" when onboarding can fix it; `blocked` is the fixed sentence of a
 * situation setup cannot fix (company off, administrator, macOS version), which the row shows instead.
 */
export function featureOption(input: {
  ready: boolean
  supported: boolean
  blocked?: ComputerOnboarding.BlockedKey
}): FeatureOption | undefined {
  if (!input.supported) return
  return {
    type: "computer",
    display: `@${Hands.MENTION}`,
    description: input.ready ? "computer.mention.description" : (input.blocked ?? "computer.mention.off"),
    search: [Hands.NAME, Hands.SHORT, Hands.MENTION, ...Hands.MENTION_KEYWORDS].join(" "),
    ready: input.ready,
  }
}

/** The desktop supplies identity-based rules. Names and icons only affect presentation. */
export function appOptions(apps: readonly App[], policy: Policy): AppOption[] {
  return apps
    .flatMap((app): AppOption[] => {
      if (app.rule === "never" || app.rule === "blocked") return []
      const name = safeLabel(app.name, 256)
      if (!name) return []
      const access = policy.apps.get(app.key)
      const denied =
        app.rule === "company-deny" ||
        !policy.enabled ||
        access === "deny" ||
        (policy.defaultAccess === "deny" && access !== "allow")
      return [
        {
          type: "app",
          key: app.key,
          name,
          display: `@${name}`,
          search: name,
          ...(Schema.is(Computer.Icon)(app.icon) ? { icon: app.icon } : {}),
          running: app.running,
          ...(denied ? { disabled: "computer.mention.companyDenied" } : {}),
        },
      ]
    })
    .sort((a, b) => Number(b.running) - Number(a.running))
    .slice(0, 8)
}

/** A mention is a hint. Copy only the marker fields, never approvals or policy from a prompt part. */
export function marker(pill: { app?: { key: string; name: string } }): {
  [Hands.MARKER]: Computer.MentionMarker
} {
  return {
    [Hands.MARKER]: pill.app
      ? { kind: "app", key: pill.app.key, name: safeLabel(pill.app.name, 256) }
      : { kind: "feature" },
  }
}

/**
 * An onboarding example as composer parts. Only a leading, exact @Hands becomes a feature pill, so the visible text and
 * the marker it sends agree. App names in examples stay text: no verified app identity stands behind them.
 */
export function examplePrompt(text: string): Prompt {
  const mention = `@${Hands.MENTION}`
  if (!text.startsWith(mention) || /[\p{L}\p{N}_]/u.test(text[mention.length] ?? ""))
    return [{ type: "text", content: text, start: 0, end: text.length }]
  return [
    { type: "computer", content: mention, start: 0, end: mention.length },
    ...(text.length > mention.length
      ? [{ type: "text" as const, content: text.slice(mention.length), start: mention.length, end: text.length }]
      : []),
  ]
}
