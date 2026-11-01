import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import {
  canStart,
  customModelError,
  filterHostRows,
  HOST_FOOTNOTE,
  HOST_LOCALLY_ELSEWHERE,
  hostLocallyRefusal,
  hostRows,
  hostState,
  installOptions,
  modelFlag,
  NOTE_LABEL,
  startCopy,
  STATUS_LABEL,
  vendorLink,
} from "./host-locally-model"

const detection = (
  id: string,
  fields: Partial<ExternalAgent.Detection> & Pick<ExternalAgent.Detection, "state" | "installed">,
): ExternalAgent.Detection => ({ id, name: id, cli: id, tier: "terminal", ...fields })

const agent = (id: string) => ExternalAgent.find(id)!

describe("Host locally rows", () => {
  test("every catalog agent is a row, in the catalog's order, with what desktop detected", () => {
    const rows = hostRows(
      [
        detection("claude-code", { state: "ready", installed: true, signedIn: true, version: "2.1.215" }),
        detection("cursor", { state: "signed-out", installed: true, signedIn: false }),
        detection("gemini", { state: "unknown", installed: true }),
        detection("codex", { state: "not-installed", installed: false }),
        detection("vscode", { state: "ready", installed: true }),
      ],
      false,
    )
    expect(rows.map((row) => row.agent.id)).toEqual(ExternalAgent.catalog.map((entry) => entry.id))
    expect(rows.length).toBe(15)
    const state = (id: string) => rows.find((row) => row.agent.id === id)!.state
    expect(state("claude-code")).toBe("ready")
    expect(state("cursor")).toBe("signed-out")
    expect(state("gemini")).toBe("unknown")
    expect(state("codex")).toBe("not-installed")
    // Not reported at all: Vector can't tell, which is never shown as missing.
    expect(state("kilo")).toBe("unknown")
  })

  test("only an agent never detected shows Checking; a refresh keeps the last known state", () => {
    expect(hostState(undefined, true)).toBe("checking")
    expect(hostState(undefined, false)).toBe("unknown")
    expect(hostState(detection("codex", { state: "ready", installed: true }), true)).toBe("ready")
  })

  test("a desktop build from before the catalog reports installed and signedIn only", () => {
    const old = (fields: { installed: boolean; signedIn?: boolean }) =>
      ({ id: "claude-code", name: "Claude Code", cli: "claude", ...fields }) as unknown as ExternalAgent.Detection
    expect(hostState(old({ installed: false }), false)).toBe("not-installed")
    expect(hostState(old({ installed: true, signedIn: false }), false)).toBe("signed-out")
    expect(hostState(old({ installed: true, signedIn: true }), false)).toBe("ready")
    expect(hostState(old({ installed: true }), false)).toBe("unknown")
  })

  test("Start is offered for an installed agent, even when its sign-in can't be read", () => {
    const [ready, unknown, missing, signedOut, unseen] = hostRows(
      [
        detection("claude-code", { state: "ready", installed: true }),
        detection("codex", { state: "unknown", installed: true }),
        detection("cursor", { state: "not-installed", installed: false }),
        detection("copilot", { state: "signed-out", installed: true, signedIn: false }),
      ],
      false,
    )
    expect([ready, unknown, missing, signedOut, unseen].map((row) => canStart(row!))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ])
  })

  test("search matches every word against name, vendor, label, command and status", () => {
    const rows = hostRows([detection("claude-code", { state: "ready", installed: true })], false)
    const ids = (term: string) => filterHostRows(rows, term).map((row) => row.agent.id)
    expect(ids("")).toHaveLength(15)
    expect(ids("  claude ")).toEqual(["claude-code"])
    expect(ids("google")).toEqual(["gemini"])
    expect(ids("work or api")).toEqual(["gemini"])
    expect(ids("agy")).toEqual([])
    expect(ids("cursor-agent")).toEqual(["cursor"])
    expect(ids("cursor cli")).toEqual(["cursor"])
    expect(ids("kilo cli")).toEqual(["kilo"])
    expect(ids("jetbrains")).toEqual(["junie"])
    expect(ids("ready")).toEqual(["claude-code"])
    expect(ids("GITHUB copilot")).toEqual(["copilot"])
    expect(ids("nothing like this")).toEqual([])
  })

  test("the five statuses read as the launcher names them", () => {
    expect(Object.values(STATUS_LABEL)).toEqual(["Ready", "Signed out", "Not installed", "Checking", "Unknown"])
  })
})

describe("who may start an agent", () => {
  test("only this computer's own Vector, for its owner: never a server elsewhere or a guest's invite", () => {
    expect(hostLocallyRefusal({ local: true, username: "vector" })).toBeUndefined()
    expect(hostLocallyRefusal({ local: true })).toBeUndefined()
    // A remote or SSH host would run the agent on that machine, and a guest's agents are the person's who invited them.
    expect(hostLocallyRefusal({ local: false, username: "vector" })).toBe(HOST_LOCALLY_ELSEWHERE)
    expect(hostLocallyRefusal({ local: true, username: "guest" })).toBe(HOST_LOCALLY_ELSEWHERE)
    expect(HOST_LOCALLY_ELSEWHERE).toContain("only on this computer")
  })
})

describe("never behind a plan", () => {
  test("the launcher and the agents' views have no account or plan access", () => {
    // What decides whether an agent can start is what desktop detected on this computer, and nothing else.
    expect(canStart({ agent: agent("claude-code"), state: "ready" })).toBe(true)
    const files = readdirSync(import.meta.dir).filter((name) => /\.(?:ts|tsx)$/.test(name) && !name.includes(".test."))
    expect(files.length).toBeGreaterThan(10)
    const tied = files.filter((name) => {
      const source = readFileSync(join(import.meta.dir, name), "utf8")
      // The dashboard may label usage already measured by desktop. Only its exact
      // presentation references are allowed; account reads and other Codium access
      // remain forbidden here, including elsewhere in the same file.
      const checked =
        name === "agent-dashboard-model.ts"
          ? source
              .replace('import { CodiumUsage } from "@vectordevai/core/codium-usage"', "")
              .replaceAll('billing?: "codium"', "")
              .replace('if (agent.billing === "codium") {', "")
              .replace("CodiumUsage.withCodium(", "")
          : source
      return /codium|vector-account|billing-window|\bcredits?\b|upgrade|pricing|paywall|useAccount|plan\(\)/i.test(
        checked,
      )
    })
    expect(tied).toEqual([])
  })
})

describe("badges", () => {
  test("every agent is two letters, and the app ships no vendor's logo or icon file", () => {
    expect(ExternalAgent.catalog.map((entry) => entry.logo.letters)).toEqual([
      "CC",
      "CX",
      "CU",
      "CP",
      "GE",
      "MC",
      "KI",
      "CL",
      "PI",
      "DR",
      "AM",
      "QW",
      "KM",
      "GO",
      "JU",
    ])
    // The owner's decision (23 October 2026): no third-party logo files at all, Cursor's and Kilo's included.
    const pub = join(import.meta.dir, "../../../public")
    expect(existsSync(join(pub, "agent-logos"))).toBe(false)
    const names = ExternalAgent.catalog.flatMap((entry) => [entry.id, ...entry.binaries.map((binary) => binary.name)])
    const shipped = readdirSync(pub, { recursive: true }).map(String)
    expect(
      shipped.filter((file) => names.some((name) => file.toLowerCase().split(/[\\/]/).at(-1)!.startsWith(`${name}.`))),
    ).toEqual([])
  })
})

describe("copy", () => {
  test("says the user's installed agent runs, and where", () => {
    expect(startCopy(agent("claude-code"))).toBe(
      "Runs your installed Claude Code in Vector's chat, in an isolated copy of the repository.",
    )
    // Kimi Code has no headless form, so it stays in the terminal.
    expect(startCopy(agent("kimi"))).toBe(
      "Runs your installed Kimi Code in Vector's terminal, in an isolated copy of the repository.",
    )
  })

  test("the fine print says Vector is independent and the names are their owners' trademarks", () => {
    expect(HOST_FOOTNOTE).toContain("never reads its credentials")
    expect(HOST_FOOTNOTE).toContain("not affiliated with, endorsed by or sponsored by these companies")
    expect(HOST_FOOTNOTE).toContain("trademarks of their owners")
    expect(HOST_FOOTNOTE).not.toContain("logos")
    expect(NOTE_LABEL.trademark).toBe("Trademark")
  })

  test("a trademark notice links where its owner asks, on the agent's own domains", () => {
    const junie = agent("junie")
    const notice = junie.notes.find((note) => note.kind === "trademark")!
    expect(vendorLink(junie, notice.source)).toEqual({ href: "https://www.jetbrains.com/", label: "www.jetbrains.com" })
  })

  test("no launcher copy uses the words the owner ruled out", () => {
    const text = [
      ...ExternalAgent.catalog.map(startCopy),
      ...Object.values(STATUS_LABEL),
      ...ExternalAgent.catalog.flatMap((entry) => entry.notes.map((note) => note.text)),
      HOST_FOOTNOTE,
      HOST_LOCALLY_ELSEWHERE,
    ]
      .join("\n")
      // A company's legal name is quoted as it is registered.
      .replace("LF Projects, LLC", "LF")
    expect(text).not.toMatch(/\bproject\b|\bexactly\b|never exceeds|absolute privacy|partner|official integration/i)
    expect(text).not.toMatch(/your (?:claude|chatgpt|cursor|google|gemini) (?:plan|subscription)/i)
  })

  test("names the model flag a custom id reaches, on the surface the agent runs on", () => {
    expect(modelFlag(agent("claude-code"))).toBe("--model")
    expect(modelFlag(agent("gemini"))).toBe("-m")
    expect(modelFlag(agent("muse-code"))).toBeUndefined()
    // Factory Droid's exec takes -m, but its own screen in the terminal has no model flag, so no model choice is offered.
    expect(modelFlag(agent("droid"))).toBeUndefined()
    expect(agent("droid").models.kind).toBe("none")
  })
})

describe("custom model ids", () => {
  test("takes what desktop passes on and says why it refuses the rest", () => {
    for (const fine of ["", "  ", "opus", "sonnet[1m]", "anthropic/claude-sonnet-5-5", "gpt-5.5", "models/x@2"])
      expect(customModelError(fine)).toBeUndefined()
    for (const bad of ["--dangerously-skip", "a b", 'x"y', "x;rm", "$(id)", "a%b"])
      expect(customModelError(bad)).toBeString()
  })
})

describe("links and install commands", () => {
  test("a link is shown only when it is https on the agent's own vendor domain", () => {
    const codex = agent("codex")
    expect(vendorLink(codex, "https://github.com/openai/codex")).toEqual({
      href: "https://github.com/openai/codex",
      label: "github.com/openai/codex",
    })
    expect(vendorLink(codex, "https://github.com/someone-else/codex")).toBeUndefined()
    expect(vendorLink(codex, "http://developers.openai.com/codex/cli")).toBeUndefined()
    expect(vendorLink(codex, "https://developers.openai.com.evil.test/codex")).toBeUndefined()
    expect(vendorLink(codex, "javascript:alert(1)")).toBeUndefined()
    expect(vendorLink(codex, undefined)).toBeUndefined()
    expect(vendorLink(agent("claude-code"), "https://code.claude.com/docs/en/setup")?.label).toBe(
      "code.claude.com/docs/en/setup",
    )
    // Every link the launcher can show from the catalog passes.
    for (const entry of ExternalAgent.catalog)
      for (const link of [entry.docsUrl, ...entry.install.map((option) => option.docsUrl)])
        expect({ id: entry.id, link, shown: Boolean(vendorLink(entry, link)) }).toEqual({
          id: entry.id,
          link,
          shown: true,
        })
  })

  test("install options are desktop's when it sent them, else this platform's commands from the catalog", () => {
    const claude = agent("claude-code")
    expect(installOptions(claude, "darwin", undefined).map((option) => option.id)).toEqual(["script", "homebrew"])
    expect(installOptions(claude, "win32", undefined).map((option) => option.id)).toEqual(["powershell", "winget"])
    const launch = { title: "Install Claude Code", display: "x", command: "/bin/sh", args: [], cwd: "/tmp", env: {} }
    const commands: ExternalAgent.Commands = {
      id: "claude-code",
      platform: "linux",
      docsUrl: claude.docsUrl,
      install: [{ ...claude.install[0]!, launch }],
    }
    expect(installOptions(claude, "darwin", commands)).toEqual([{ ...claude.install[0]!, launch }])
  })
})
