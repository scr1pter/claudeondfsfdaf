import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { Vault } from "@vectordevai/schema/vault"
import type { VaultRestoreResult, VaultStatus, VaultVersions } from "@/context/platform"

/*
 * Settings → Memory → Backup (WP A45), as the app reads it. The desktop's main process encrypts the memory with the
 * vault key, keeps that key sealed with the OS credential store, and runs the nightly backup
 * (packages/desktop/src/main/vault-backup.ts). Brain Vault on Vector is offered only while the account's status lists
 * `vault` with a plan whose storage is above zero (H1), and the Vault API decides every upload (S1); the GitHub backend
 * is free on every plan. This only decides what the tab shows.
 */

/** The tab Settings → Memory adds on the desktop, after its own. */
export const BACKUP_TAB = { value: "backup", label: "Backup" } as const

/**
 * Brain Vault on Vector, when the account's plan includes it and vectordev.ai lists it: the plan's storage (decimal
 * gigabytes) and the days of versions kept, both from the plan's entitlements.
 */
export function vectorOffer(status: ModelPlanStatus.Status | undefined) {
  const vault = status?.entitlements?.vault as { gb?: unknown; versionDays?: unknown } | undefined
  if (!status?.signedIn || status.error || !status.listed?.includes("vault")) return undefined
  if (typeof vault?.gb !== "number" || vault.gb <= 0) return undefined
  return {
    gb: vault.gb,
    ...(typeof vault.versionDays === "number" && vault.versionDays > 0 ? { versionDays: vault.versionDays } : {}),
  }
}

/** Sizes in decimal units, as storage is sold and as the plan states it. */
export function bytes(count: number) {
  if (count < 1000) return `${count} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = count
  let unit = -1
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** "today at 03:12", "yesterday at 03:12", or the date. */
export function when(at: number, now: number) {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((day(new Date(now)) - day(date)) / 86_400_000)
  if (days === 0) return `today at ${time}`
  if (days === 1) return `yesterday at ${time}`
  return `${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} at ${time}`
}

/** Where backups go, as a sentence. */
export function placeLine(status: VaultStatus) {
  if (status.backend === "vector") return "Backups go to Brain Vault on Vector."
  return status.githubRepo
    ? `Backups go to your private GitHub repository ${status.githubRepo}.`
    : "Choose a private GitHub repository of your own for the backups."
}

/** The line under Back up now: the last backup, what is running, or how to start. */
export function lastLine(status: VaultStatus, now: number) {
  if (status.running === "backup") return "Backing up…"
  if (status.running === "restore") return "Restoring…"
  if (status.last)
    return `Last backup ${when(status.last.at, now)}: ${status.last.files} memory file${status.last.files === 1 ? "" : "s"}, ${bytes(status.last.sentBytes)} sent.`
  return status.hasVault
    ? "No backup from this computer yet."
    : "Back up once to create your vault and get its recovery code."
}

/** When the nightly backup runs next, while it is on. */
export function nextLine(status: VaultStatus, now: number) {
  if (!status.enabled) return undefined
  if (!status.hasVault) return "Nightly backups start after your first backup."
  if (status.nextAt === undefined) return undefined
  return status.nextAt <= now + 60_000
    ? "The next backup runs shortly."
    : `Next backup ${when(status.nextAt, now)}, if Vector is open.`
}

/** What a restore did, as one line. */
export function restoreLine(result: VaultRestoreResult) {
  const totals = result.totals
  if (!result.ok || !totals) return result.message
  const parts = [
    `${totals.active} in use${totals.pinned ? ` (${totals.pinned} pinned)` : ""}`,
    `${totals.waiting} waiting for your review as before`,
    totals.known ? `${totals.known} already in memory` : undefined,
    totals.refused ? `${totals.refused} refused (forgotten here, or past what may wait for review)` : undefined,
  ].filter((part): part is string => part !== undefined)
  const notes = [
    totals.unreadable || totals.newer
      ? "Parts of this backup need a newer Vector; update Vector to restore them too."
      : undefined,
    totals.documents
      ? "Documents are not part of a restore: add their files again for Vector to read them."
      : undefined,
  ].filter((note): note is string => note !== undefined)
  return [`${result.message} ${parts.join(", ")}.`, ...notes].join(" ")
}

/** Storage used, from the versions listing: the plan's quota on Vector, the repository's size on GitHub. */
export function usageLine(versions: VaultVersions | undefined) {
  if (!versions?.ok) return undefined
  if (versions.usage) return `Using ${bytes(versions.usage.usedBytes)} of ${bytes(versions.usage.quotaBytes)}.`
  if (versions.storedBytes !== undefined) return `The vault takes ${bytes(versions.storedBytes)} in the repository.`
  return undefined
}

/** A read-only vault (a paused or ended plan): no new backups, restore still works, and when it is deleted. */
export function readOnlyLine(versions: VaultVersions | undefined, now: number) {
  if (!versions?.ok || !versions.readOnly) return undefined
  return `Your vault takes no new backups while your plan is paused or has ended; restoring still works.${versions.deleteAt ? ` It is deleted ${when(versions.deleteAt, now)}.` : ""}`
}

/** owner/repo as GitHub names it. */
export function repoValid(input: string) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(input.trim())
  return Boolean(match && match[2] !== "." && match[2] !== ".." && !match[2]!.endsWith(".git"))
}

export const RECOVERY_COPY =
  "Write it down and keep it somewhere safe. It is the only way to restore these backups on another computer: Vector never sees it and cannot recover it."

export const GITHUB_COPY = `A private repository of its own, which holds nothing but the vault. Vector checks it is private before every push and keeps the ${Vault.LIMIT.githubVersions} newest versions. git pushes with your own GitHub sign-in, so nothing goes to Vector.`

/** What Brain Vault on Vector keeps, with the plan's own numbers. */
export function vectorCopy(offer: ReturnType<typeof vectorOffer>) {
  const kept = offer
    ? ` Your plan keeps up to ${offer.gb} GB${offer.versionDays ? ` and ${offer.versionDays} days of versions` : ""}.`
    : ""
  return `Vector stores only what was encrypted on this computer and cannot read it.${kept}`
}
