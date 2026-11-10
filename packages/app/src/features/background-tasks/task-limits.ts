import * as i18n from "@solid-primitives/i18n"
import type { Task } from "@vectordevai/schema/task"
import { dict as en } from "@/i18n/en"

/*
 * The Tasks pane's limits line (5.I.3, B.10) and the translator its pure labels share. The engine sends `limits` only
 * to the owner, so a guest or a viewer without it sees no line at all, never invented numbers.
 */

export type TaskTextKey = keyof typeof en
export type TaskTranslate = (key: TaskTextKey, params?: Record<string, string | number | boolean>) => string

/** The English strings, for pure code and tests; components pass the language context's `t` instead. */
export const english: TaskTranslate = (key, params) => i18n.resolveTemplate(en[key] as string, params ?? {})

// Matches the CLI's limits line (`vector tasks list`): two decimals, never "<$0.01".
function usd(value: number) {
  return `$${value.toFixed(2)}`
}

/** "$3.10 of $25.00 subagent spend", "unknown of $25.00 …" or "$1.20 + unknown …" (I9: unknown is never $0). */
export function spendText(spend: NonNullable<Task.Limits["spend"]>, t: TaskTranslate = english) {
  const spent =
    spend.unknownSteps > 0
      ? spend.spentUsd > 0
        ? t("backgroundTasks.limits.spendPartlyUnknown", { spent: usd(spend.spentUsd) })
        : t("backgroundTasks.limits.spendUnknown")
      : usd(spend.spentUsd)
  const text =
    spend.limitUsd !== undefined
      ? t("backgroundTasks.limits.spendOf", { spent, limit: usd(spend.limitUsd) })
      : t("backgroundTasks.limits.spend", { spent })
  return spend.stopped ? t("backgroundTasks.limits.ceiling", { spend: text }) : text
}

/**
 * "5 of 8 running · 2 waiting · 12 of 32 started this request · $3.10 of $25.00 subagent spend". "waiting" only while
 * some launch waits for a slot; the spend only when the engine reports the request's delegated ledger.
 */
export function limitsLine(limits: Task.Limits, t: TaskTranslate = english) {
  return [
    t("backgroundTasks.limits.running", { running: limits.running, max: limits.maxRunning }),
    ...(limits.queued > 0 ? [t("backgroundTasks.limits.waiting", { count: limits.queued })] : []),
    t("backgroundTasks.limits.started", { launched: limits.launched, max: limits.maxPerRequest }),
    ...(limits.spend ? [spendText(limits.spend, t)] : []),
  ].join(" · ")
}

/** Limits as the engine sent them, or undefined for anything else (an older engine, a guest, a malformed answer). */
export function readLimits(value: unknown): Task.Limits | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const count = (key: string) =>
    typeof item[key] === "number" && Number.isFinite(item[key]) && (item[key] as number) >= 0
      ? (item[key] as number)
      : undefined
  const running = count("running")
  const queued = count("queued")
  const maxRunning = count("maxRunning")
  const launched = count("launched")
  const maxPerRequest = count("maxPerRequest")
  if (
    running === undefined ||
    queued === undefined ||
    maxRunning === undefined ||
    launched === undefined ||
    maxPerRequest === undefined
  )
    return undefined
  const spend = readSpend(item.spend)
  return { running, queued, maxRunning, launched, maxPerRequest, ...(spend ? { spend } : {}) }
}

function readSpend(value: unknown): Task.Limits["spend"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const finite = (key: string) =>
    typeof item[key] === "number" && Number.isFinite(item[key]) && (item[key] as number) >= 0
      ? (item[key] as number)
      : undefined
  const spentUsd = finite("spentUsd")
  const unknownSteps = finite("unknownSteps")
  if (spentUsd === undefined || unknownSteps === undefined) return undefined
  const limitUsd = finite("limitUsd")
  return {
    spentUsd,
    unknownSteps,
    ...(limitUsd !== undefined ? { limitUsd } : {}),
    warned: item.warned === true,
    stopped: item.stopped === true,
  }
}
