import { expect, test } from "bun:test"
import path from "node:path"

// Every Windows `vector upgrade` downloads the live installer (/install.ps1) and runs it detached in Windows PowerShell
// 5.1 (standalone.ts), then waits 310 s for "prepared". A cmdlet sends PowerShell through command discovery and module
// auto-load first; in the deferred-removal worker that stalled CI for 30 s between "preparing" and "prepared"
// (ci-harness-repairs.md, 2026-11-20). These checks keep the installer's status writer, its identity and exit waits and
// its hashes on operators and .NET only, as windows-remove.ts is. They read the script; no PowerShell runs here.
const installerPath = path.resolve(import.meta.dir, "../../../web/public/install.ps1")
const verifierPath = path.resolve(import.meta.dir, "../../script/verify-windows-installer.ts")
// verify-windows-installer.ts lifts the status writer out of the installer with this pattern and runs it in real
// Windows PowerShell 5.1, so the writer's first line has to keep matching it.
const writerPattern = /^function Write-OperationStatus\([^\n]+\) \{[\s\S]*?^\}/m
// The class of characters the writer JSON-escapes as \uXXXX in each string value: backslash, quote and controls.
const escapeClass = String.raw`[\\"\x00-\x1f]`
// The script's own functions that may run on these paths. Assert-Regular is the script's own too, but it runs
// Get-Item, so a call to it would bring a cmdlet back.
const checked = ["Write-OperationStatus", "parentTicks", "fileSha256"]
const keywords = [
  ...["try", "catch", "finally", "if", "elseif", "else", "while", "do", "until", "for", "foreach", "function"],
  ...["param", "return", "throw", "exit", "break", "continue", "switch", "trap"],
]
const literals = /'(?:[^']|'')*'|"(?:[^"`]|`.)*"|#[^\n]*/g

async function installer() {
  const raw = await Bun.file(installerPath).text()
  // A Windows checkout may turn LF into CRLF; the served file is the repository's LF bytes.
  return { raw, text: raw.replaceAll("\r\n", "\n") }
}

// Blank string literals and comments without moving any offset, so a block found in the code is the same span of the
// script's text. Strings and comments may hold any words; only code can invoke a command.
function blank(text: string) {
  return text.replace(literals, (found) =>
    found.startsWith("#")
      ? found.replace(/[^\n]/g, " ")
      : found[0] + found.slice(1, -1).replace(/[^\n]/g, " ") + found[0],
  )
}

// The span from `from` through the "}" that closes the first "{" at or after it.
function block(code: string, from: number) {
  const open = code.indexOf("{", from)
  if (open < 0) return undefined
  let depth = 0
  for (let index = open; index < code.length; index++) {
    if (code[index] === "{") depth++
    if (code[index] === "}" && --depth === 0) return { start: from, end: index + 1 }
  }
  return undefined
}

// Every word in code that PowerShell could resolve as a command: any Verb-Noun word, whatever its case or verb, and any
// bare word where PowerShell expects a command (line start, after ; { } ( | = &, return or throw). The symbol aliases
// % (ForEach-Object) and ? (Where-Object) and the dot-source operator count as words there too.
function commands(code: string) {
  return [
    ...(code.match(/\b[a-z]\w*-[a-z]\w*/gi) ?? []),
    ...[...code.matchAll(/(?<=(?:^|[;{}(|=&]|\breturn|\bthrow)[ \t]*)(?<![\w-])([a-z_][\w-]*|[%?.](?=[ \t]))/gim)].map(
      (found) => found[1],
    ),
  ]
}

// Evaluates the writer's `$json = ...` line, which joins single-quoted literals and [regex]::Replace calls with +, the
// way PowerShell would: the evaluator turns each matched character into \u and four lowercase hex digits.
function render(assignment: string, values: Record<string, string>) {
  const token = /[ \t]*(?:'((?:[^']|'')*)'|\[regex\]::Replace\(\$(\w+), '((?:[^']|'')*)', \$escape\))[ \t]*(\+|$)/y
  let json = ""
  while (true) {
    const at = token.lastIndex
    const found = token.exec(assignment)
    if (!found) throw new Error(`The status JSON expression changed shape at: ${assignment.slice(at)}`)
    if (found[1] !== undefined) json += found[1].replaceAll("''", "'")
    else {
      const value = values[found[2].toLowerCase()]
      if (value === undefined) throw new Error(`The status JSON reads an unexpected variable: $${found[2]}`)
      json += value.replace(
        new RegExp(found[3].replaceAll("''", "'"), "g"),
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
    }
    if (found[4] === "") return json
  }
}

test("install.ps1's deferred upgrade path runs no cmdlet that needs command discovery", async () => {
  const { raw, text } = await installer()
  // Windows PowerShell 5.1 reads a BOM-less script as ANSI, so the served bytes stay ASCII.
  expect(raw.match(/[^\t\n\r\x20-\x7e]/g) ?? []).toEqual([])
  const code = blank(text)
  const spans: Record<string, { code: string; text: string } | undefined> = {}
  const cut = (at: number | undefined) => {
    const span = at === undefined ? undefined : block(code, at)
    return span && { code: code.slice(span.start, span.end), text: text.slice(span.start, span.end) }
  }
  for (const name of checked) {
    const definitions = [...code.matchAll(new RegExp(String.raw`^function ${name}\b`, "gm"))]
    spans[name] = definitions.length === 1 ? cut(definitions[0].index) : undefined
  }
  // The identity check, the acknowledgement wait and the exit wait of a deferred upgrade.
  const anchor = code.indexOf("if ($WaitForProcessId -gt 0) {")
  spans.WaitForProcessId =
    anchor >= 0 && anchor === code.lastIndexOf("if ($WaitForProcessId -gt 0) {") ? cut(anchor) : undefined
  const allowed = new Set([...keywords, ...checked.map((name) => name.toLowerCase())])
  expect(
    Object.entries(spans).flatMap(([name, span]) =>
      span
        ? commands(span.code)
            .filter((word) => !allowed.has(word.toLowerCase()))
            .map((word) => `${name}: ${word}`)
        : [],
    ),
  ).toEqual([])
  expect(
    Object.entries(spans)
      .filter(([, span]) => !span)
      .map(([name]) => name),
  ).toEqual([])
  // A double-quoted string runs its $( ) subexpressions, which the blanking above would hide.
  expect(
    Object.values(spans).flatMap((span) =>
      [...span!.text.matchAll(literals)]
        .map((found) => found[0])
        .filter((found) => found.startsWith('"') && found.includes("$(")),
    ),
  ).toEqual([])

  // The waits keep their deadlines (10 s for the acknowledgement, 15 min for the exit), their polling and messages.
  const waits = spans.WaitForProcessId!.text
  for (const kept of [
    "$expected = $WaitForStartTicks.ToString()",
    "if ((parentTicks) -ne $expected) { throw 'The upgrading process identity changed before preparation.' }",
    "[DateTime]::UtcNow.AddSeconds(10)",
    "while (-not [IO.File]::Exists($acknowledgement)) {",
    "if ((parentTicks) -ne $expected -or [DateTime]::UtcNow -gt $ackDeadline) { throw 'Vector did not acknowledge the prepared update; the existing installation remains unchanged.' }",
    "[Threading.Thread]::Sleep(50)",
    "if ([IO.File]::GetAttributes($acknowledgement) -band [IO.FileAttributes]::ReparsePoint) { throw 'An installation file is a link or is not a regular file.' }",
    "if ([IO.File]::ReadAllText($acknowledgement) -cne \"ready`n\") { throw 'Invalid prepared-update acknowledgement.' }",
    "[DateTime]::UtcNow.AddMinutes(15)",
    "while ($null -ne ($ticks = parentTicks)) {",
    "if ($ticks -ne '' -and $ticks -ne $expected) { throw 'The upgrading process identity changed.' }",
    "if ([DateTime]::UtcNow -gt $deadline) { throw 'Timed out waiting for Vector to exit; the old version remains installed.' }",
    "[Threading.Thread]::Sleep(200)",
  ])
    expect(waits).toContain(kept)
  // parentTicks gives $null once the process is gone and '' while it is exiting, which the exit wait relies on.
  expect(spans.parentTicks!.text).toContain(
    "try { $process = [Diagnostics.Process]::GetProcessById($WaitForProcessId) } catch { if ($_.Exception.GetBaseException() -is [ArgumentException]) { return $null }; throw }",
  )
  expect(spans.parentTicks!.text).toContain("catch { return '' } finally { $process.Dispose() }")

  // Existing binary, archive, new binary, and staged or promoted holder hashes use the same function.
  expect(text.toLowerCase()).not.toContain("get-filehash")
  expect(text.match(/\bfileSha256\b/g) ?? []).toHaveLength(5)
  for (const site of [
    "(fileSha256 $destination) -cne $fields[6]",
    "(fileSha256 $archive) -cne $release.sha256",
    "$binaryHash = fileSha256 $stagedBinary",
    "(fileSha256 $path) -cne $digest",
  ])
    expect(text).toContain(site)
  expect(spans.fileSha256!.text).toContain("$stream = [IO.File]::OpenRead($path)")
  expect(spans.fileSha256!.text).toContain(
    "[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()",
  )
  // The FIPS-validated class Windows PowerShell 5.1's own file hash command uses. SHA256::Create() and
  // HashAlgorithm::Create('SHA256') give SHA256Managed, which throws where policy allows only FIPS algorithms.
  expect(spans.fileSha256!.text).toContain("$sha = [Security.Cryptography.SHA256CryptoServiceProvider]::new()")
  expect(code).not.toMatch(/SHA256\]::Create|SHA256Managed|HashAlgorithm\]::Create/i)

  // The Windows CI checkpoint still finds the same status writer.
  expect(await Bun.file(verifierPath).text()).toContain(String(writerPattern))
  expect(text).toContain("\nfunction Write-OperationStatus([string]$state, [string]$message) {\n")
  expect(text.match(writerPattern)?.[0]).toBe(spans["Write-OperationStatus"]!.text)
})

test("install.ps1's status writer escapes JSON the way JSON.parse reads it back", async () => {
  const writer = (await installer()).text.match(writerPattern)?.[0] ?? ""
  expect(
    [...writer.matchAll(/\[regex\]::Replace\(\$(\w+), '((?:[^']|'')*)', \$escape\)/g)].map((found) => [
      found[1],
      found[2],
    ]),
  ).toEqual([
    ["state", escapeClass],
    ["Version", escapeClass],
    ["message", escapeClass],
  ])
  expect(writer).toContain("$escape = { param($found) '\\u{0:x4}' -f [int][char]$found.Value }")
  const assignment = writer.match(/^[ \t]*\$json = (.+)$/m)?.[1] ?? ""
  const controls = String.fromCharCode(...Array.from({ length: 0x20 }, (_, code) => code))
  for (const value of [
    { state: "preparing", version: "latest", message: controls },
    { state: "prepared", version: "beta", message: '"' },
    { state: "failed", version: "1.99.42", message: "\\" },
    {
      state: "failed",
      version: "1.99.43-beta.1",
      message: 'Could not replace C:\\Program Files\\Vector "beta"\\it\'s\\vector.exe\r\n\tretry',
    },
    {
      state: "complete",
      version: "1.99.42",
      message: "Vector \u00e9t\u00e9 \u65e5\u672c\u8a9e \u2713 \ud83d\ude80 installed.",
    },
    { state: 'odd "state" \\', version: "\u0001", message: "" },
  ]) {
    const json = render(assignment, value)
    // JSON.parse refuses a raw control character inside a string, so this also proves every control was escaped.
    expect(JSON.parse(json)).toEqual({ schemaVersion: 1, ...value })
  }
})
