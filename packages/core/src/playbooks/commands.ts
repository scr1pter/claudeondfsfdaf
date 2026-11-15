export * as PlaybookCommands from "./commands"

import { check, helper } from "../brain/skill"

// The skill command allowlist (WP A36): which commands a Vector playbook may name. These are the learned skills' own
// rules (BrainSkill's `simple`, `helper` and `check`, its section 2.3), re-exported so there is one list (B01; Codium
// finish R36). Importing this module loads the Brain modules behind brain/skill.ts, and with them global.ts, which
// creates Vector's data, config, state, cache and temporary folders.
//
// A command is either a read-only helper or one check. Anything else would run unasked under the shell's defaults.

export { TARGETS, DENY_WORDS, CHECK_ENV, simple, helper, check } from "../brain/skill"

/** Whether a playbook may name `command`: a read-only helper or a check. */
export function allowed(command: string) {
  return helper(command) || check(command)
}
