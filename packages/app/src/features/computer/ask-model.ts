import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { Hands } from "@vectordevai/schema/hands"
import { canAlwaysAllowPermission, safeLabel } from "../../context/permission-policy"
import type { dict } from "../../i18n/en"

export type ComputerAskKey = Extract<
  keyof typeof dict,
  `computer.ask.${string}` | "computer.action.allow" | "computer.action.allowOnce"
>

export type ComputerAskOptions = {
  t: (key: ComputerAskKey, params?: Record<string, string | number | boolean>) => string
  allowAlways?: boolean
}

export type ComputerAskModel = {
  kind: "app" | "sensitive"
  title: string
  body: string
  publisher: { name?: string; verified: boolean }
  mentioned?: string
  warnings: string[]
  reason?: string
  agentSays?: string
  icon?: string
  canAlways: boolean
  alwaysWhyNot?: string
  alwaysHint?: string
  primaryLabel: string
  armMs: 700
  enterAllowed: boolean
}

/** A display projection only. An absent model must never fall back to approving a computer request. */
export function computerAsk(
  request: { permission: string; metadata: unknown; always?: readonly string[] },
  opts: ComputerAskOptions,
): ComputerAskModel | undefined {
  if (request.permission === "computer_app") {
    const metadata = appMetadata(request.metadata)
    if (!Schema.is(Computer.AppAskMetadata)(metadata)) return
    if (ComputerApps.isNever(metadata.target.category)) return
    if (Computer.parseAppKey(metadata.target.appKey)?.platform !== metadata.target.platform) return
    const app = safeLabel(metadata.target.appName, 256)
    if (!app) return
    const t = (key: ComputerAskKey, params?: Record<string, string | number | boolean>) =>
      opts.t(key, { name: Hands.NAME, app, ...params })
    const category = categoryWarning(metadata.target.category)
    const whyNot = alwaysWhyNot(metadata, opts)
    const canAlways =
      metadata.canAlways &&
      !whyNot &&
      Array.isArray(request.always) &&
      request.always.every((key) => key === metadata.target.appKey) &&
      canAlwaysAllowPermission(request.permission, request.always)
    const agent = safeLabel(metadata.reason, 200)
    return {
      kind: "app",
      title: t("computer.ask.app.title"),
      body: t(metadata.level === "observe" ? "computer.ask.app.bodyObserve" : "computer.ask.app.body"),
      publisher: {
        name: metadata.target.verified ? safeLabel(metadata.target.publisher, 256) || undefined : undefined,
        verified: metadata.target.verified,
      },
      mentioned: metadata.mentioned ? t("computer.ask.mentioned") : undefined,
      warnings: [
        ...(!metadata.target.verified ? [t("computer.ask.unverified")] : []),
        ...(category ? [t(category)] : []),
        ...(metadata.target.ownBuild
          ? [t("computer.ask.builtApp", { repo: safeLabel(metadata.target.ownBuild.repo, 256) })]
          : []),
        ...(metadata.localWarning ? [t("computer.ask.localNetwork")] : []),
      ],
      agentSays: agent ? t("computer.ask.agentSays", { reason: agent }) : undefined,
      icon: metadata.target.icon,
      canAlways,
      alwaysWhyNot: whyNot ? t(whyNot) : undefined,
      alwaysHint: canAlways ? t("computer.ask.always.hint") : undefined,
      primaryLabel: t("computer.action.allow"),
      armMs: 700,
      enterAllowed: true,
    }
  }
  if (request.permission !== "computer_sensitive") return
  const metadata = sensitiveMetadata(request.metadata)
  if (!Schema.is(Computer.SensitiveAskMetadata)(metadata)) return
  if (metadata.why === "run_program" && !safeLabel(metadata.path, 4096)) return
  if (metadata.why === "paste" && typeof metadata.text !== "string") return
  if (metadata.why === "new_destination" && !safeLabel(metadata.destination, 2048)) return
  if (
    metadata.why === "provider_check" &&
    (!safeLabel(metadata.providerCheck?.provider, 64) || !safeLabel(metadata.providerCheck?.message, 1000))
  )
    return
  const app = safeLabel(metadata.target.appName, 256)
  if (!app) return
  const t = (key: ComputerAskKey, params?: Record<string, string | number | boolean>) =>
    opts.t(key, { name: Hands.NAME, app, ...params })
  return {
    kind: "sensitive",
    title: t(sensitiveTitle(metadata), {
      label: safeLabel(metadata.targetName, 40) || t("computer.ask.target.control"),
    }),
    body: "",
    publisher: { verified: false },
    warnings: metadata.providerCheck?.domain ? [t("computer.ask.reason.sensitiveDomain")] : [],
    reason: sensitiveReason(metadata, t),
    canAlways: false,
    primaryLabel: t("computer.action.allowOnce"),
    armMs: 700,
    enterAllowed: false,
  }
}

function categoryWarning(category: ComputerApps.AppCategory): ComputerAskKey | undefined {
  if (category === "browser") return "computer.ask.category.browser"
  if (category === "files") return "computer.ask.category.files"
  if (category === "mail" || category === "messaging") return "computer.ask.category.messaging"
  if (category === "finance") return "computer.ask.category.finance"
  if (category === "developer") return "computer.ask.category.developer"
}

function alwaysWhyNot(metadata: Computer.AppAskMetadata, opts: ComputerAskOptions): ComputerAskKey | undefined {
  if (opts.allowAlways === false || metadata.alwaysWhyNot === "policy") return "computer.ask.always.company"
  if (metadata.alwaysWhyNot === "changed") return "computer.ask.always.changed"
  if (!metadata.target.verified || metadata.alwaysWhyNot === "unverified") return "computer.ask.always.unverified"
  if (ComputerApps.NO_ALWAYS.has(metadata.target.category) || metadata.alwaysWhyNot === "category")
    return "computer.ask.always.category"
}

function sensitiveTitle(metadata: Computer.SensitiveAskMetadata): ComputerAskKey {
  if (metadata.why === "run_program" || metadata.action === "open") return "computer.ask.sensitive.runProgram"
  if (metadata.why === "paste") return "computer.ask.sensitive.paste"
  if (metadata.action === "click") return "computer.ask.sensitive.click"
  if (metadata.action === "type") return "computer.ask.sensitive.type"
  if (metadata.action === "key") return "computer.ask.sensitive.keyUnknown"
  return "computer.ask.sensitive.drag"
}

function sensitiveReason(metadata: Computer.SensitiveAskMetadata, t: ComputerAskOptions["t"]) {
  const reason = metadata.why
  if (reason === "run_program") return t("computer.ask.reason.runProgram", { path: safeLabel(metadata.path, 4096) })
  if (reason === "paste") return t("computer.ask.reason.paste", { text: safeLabel(metadata.text, 60) })
  if (reason === "new_destination")
    return t("computer.ask.reason.newDestination", { destination: safeLabel(metadata.destination, 2048) })
  if (reason === "ide_run") return t("computer.ask.reason.runCodeApp")
  if (reason === "provider_check") {
    const check = metadata.providerCheck
    if (!check) return
    return t("computer.ask.reason.provider", {
      provider: safeLabel(check.provider, 64),
      message: safeLabel(check.message, 1000),
    })
  }
  if (reason === "flagged") return t("computer.ask.reason.flaggedScreen")
  return t(`computer.ask.reason.${reason}`)
}

/** Sanitize display fields before validation; identity, enums and policy flags retain strict schema checks. */
function appMetadata(value: unknown) {
  const metadata = record(value)
  const target = record(metadata?.target)
  if (!metadata || !target) return
  const ownBuild = record(target.ownBuild)
  return {
    ...metadata,
    reason: display(metadata.reason, 200),
    target: {
      ...target,
      appName: identityLabel(target.appName, 256),
      publisher: display(target.publisher, 256),
      icon: Schema.is(Computer.Icon)(target.icon) ? target.icon : undefined,
      ownBuild: ownBuild ? { ...ownBuild, repo: display(ownBuild.repo, 256) } : target.ownBuild,
    },
  }
}

function sensitiveMetadata(value: unknown) {
  const metadata = record(value)
  const target = record(metadata?.target)
  if (!metadata || !target) return
  const check = record(metadata.providerCheck)
  return {
    ...metadata,
    target: { ...target, appName: identityLabel(target.appName, 256) },
    targetName: identityLabel(metadata.targetName, 40),
    providerCheck: check
      ? {
          ...check,
          provider: display(check.provider, 64),
          code: display(check.code, 128),
          message: display(check.message, 1000),
        }
      : metadata.providerCheck,
  }
}

function display(value: unknown, limit: number) {
  return typeof value === "string" ? safeLabel(value, limit) : value
}

function identityLabel(value: unknown, limit: number) {
  if (typeof value !== "string") return value
  const text = safeLabel(value, Infinity)
  return /^(?:app:|window:\d+:\d+$)/i.test(text) ? "" : safeLabel(text, limit)
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return Object.fromEntries(Object.entries(value))
}
