// These controls only override Vector's CLI when explicitly requested. An omitted control keeps the harness's
// existing behavior, while a typo must fail before any fixture processes are started.
export function footprintControls(argv: readonly string[]) {
  const value = (name: string, choices: readonly string[]) => {
    const flag = `--${name}`
    const at = argv.indexOf(flag)
    if (at === -1) return undefined
    if (argv.lastIndexOf(flag) !== at) throw new Error(`${flag} may only be given once`)
    const result = argv[at + 1]
    if (!result || !choices.includes(result)) throw new Error(`${flag} must be one of: ${choices.join(", ")}`)
    return result
  }
  return {
    taskSize: value("task-size", ["auto", "chat", "light", "standard", "thorough"]),
    judge: value("judge", ["off", "thorough", "changes"]),
  }
}

export function footprintControlArgs(controls: ReturnType<typeof footprintControls>) {
  return [
    ...(controls.taskSize ? ["--size", controls.taskSize] : []),
    ...(controls.judge ? ["--judge", controls.judge] : []),
  ]
}
