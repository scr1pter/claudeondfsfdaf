// These known desktop input and capture paths stay with the consented computer tool while it holds a lease.
// This is a denylist, not an interpreter or a claim about the contents of arbitrary programs on disk.
const PROGRAMS = new Set([
  "screencapture",
  "screencaptureui",
  "cliclick",
  "osascript",
  "hammerspoon",
  "xdotool",
  "ydotool",
  "ydotoold",
  "dotool",
  "dotoolc",
  "wtype",
  "xte",
  "xvkbd",
  "wmctrl",
  "scrot",
  "gnome-screenshot",
  "grim",
  "grimshot",
  "maim",
  "xwd",
  "flameshot",
  "spectacle",
  "wf-recorder",
  "wl-screenrec",
  "recordmydesktop",
  "kazam",
  "autohotkey",
  "autohotkey32",
  "autohotkey64",
  "autohotkeyu32",
  "autohotkeyu64",
  "autohotkeya32",
  "autoit3",
  "autoit3_x64",
  "nircmd",
  "nircmdc",
  "snippingtool",
  "screenclippinghost",
  "psr",
  "computer-control-mcp",
])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh"])
const RUNTIMES =
  /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*|node|bun|deno|ruby|perl|php|lua|swift|osascript|electron|tsx|ts-node)$/
const WRAPPERS = new Set([
  "env",
  "sudo",
  "doas",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "nice",
  "timeout",
  "stdbuf",
  "xargs",
  "xcrun",
])
const VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  env: ["-u", "--unset", "-C", "--chdir"],
  sudo: [
    "-u",
    "--user",
    "-g",
    "--group",
    "-h",
    "--host",
    "-p",
    "--prompt",
    "-C",
    "--close-from",
    "-T",
    "--command-timeout",
    "-D",
    "--chdir",
  ],
  doas: ["-u", "-C"],
  exec: ["-a"],
  time: ["-f", "--format", "-o", "--output"],
  nice: ["-n", "--adjustment"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
  xargs: [
    "-I",
    "--replace",
    "-L",
    "--max-lines",
    "-n",
    "--max-args",
    "-s",
    "--max-chars",
    "-P",
    "--max-procs",
    "-d",
    "--delimiter",
    "-E",
    "--eof",
    "-a",
    "--arg-file",
  ],
  xcrun: ["--sdk", "-sdk", "--toolchain", "-toolchain"],
}
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "}"])
const PYTHON_UI =
  /(?:\b(?:from|import)\s+(?:pyautogui|pynput|pywinauto|pyscreenshot|Quartz|AppKit|mss|keyboard|mouse)\b|\b(?:from\s+PIL\s+import[^;\n]*\bImageGrab|(?:from|import)\s+PIL\.ImageGrab)\b|\b(?:pyautogui|pynput|pywinauto|pyscreenshot|ImageGrab)\s*\.|(?:__import__|import_module)\s*\(\s*["'](?:pyautogui|pynput|pywinauto|pyscreenshot|mss)["'])/i
const JS_UI =
  /(?:(?:\brequire\s*\(\s*|\bimport\s*\(?\s*|\bfrom\s+)["'](?:robotjs|@nut-tree\/nut-js|@nut-tree-fork\/nut-js|screenshot-desktop|node-screenshots)["']|\bdesktopCapturer\s*\.\s*getSources\b)/i
const NATIVE_UI =
  /\b(?:CGEventPost|CGEventPostToPid|CGEventCreateMouseEvent|CGEventCreateKeyboardEvent|CGWindowListCreateImage|CGDisplayCreateImage|AXUIElementPerformAction|SCStream|SCScreenshotManager)\s*[.(]/
const WINDOWS_UI =
  /(?:\b(?:SendInput|mouse_event|keybd_event|SetCursorPos|PrintWindow|BitBlt|CopyFromScreen)\s*(?:\(|$)|\bSendKeys\b[^\n;]{0,100}(?:SendWait|Send)\s*(?:\(|$)|\bWScript\s*\.\s*Shell\b|\bWindows\s*\.\s*Graphics\s*\.\s*Capture\b)/i

/** Inspect known command names and inline UI APIs without executing or reading any program. */
export function controls(command: string): boolean {
  return sourceControls(command, 0)
}

/** Also usable with the shell tool's parsed command words, before any process starts. */
export function controlsTokens(tokens: readonly string[]): boolean {
  return commandControls(tokens.map(unquote), 0)
}

function sourceControls(source: string, depth: number): boolean {
  if (depth > 8) return false
  const lines = source.split("\n")
  const ordinary: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const delimiter = heredocDelimiter(line)
    if (!delimiter) {
      ordinary.push(line)
      continue
    }
    const body: string[] = []
    while (++index < lines.length && lines[index].trim() !== delimiter) body.push(lines[index])
    // A heredoc is data for ordinary file commands, but source for an interpreter reading standard input.
    if (statements(line).some((words) => commandControls(words, depth, body.join("\n")))) return true
    ordinary.push(line)
  }
  return statements(ordinary.join("\n")).some((words) => commandControls(words, depth))
}

function commandControls(tokens: readonly string[], depth: number, stdin?: string): boolean {
  if (!tokens.length || depth > 8) return false
  const first = tokens[0]
  if (/^\$[A-Za-z_]\w*$/.test(first) && tokens[1] === "=") return commandControls(tokens.slice(2), depth, stdin)
  if (/^[A-Za-z_]\w*=/.test(first) || KEYWORDS.has(first.toLowerCase()))
    return commandControls(tokens.slice(1), depth, stdin)
  // A leading redirection names its file before the command.
  if (/^\d*(?:>>?|<)$/.test(first)) return commandControls(tokens.slice(2), depth, stdin)
  const name = basename(first)
  const args = tokens.slice(1)
  if (PROGRAMS.has(name)) return true
  if (WRAPPERS.has(name)) {
    const index = executable(args, Object.hasOwn(VALUE_OPTIONS, name) ? VALUE_OPTIONS[name] : [], name === "timeout")
    if (name === "command" && args.slice(0, index).some((word) => /^-[pvV]*[vV][pvV]*$/.test(word))) return false
    if (name === "xcrun" && args.slice(0, index).some((word) => word === "--find" || word === "-f")) return false
    if (name === "env") {
      const split = args.findIndex((word) => word === "-S" || word === "--split-string")
      if (split >= 0) return sourceControls(args.slice(split + 1).join(" "), depth + 1)
      const attached = args.find((word) => /^--split-string=|^-S.+/.test(word))
      if (attached) return sourceControls(attached.replace(/^--split-string=|^-S/, ""), depth + 1)
    }
    return commandControls(args.slice(index), depth + 1, stdin)
  }
  if (name === "npx" || name === "bunx" || name === "pnpx")
    return commandControls(args.slice(executable(args, ["-p", "--package"])), depth + 1, stdin)
  if (name === "uvx" || (name === "uv" && args[0] === "tool" && args[1] === "run")) {
    const run = name === "uvx" ? args : args.slice(2)
    const index = executable(run, ["-p", "--python", "--from", "--with", "--directory", "--project"])
    const program = run[index]?.replace(/(?:@|==).+$/, "")
    return program !== undefined && commandControls([program, ...run.slice(index + 1)], depth + 1, stdin)
  }
  if (
    ["npm", "pnpm", "yarn", "bun", "uv", "poetry", "pipenv"].includes(name) &&
    /^(?:exec|x|dlx|run)$/.test(args[0] ?? "")
  )
    return commandControls(
      args.slice(1 + executable(args.slice(1), ["-p", "--package", "--cwd", "--directory"])),
      depth + 1,
      stdin,
    )
  if (name === "find") {
    const at = args.findIndex((word) => ["-exec", "-execdir", "-ok", "-okdir"].includes(word))
    return at >= 0 && commandControls(args.slice(at + 1), depth + 1)
  }
  if (name === "eval") return sourceControls(args.join(" "), depth + 1)
  if (name === "trap") return args[0] !== undefined && sourceControls(args[0], depth + 1)
  if (name === "start-process" || name === "start") {
    const file = args.findIndex((word) => /^-filepath$/i.test(word))
    const index =
      file >= 0
        ? file + 1
        : executable(
            args.map((word) => word.toLowerCase()),
            ["-argumentlist", "-workingdirectory", "-windowstyle", "-verb"],
          )
    return commandControls(args.slice(index, index + 1), depth + 1)
  }
  if (name === "import" || ((name === "magick" || name === "gm") && args[0]?.toLowerCase() === "import")) return true
  if (name === "ffmpeg" || name === "avconv")
    return args.some(
      (word, index) =>
        (word === "-f" && /^(?:gdigrab|x11grab|xcbgrab|avfoundation|kmsgrab)$/.test(args[index + 1] ?? "")) ||
        /^-f=(?:gdigrab|x11grab|xcbgrab|avfoundation|kmsgrab)$/.test(word) ||
        /screen-capture-recorder/i.test(word),
    )
  if (SHELLS.has(name)) {
    const at = args.findIndex((word) =>
      name === "powershell" || name === "pwsh"
        ? /^-(?:command|c|commandwithargs)$/i.test(word)
        : name === "cmd"
          ? /^\/[ck]$/i.test(word)
          : /^-[a-z]*c[a-z]*$|^--command$/.test(word),
    )
    const code = at >= 0 ? args.slice(at + 1).join(" ") : readsStdin(args) ? stdin : undefined
    if (code === undefined) return false
    return sourceControls(code, depth + 1)
  }
  if (RUNTIMES.test(name)) {
    const at = args.findIndex((word) => /^(?:-[A-Za-z]*[ecprE]|--(?:eval|print))$/.test(word))
    const attached = args.find((word) => /^--(?:eval|print)=/.test(word))
    const module = args.indexOf("-m")
    if (module >= 0 && /^(?:pyautogui|pynput|pywinauto|pyscreenshot|mss)$/.test(args[module + 1] ?? "")) return true
    const code =
      attached?.slice(attached.indexOf("=") + 1) ??
      (at >= 0 ? args.slice(at + 1).join(" ") : readsStdin(args) ? stdin : undefined)
    return (
      code !== undefined && (PYTHON_UI.test(code) || JS_UI.test(code) || NATIVE_UI.test(code) || WINDOWS_UI.test(code))
    )
  }
  // PowerShell can invoke these APIs directly, without an explicit powershell.exe wrapper.
  return (["add-type", "new-object"].includes(name) && WINDOWS_UI.test(args.join(" "))) || WINDOWS_UI.test(first)
}

function heredocDelimiter(line: string) {
  let quote: string | undefined
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === "\\" && quote !== "'") {
      index++
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return undefined
    if (char !== "<" || line[index + 1] !== "<") continue
    if (line[index + 2] === "<") {
      index += 2
      continue
    }
    const match = /^<<-?\s*(?:'([\w-]+)'|"([\w-]+)"|([\w-]+))/.exec(line.slice(index))
    if (match) return match[1] ?? match[2] ?? match[3]
  }
  return undefined
}

function readsStdin(args: readonly string[]) {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    if (word === "-" || /^\d*<</.test(word)) return true
    if (word === "--") return args[index + 1] === undefined || args[index + 1] === "-"
    if (["-W", "-X", "--check-hash-based-pycs", "--input-type"].includes(word)) {
      index++
      continue
    }
    if (word.startsWith("-")) continue
    return false
  }
  return true
}

function executable(args: readonly string[], values: readonly string[], duration = false) {
  let index = 0
  for (; index < args.length; index++) {
    const word = args[index]
    if (word === "--") return index + 1
    if (values.includes(word)) {
      index++
      continue
    }
    if (word.startsWith("-") || /^[A-Za-z_]\w*=/.test(word) || (duration && /^\d+(?:\.\d+)?[smhd]?$/.test(word)))
      continue
    break
  }
  return index
}

function basename(value: string) {
  return value
    .replace(/\^([A-Za-z])/g, "$1")
    .split(/[\\/]/)
    .at(-1)!
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/, "")
}

function unquote(value: string) {
  return value.replace(/^(['"])([\s\S]*)\1$/, "$2")
}

/** Only command boundaries and quoting are needed here; the engine retains its full grammar-based shell checks. */
function statements(source: string) {
  const result: string[][] = []
  const nested: { quote?: string; tick: boolean }[] = []
  let words: string[] = []
  let word = ""
  let quote: string | undefined
  const end = () => {
    if (word) words.push(word)
    word = ""
  }
  const cut = () => {
    end()
    if (words.length) result.push(words)
    words = []
  }
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (char === "\\") {
      // Windows executable paths keep their directory separators. POSIX quoted/escaped words are joined normally.
      if (/^[A-Za-z]:|^\\/.test(word) || (word === "" && next === "\\")) {
        word += char
        continue
      }
      if (next !== "\n") word += next ?? ""
      index++
      continue
    }
    if (char === "$" && next === "(") {
      cut()
      nested.push({ quote, tick: false })
      quote = undefined
      index++
      continue
    }
    if (char === "`") {
      cut()
      if (nested.at(-1)?.tick) quote = nested.pop()!.quote
      else {
        nested.push({ quote, tick: true })
        quote = undefined
      }
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else word += char
      continue
    }
    if (char === ")" && nested.length && !nested.at(-1)!.tick) {
      cut()
      quote = nested.pop()!.quote
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "#" && !word) {
      const end = source.indexOf("\n", index)
      index = end < 0 ? source.length : end - 1
      continue
    }
    if (char === "&" && (word.endsWith(">") || word.endsWith("<") || next === ">")) {
      word += char
      continue
    }
    if (/[;&|\n(){}]/.test(char)) {
      cut()
      continue
    }
    if (/\s/.test(char)) {
      end()
      continue
    }
    word += char
  }
  cut()
  return result
}

export * as ComputerCommand from "./computer-command"
