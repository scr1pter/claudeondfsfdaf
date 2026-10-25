import { Schema } from "effect"
import DESCRIPTION from "./shell.txt"
import { PositiveInt } from "@vectordevai/core/schema"
import { Global } from "@vectordevai/core/global"
import { ShellID } from "./id"

const PS = new Set(["powershell", "pwsh"])
const CMD = new Set(["cmd"])
// The same for every shell: work that keeps running or waits for input goes to the terminal tool.
const TERMINAL_NOTE =
  "Long-running or interactive work (dev servers, watchers, REPLs, prompts that wait for input, ssh) belongs in the terminal tool: open it there, wait for it to be ready and read its output. Never start it here with & or nohup: this tool waits for every process it starts and gives it no input."

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema() {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "The command to execute" }),
    timeout: Schema.optional(PositiveInt).annotate({ description: "Optional timeout in milliseconds" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
    }),
  })
}

export const Parameters = parameterSchema()
export type Parameters = Schema.Schema.Type<typeof Parameters>

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`)
    return value
  })
}

function shellDisplayName(name: string) {
  if (name === "pwsh") return "PowerShell (7+)"
  if (name === "powershell") return "Windows PowerShell (5.1)"
  if (name === "cmd") return "cmd.exe"
  return name
}

function powershellNotes(name: string) {
  if (name === "pwsh") {
    return `# PowerShell (7+) shell notes
- This cross-platform shell supports pipeline chain operators (\`&&\` and \`||\`).
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick character.`
  }
  if (name === "powershell") {
    return `# Windows PowerShell (5.1) shell notes
- Use \`cmd1; if ($?) { cmd2 }\` to chain dependent commands.
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick character.`
  }
  return ""
}

function chainGuidance(name: string) {
  if (name === "powershell") {
    return "Combine known dependent operations in one call, such as a validated edit followed by tests and diff review. Windows PowerShell (5.1) does not support `&&`; use nested success conditionals such as `edit; if ($?) { tests; if ($?) { git diff --check } }`. Stop on failure."
  }
  return "Combine known dependent operations in one call, such as a validated edit followed by tests and diff review. Use `&&` so later operations run only after success; stop on failure. Wait for a result before constructing commands whose arguments depend on that result."
}

function bashCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `Before executing the command:
1. Directory verification: before creating files or directories, establish that the parent is the intended location. Reuse a prior listing or successful read when it already establishes this; check with \`test -d\` in the same command if it is unknown.
2. Quoting: always quote file paths that contain spaces with double quotes: mkdir "/Users/name/My Documents" works, mkdir /Users/name/My Documents fails.

Usage notes:
  - Commands time out after ${defaultTimeoutMs}ms unless you set a timeout.
  - ${TERMINAL_NOTE}
  - ${truncation(limits, "`head`, `tail`")}
  - Communicate directly instead of printing progress with echo/printf.
  - When issuing multiple commands:
    - Send independent commands as separate bash calls in one message so they run in parallel, such as "git status" and "git diff".
    - ${chain}
    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
    - Multiline scripts are allowed; explicitly propagate failures before dependent operations.`
}

// Output limits are the same for every shell; only the commands a model might reach for to cut output differ.
function truncation(limits: Limits, commands: string) {
  return `If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it is truncated and the full output is written to a file: read sections of it with Read (offset/limit) or search it with Grep. Do NOT use ${commands} or other truncation commands to limit output.`
}

function powershellCommandSection(
  name: string,
  chain: string,
  pathSep: string,
  limits: Limits,
  defaultTimeoutMs: number,
) {
  return `${powershellNotes(name)}

Before executing the command:
1. Directory verification: before creating files or directories, establish that the parent is the intended location. Reuse a prior listing or successful read when it already establishes this; check with \`Test-Path -LiteralPath <parent>\` in the same command if it is unknown.
2. Quoting: always quote file paths that contain spaces with double quotes: New-Item -ItemType Directory -Path "My Documents" works, New-Item -ItemType Directory -Path My Documents splits the path, and a script is run as & "path with spaces${pathSep}script.ps1".

Usage notes:
  - Commands time out after ${defaultTimeoutMs}ms unless you set a timeout.
  - ${TERMINAL_NOTE}
  - ${truncation(limits, "`Select-Object -First`, `Select-Object -Last`")}
  - Communicate directly instead of printing progress with Write-Output/Write-Host.
  - When issuing multiple commands:
    - Send independent commands as separate bash calls in one message so they run in parallel, such as "git status" and "git diff".
    - ${chain}
    - Use \`;\` only when you need to run commands sequentially but don't care if earlier commands fail
    - Multiline scripts are allowed; explicitly propagate failures before dependent operations.`
}

function cmdCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `# cmd.exe shell notes
- Use double quotes for paths with spaces.
- Use %VAR% for environment variables.
- Use \`if exist\` for existence checks.
- Use \`call\` when invoking batch files from another batch-style command.

Before executing the command:
1. Directory verification: before creating files or directories, establish that the parent is the intended location. Reuse a prior listing or successful read when it already establishes this; check with \`if exist\` in the same command if it is unknown.
2. Quoting: always quote file paths that contain spaces with double quotes: mkdir "My Documents" works, mkdir My Documents splits the path, and a batch file is run as call "path with spaces\\script.bat".

Usage notes:
  - Commands time out after ${defaultTimeoutMs}ms unless you set a timeout.
  - ${TERMINAL_NOTE}
  - ${truncation(limits, "`more`")}
  - Communicate directly instead of printing progress with echo.
  - When issuing multiple commands:
    - Send independent commands as separate bash calls in one message so they run in parallel, such as "dir" and "where cmd".
    - ${chain}
    - Use \`&\` only when you need to run commands sequentially but don't care if earlier commands fail
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)`
}

function profile(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const isPowerShell = PS.has(name)
  const chain = chainGuidance(name)
  if (CMD.has(name)) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with an optional timeout.`,
      workdirSection:
        "Commands run in the current working directory. To run one in another directory, set the `workdir` parameter; AVOID changing directories inside the command.",
      commandSection: cmdCommandSection(chain, limits, defaultTimeoutMs),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction: "Create PR using a temporary body file so cmd.exe quoting stays simple.",
      createPrExample: `(\n  echo ## Summary\n  echo - ^<1-3 bullet points^>\n) > pr-body.txt\ngh pr create --title "the pr title" --body-file pr-body.txt`,
    }
  }
  if (isPowerShell) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with an optional timeout.`,
      workdirSection:
        "Commands run in the current working directory. To run one in another directory, set the `workdir` parameter; AVOID changing directories inside the command.",
      commandSection: powershellCommandSection(
        name,
        chain,
        platform === "win32" ? "\\" : "/",
        limits,
        defaultTimeoutMs,
      ),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction: "Create PR using gh pr create with a PowerShell here-string to pass the body correctly.",
      createPrExample: `gh pr create --title "the pr title" --body @'
## Summary
- <1-3 bullet points>
'@`,
    }
  }
  return {
    intro: "Executes a given bash command with an optional timeout.",
    workdirSection:
      "Commands run in the current working directory. To run one in another directory, set the `workdir` parameter; AVOID `cd <directory> && <command>`.",
    commandSection: bashCommandSection(chain, limits, defaultTimeoutMs),
    gitCommands: "bash commands",
    gitCommandRestriction: "git bash commands",
    createPrInstruction:
      "Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.",
    createPrExample: `gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>`,
  }
}

export function render(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const selected = profile(name, platform, limits, defaultTimeoutMs)
  return {
    description: renderPrompt(DESCRIPTION, {
      intro: selected.intro,
      os: platform,
      shell: name,
      tmp: Global.Path.tmp,
      workdirSection: selected.workdirSection,
      commandSection: selected.commandSection,
      gitCommands: selected.gitCommands,
      toolName: ShellID.ToolID,
      gitCommandRestriction: selected.gitCommandRestriction,
      createPrInstruction: selected.createPrInstruction,
      createPrExample: selected.createPrExample,
    }),
    parameters: parameterSchema(),
  }
}

export * as ShellPrompt from "./prompt"
