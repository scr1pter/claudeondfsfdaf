export * as PlaybookCommands from "./commands"

import { check, helper } from "../brain/command-allowlist"

// Playbook checks and learned skills share these rules. The publisher can validate them before Vector storage exists.
//
// A command is either a read-only helper or one check. Anything else would run unasked under the shell's defaults.

export { TARGETS, DENY_WORDS, CHECK_ENV, simple, helper, check } from "../brain/command-allowlist"

/** Whether a playbook may name `command`: a read-only helper or a check. */
export function allowed(command: string) {
  return helper(command) || check(command)
}
