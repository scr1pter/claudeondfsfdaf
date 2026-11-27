import { describe, expect, test } from "bun:test"
import type { LocalStatus } from "@vectordevai/sdk/v2/client"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { ServerConnection } from "@/context/server"
import { AGENT, LOCKED, NOT_ENCRYPTED, SHARED_MACHINE } from "@/features/local/local-model"
import {
  SECTIONS,
  SURFACE,
  allowedRows,
  certificateLines,
  checkVerdict,
  heldText,
  serverRows,
  surfaceNote,
  switchView,
  webChoices,
  webNote,
  webNoteLocked,
} from "./local-model"

const sources = LocalSources.SOURCES.map((source) => ({
  id: source.id,
  purpose: source.purpose,
  hosts: [...source.hosts],
  sends: source.sends,
  why: source.why,
  local: source.local,
  where: [...source.where],
}))

function status(
  input: { policy?: Partial<LocalStatus["policy"]>; locked?: string[]; agent?: boolean } = {},
): LocalStatus {
  return {
    policy: {
      ...LocalPolicy.OFF,
      enabled: true,
      endpoints: [],
      allow: [],
      warnings: [],
      ...input.policy,
    } as LocalStatus["policy"],
    locked: input.locked ?? [],
    log: { directory: "/tmp/vector/local", retain_days: 30 },
    agent: input.agent ?? false,
    sources,
  }
}
// A company lock that leaves only stricter Web access to the user, as GET /local reports it.
const lockedPolicy = { lock: true, user_may: ["web"], web: "network" as const }
const lockedKeys = ["enabled", "endpoints", "allow", "web_domains"]

describe("Settings > Vector Local", () => {
  test("lays out its sections top to bottom as the plan orders them", () => {
    expect(SECTIONS.map((section) => section.title)).toEqual([
      "Vector Local",
      "Web access",
      "Model servers",
      "Roles",
      "Allowed services",
      "Off in Vector Local",
      "Certificates",
      "Network log",
      "Run a check",
    ])
  })
})

describe("the switch", () => {
  test("is the owner's to turn on and off", () => {
    expect(switchView(status())).toEqual({ on: true, locked: false, disabled: false, note: undefined })
    expect(switchView(status({ policy: { enabled: false } })).on).toBe(false)
  })

  test("under a company lock it stays on and says who set it", () => {
    expect(switchView(status({ policy: lockedPolicy, locked: lockedKeys }))).toEqual({
      on: true,
      locked: true,
      disabled: true,
      note: LOCKED,
    })
  })

  test("a Vector the agent started can turn it on but never off", () => {
    expect(switchView(status({ agent: true })).disabled).toBe(true)
    expect(switchView(status({ agent: true, policy: { enabled: false } })).disabled).toBe(false)
    expect(AGENT).toContain("nothing here can loosen Vector Local")
  })
})

describe("which Vector the switch is for", () => {
  const sidecar: ServerConnection.Any = { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } }
  const loopback: ServerConnection.Any = { type: "http", http: { url: "http://127.0.0.1:4096" } }
  const wsl: ServerConnection.Any = {
    type: "sidecar",
    variant: "wsl",
    distro: "Ubuntu",
    http: { url: "http://127.0.0.1:4097" },
  }
  const ssh: ServerConnection.Any = { type: "ssh", host: "build-box", http: { url: "http://127.0.0.1:4098" } }
  const remote: ServerConnection.Any = { type: "http", http: { url: "http://192.168.1.20:4096" } }

  test("the desktop app says its switch is its own, and how to turn it on in a terminal", () => {
    expect(surfaceNote({ desktop: true, connection: sidecar })).toBe(SURFACE)
    expect(SURFACE).toContain("vector local on")
    // The app's built-in terminal reads the app's own setting, so only a terminal outside the app keeps its own.
    expect(SURFACE).toContain("Vector in a terminal outside the app keeps its own setting")
  })

  test("a terminal's vector serve added by its loopback address is that terminal's switch, so it says nothing", () => {
    // It counts as this computer's engine, yet it reads the terminal's config folders, not the app's.
    expect(ServerConnection.local(loopback)).toBe(true)
    expect(surfaceNote({ desktop: true, connection: loopback })).toBeUndefined()
  })

  test("a WSL engine, an SSH engine or another computer's engine says nothing about it", () => {
    expect(surfaceNote({ desktop: true, connection: wsl })).toBeUndefined()
    expect(surfaceNote({ desktop: true, connection: ssh })).toBeUndefined()
    expect(surfaceNote({ desktop: true, connection: remote })).toBeUndefined()
  })

  test("a browser, or no engine chosen yet, says nothing about it", () => {
    expect(surfaceNote({ desktop: false, connection: sidecar })).toBeUndefined()
    expect(surfaceNote({ desktop: false, connection: loopback })).toBeUndefined()
    expect(surfaceNote({ desktop: true, connection: undefined })).toBeUndefined()
  })
})

describe("Web access", () => {
  test("offers Ask, Your network only and None, with the one in effect checked", () => {
    const choices = webChoices(status({ policy: { web: "network" } }))
    expect(choices.map((choice) => [choice.label, choice.checked, choice.disabled])).toEqual([
      ["Ask", false, false],
      ["Your network only", true, false],
      ["None", false, false],
    ])
    expect(webNoteLocked(status())).toBeUndefined()
  })

  test("under a lock that leaves it to the user, only a stricter choice is open", () => {
    const choices = webChoices(status({ policy: lockedPolicy, locked: lockedKeys }))
    expect(choices.map((choice) => [choice.id, choice.disabled])).toEqual([
      ["ask", true],
      ["network", false],
      ["none", false],
    ])
    expect(webNoteLocked(status({ policy: lockedPolicy, locked: lockedKeys }))).toBe(
      `${LOCKED} Your company lets you make Web access stricter only.`,
    )
  })

  test("under a lock that keeps it, nothing changes", () => {
    const keeps = status({ policy: { ...lockedPolicy, user_may: [] }, locked: [...lockedKeys, "web"] })
    expect(webChoices(keeps).every((choice) => choice.disabled)).toBe(true)
    expect(webNoteLocked(keeps)).toBe(LOCKED)
  })

  test("says that an internet server on the list still gets model calls, whatever Web access says", () => {
    expect(
      webNote(status({ policy: { endpoints: [{ origin: "http://127.0.0.1:11434", from: "user" }] } }).policy),
    ).toBe(undefined)
    expect(
      webNote(
        status({ policy: { web: "none", endpoints: [{ origin: "https://llm.example.com", from: "managed" }] } }).policy,
      ),
    ).toBe("Model calls still go to the internet server on your list (llm.example.com), whatever Web access says.")
  })
})

describe("model servers", () => {
  const listed = status({
    policy: {
      endpoints: [
        { origin: "http://127.0.0.1:11434", from: "user" },
        { origin: "http://192.168.1.20:8000", from: "user" },
        { origin: "https://llm.example.com", from: "managed" },
        { origin: "https://gpu.example.org", from: "user" },
        { origin: "http://gpu-box:8080", from: "environment" },
      ],
      pins: {
        "http://127.0.0.1:11434": { kind: "ollama", version: "0.12.3" },
        "https://llm.example.com": { kind: "vllm", version: "0.11.0", spki: "abc" },
      },
    },
  })
  const rows = serverRows(listed)

  test("say who listed each server and the server it answered as", () => {
    expect(rows.map((row) => row.from)).toEqual([
      "Added by you",
      "Added by you",
      "Listed by your company",
      "Added by you",
      "From VECTOR_LOCAL_POLICY",
    ])
    expect(rows[0]!.identity).toBe("Answers as Ollama 0.12.3")
    expect(rows[2]!.identity).toBe("Answers as vLLM 0.11.0")
    expect(rows[1]!.identity).toContain("No identity pinned yet")
  })

  test("label where it is and whether prompts to it are encrypted", () => {
    const labels = rows.map((row) => row.labels.map((label) => label.text))
    expect(labels[0]).toEqual(["This computer", SHARED_MACHINE])
    expect(labels[1]).toEqual(["Your network", NOT_ENCRYPTED])
    expect(labels[2]).toEqual(["Company endpoint (listed by your company)", "Encrypted, key pinned"])
    expect(labels[3]).toEqual(["Internet endpoint you listed", "Encrypted"])
    expect(labels[4]).toEqual(["Your network", NOT_ENCRYPTED])
    expect(rows[1]!.labels.find((label) => label.text === NOT_ENCRYPTED)?.warn).toBe(true)
  })

  test("only the servers the user added can be removed here, even under a lock", () => {
    expect(rows.map((row) => row.removable)).toEqual([true, true, false, true, false])
    const lockedRows = serverRows({ ...listed, policy: { ...listed.policy, lock: true }, locked: lockedKeys })
    expect(lockedRows.map((row) => row.removable)).toEqual([true, true, false, true, false])
  })
})

describe("allowed services", () => {
  test("say what each sends, where, the reason, who added it and when", () => {
    const rows = allowedRows(
      status({
        policy: {
          allow: [
            { source: "github", reason: "Our pull requests", added_at: Date.UTC(2026, 9, 21, 12), added_by: "app" },
            { source: "mcp-remote", hosts: ["tools.example.org"], reason: "Research", added_at: 0, added_by: "managed" },
          ],
        },
      }),
    )
    expect(rows[0]).toMatchObject({
      name: "GitHub pull requests",
      // No hosts in the entry: it covers every host GitHub's requests go to, not only the registry's.
      hosts: "Any host it reaches, usually github.com, api.github.com and vectordev.ai",
      reason: "Our pull requests",
      by: "Added in the app",
      when: "Oct 21, 2026",
      removable: true,
    })
    expect(rows[1]).toMatchObject({
      name: "Remote MCP servers",
      hosts: "tools.example.org",
      by: "Set by your company",
      removable: false,
    })
  })
})

describe("the rest of the pane", () => {
  test("a held change says what it would loosen", () => {
    expect(
      heldText({ proposed: status().policy, changes: ["turns Vector Local off", "allows github for any host"] }),
    ).toBe(
      "A change to your config would loosen Vector Local: it turns Vector Local off and allows github for any host. It waits for you.",
    )
  })

  test("the check's verdict counts failed layers and warnings", () => {
    const row = (status: "pass" | "warn" | "fail") => ({ layer: "guard" as const, status, title: "Network guard" })
    expect(checkVerdict({ result: "pass", rows: [row("pass")] })).toBe("Every layer passed.")
    expect(checkVerdict({ result: "pass", rows: [row("pass"), row("warn")] })).toBe(
      "Every layer passed, with 1 warning.",
    )
    expect(checkVerdict({ result: "fail", rows: [row("fail"), row("fail"), row("warn")] })).toBe("2 layers failed.")
    expect(checkVerdict({ result: "off", rows: [] })).toContain("Vector Local is off")
  })

  test("lists the certificate files from the user's config", () => {
    expect(certificateLines({ local: { ca: { files: ["/etc/company/ca.pem"] } } })).toEqual(["/etc/company/ca.pem"])
    expect(certificateLines(undefined)).toEqual([])
  })
})
