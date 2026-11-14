/** A shell the server can run, as `pty.shells` lists it. */
export type ShellOption = {
  path: string
  name: string
  /** False for a shell agent tool calls will not use (fish, nu), which the picker marks terminal only. */
  acceptable: boolean
}

export type ShellSelectOption = {
  id: string
  /** What is saved as the config's `shell`; the empty string is Auto. */
  value: string
  label: string
}

/**
 * The Terminal Shell picker's options: Auto first, then each listed shell by name, or by path where two share a name,
 * and last the saved shell when the list does not have it, so the picker never shows a different one.
 */
export function shellSelectOptions(input: {
  shells: readonly ShellOption[]
  current: string | undefined
  auto: string
  terminalOnly: string
}): ShellSelectOption[] {
  // A server that answers something other than a list (an older or a mock one) leaves just Auto and the saved shell,
  // rather than taking Settings down with it.
  const shells = Array.isArray(input.shells)
    ? input.shells.filter((shell) => typeof shell?.path === "string" && typeof shell?.name === "string")
    : []
  const nameCounts = new Map<string, number>()
  for (const shell of shells) nameCounts.set(shell.name, (nameCounts.get(shell.name) ?? 0) + 1)

  const options: ShellSelectOption[] = [
    { id: "auto", value: "", label: input.auto },
    ...shells.map((shell) => {
      const ambiguousName = (nameCounts.get(shell.name) ?? 0) > 1
      const text = ambiguousName ? shell.path : shell.name
      return {
        id: shell.path,
        // Prefer the name over the path: "bash" is much cleaner than its full route, even though PATH can change it.
        value: text,
        label: shell.acceptable ? text : `${text} (${input.terminalOnly})`,
      }
    }),
  ]

  // A listed shell saved by its path (zsh listed as "zsh", saved as "/bin/zsh") is that shell, not another option: a
  // second option would repeat its id, and the picker keys options by id.
  const current = input.current
  if (current && !options.some((option) => savedAs(option, current)))
    options.push({ id: current, value: current, label: current })

  return options
}

/** The option for the saved shell, or Auto when none is saved. */
export function selectedShellOption(options: readonly ShellSelectOption[], current: string) {
  return (
    options.find((option) => option.value === current) ??
    options.find((option) => savedAs(option, current)) ??
    options[0]!
  )
}

/** Whether `current`, the saved shell, names this option, by the value it saves or by its shell's path. */
function savedAs(option: ShellSelectOption, current: string) {
  return option.value === current || (option.value !== "" && option.id === current)
}
