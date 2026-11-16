import type { Computer } from "@vectordevai/schema/computer"
import type { useDialog } from "@vectordevai/ui/context/dialog"

/**
 * Opens onboarding for a draft that stays in the composer. It passes no example handler, so Try it never replaces the
 * pill draft the user is setting up for; Finish only turns Hands on.
 */
export async function openComputerSetup(
  dialog: ReturnType<typeof useDialog>,
  computer: Computer.ComputerPlatform,
  options: { active?: () => boolean; onFinished?: () => void } = {},
) {
  const { showComputerOnboarding } = await import("./onboarding")
  if (options.active && !options.active()) return
  showComputerOnboarding(dialog, { computer, onFinished: options.onFinished })
}
