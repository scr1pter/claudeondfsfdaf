import { describe, expect, test } from "bun:test"
import path from "node:path"
import { dict } from "../i18n/en"
import {
  projectTrustAnswer,
  projectTrustHostDecides,
  projectTrustParent,
  projectTrustPrompt,
  projectTrustRecord,
  projectTrustStatus,
} from "./project-trust-policy"

describe("trust wording", () => {
  // Vector has repositories, not projects (owner rule), so the question reads "Trust this repository?".
  test("the trust dialog, its errors and the repository menu say repository, never project", () => {
    const strings = Object.entries(dict).filter(([key]) => key.startsWith("project.trust."))
    expect(strings.length).toBeGreaterThan(0)
    expect(strings.filter(([, text]) => /project/i.test(text)).map(([key]) => key)).toEqual([])
    expect(dict["project.trust.dialog.title"]).toBe("Trust this repository?")
  })

  // A guest's approval is refused, so the guest is told who decides instead of being asked or told to try again.
  test("an invited guest is told that the person who invited them decides", () => {
    expect(dict["project.trust.host.title"]).toBe("Only the host can trust this repository")
    expect(dict["project.trust.host.description"]).toContain("until the person who invited you trusts it")
  })

  // "Not now" leaves the repository untrusted, and the engine keeps the user's own language servers and formatters
  // off in an untrusted repository and starts their MCP servers outside it. On the desktop the app's question is the
  // only place that says so, so it must say what "Not now" keeps off besides the repository's settings.
  test("the trust question says what Not now keeps off, including the user's own tools", () => {
    const later = dict["project.trust.dialog.later"]
    expect(later).toContain("Vector ignores these settings")
    expect(later).toContain("your language servers and formatters stay off in it")
    expect(later).toContain("your MCP servers start outside it")
  })

  // An agent or parallel workspace has its own trust, and the repository's menu on Home approves only the repository.
  test("the question about a workspace folder points only to Settings, never to the repository's menu on Home", () => {
    const later = dict["project.trust.dialog.workspace.later"]
    expect(later).toContain("your language servers and formatters stay off in it")
    expect(later).toContain("in Settings, under Repository trust")
    expect(later).not.toContain("Home")
  })
})

describe("who may trust a repository", () => {
  // A clone can come from any pasted link, so its vector.json and .vector settings are a stranger's code. Only the
  // user's own answer approves trust: the trust dialog and Settings, both Repository trust and the Trust this repository
  // button Vector everywhere shows for a listed folder that is open in Vector, which goes through the same approval and
  // offers it only where projectTrustSummary does. Nothing approves on the user's behalf after a clone, an open or any
  // other flow, so every clone asks like any other repository.
  test("only the trust dialog and Settings approve trust, never a clone or any other flow", async () => {
    const root = path.join(import.meta.dir, "..")
    // The glob gives Windows separators on Windows; the paths below are written with forward slashes.
    const files = (await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root }))).map((file) =>
      file.replaceAll(path.sep, "/"),
    )
    const sources = await Promise.all(
      files
        .filter((file) => !file.includes(".test."))
        .map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })),
    )
    expect(
      sources
        .filter((item) => approvesTrust(item.text))
        .map((item) => item.file)
        .toSorted(),
    ).toEqual([
      "components/project-trust-prompt.tsx",
      "components/settings-v2/everywhere.tsx",
      "components/settings-v2/project-trust.tsx",
      "context/project-trust.tsx",
    ])
    // The engine's approval itself is called in one place, which the dialog and Settings go through.
    expect(sources.filter((item) => callsEngineApproval(item.text)).map((item) => item.file)).toEqual([
      "context/project-trust.tsx",
    ])
  })

  // The guard above reads source text, so it has to see an approval however it is written, not only as
  // `trust.approve(`: under another name for the context, through the SDK in any spelling, or by the route itself.
  test("the guard sees an approval however it is spelled", () => {
    const approvals = [
      "const t = useProjectTrust()\nawait t.approve(client, scope)",
      "const { approve } = useProjectTrust()\nawait approve(client, scope)",
      "useProjectTrust()['approve'](client, scope)",
      'await client.config["trust"].approve()',
      'await client.config.trust["approve"]()',
      "await client.config?.trust?.approve()",
      "const api = client.config.trust\nawait api.approve()",
      'await fetch(`${url}/config/trust`, { method: "POST" })',
      "const reply: ConfigTrustApproveResponses = await post()",
    ]
    expect(approvals.filter((text) => !approvesTrust(text))).toEqual([])
    expect(
      [
        "await client.config.trust.get()",
        "const trust = useProjectTrust()\ntrust.remember(scope, workspace, 'dismissed')",
        "await permission.approve(request)",
      ].filter(approvesTrust),
    ).toEqual([])
  })
})

// Any way source text can reach the engine's trust approval: the trust context's approve under any binding, the SDK's
// config.trust in any spelling next to an approve, the generated approval types, or the route's path.
function approvesTrust(text: string) {
  const approve = /\bapprove\b/.test(text)
  if (approve && /\buseProjectTrust\b/.test(text)) return true
  if (approve && /\bconfig\s*(?:\?\.|\.|\[\s*["'`])\s*trust\b/.test(text)) return true
  return /\/config\/trust\b|\bConfigTrustApprove/.test(text)
}

// A direct call of the SDK's approval, in any spelling of config.trust.approve.
function callsEngineApproval(text: string) {
  return /\bconfig\s*(?:\?\.|\.|\[\s*["'`])\s*trust\b["'`]?\s*\]?\s*(?:\?\.|\.|\[\s*["'`])\s*approve\b/.test(text)
}

const ignored = { ignored: true, settings: true }

describe("projectTrustPrompt", () => {
  test("asks the first time a project's own settings are ignored", () => {
    expect(projectTrustPrompt(ignored, undefined)).toBe("ask")
  })

  test("never asks again after Not now", () => {
    expect(projectTrustPrompt(ignored, "dismissed")).toBeUndefined()
  })

  test("asks again when a trusted project's settings changed", () => {
    expect(projectTrustPrompt(ignored, "trusted")).toBe("changed")
  })

  test("never asks for a project with no Vector settings of its own", () => {
    // `ignored` alone means only the user's own language servers, formatters and MCP servers are held back.
    expect(projectTrustPrompt({ ignored: true, settings: false }, undefined)).toBeUndefined()
    expect(projectTrustPrompt({ ignored: false, settings: false }, undefined)).toBeUndefined()
  })

  test("never asks for a trusted project", () => {
    expect(projectTrustPrompt({ ignored: false, settings: true }, undefined)).toBeUndefined()
    expect(projectTrustPrompt({ ignored: false, settings: true }, "trusted")).toBeUndefined()
  })

  test("never asks while the status is unknown", () => {
    expect(projectTrustPrompt(undefined, undefined)).toBeUndefined()
  })

  test("never asks an invited guest, whose approval the server always refuses", () => {
    expect(projectTrustPrompt({ ...ignored, approvable: false }, undefined)).toBeUndefined()
    expect(projectTrustPrompt({ ...ignored, approvable: false }, "trusted")).toBeUndefined()
    expect(projectTrustPrompt({ ...ignored, approvable: true }, undefined)).toBe("ask")
  })
})

describe("projectTrustRecord", () => {
  test("remembers a project the engine trusts, replacing an earlier Not now", () => {
    expect(projectTrustRecord({ trusted: true }, undefined)).toBe("trusted")
    expect(projectTrustRecord({ trusted: true }, "dismissed")).toBe("trusted")
  })

  test("keeps the answer while the project is not trusted", () => {
    expect(projectTrustRecord({ trusted: false }, undefined)).toBeUndefined()
    expect(projectTrustRecord({ trusted: false }, "dismissed")).toBe("dismissed")
    expect(projectTrustRecord({ trusted: false }, "trusted")).toBe("trusted")
  })

  test("a Not now followed by trust from Settings asks again once the settings change", () => {
    const answer = projectTrustRecord({ trusted: true }, "dismissed")
    expect(projectTrustPrompt(ignored, answer)).toBe("changed")
  })
})

describe("projectTrustAnswer", () => {
  test("reads only the answers the app writes", () => {
    expect(projectTrustAnswer("trusted")).toBe("trusted")
    expect(projectTrustAnswer("dismissed")).toBe("dismissed")
    expect(projectTrustAnswer("yes")).toBeUndefined()
    expect(projectTrustAnswer(true)).toBeUndefined()
    expect(projectTrustAnswer(undefined)).toBeUndefined()
  })
})

describe("projectTrustStatus", () => {
  test("reads the engine's status", () => {
    const status = { workspace: "/work/app", trusted: false, ignored: true, settings: true, approvable: true }
    expect(projectTrustStatus(status)).toEqual(status)
    expect(projectTrustStatus({ ...status, extra: 1 })).toEqual(status)
    expect(projectTrustStatus({ ...status, approvable: false })).toEqual({ ...status, approvable: false })
  })

  test("an engine that does not say who may approve is the owner's, as before the field existed", () => {
    const status = { workspace: "/work/app", trusted: false, ignored: true, settings: true }
    expect(projectTrustStatus(status)).toEqual({ ...status, approvable: true })
    expect(projectTrustStatus({ ...status, approvable: "no" })).toBeUndefined()
  })

  test("drops a reply that is not a status, so the app neither crashes nor asks", () => {
    expect(projectTrustStatus({})).toBeUndefined()
    expect(projectTrustStatus({ trusted: false, ignored: true, settings: true })).toBeUndefined()
    expect(projectTrustStatus({ workspace: "", trusted: false, ignored: true, settings: true })).toBeUndefined()
    expect(projectTrustStatus({ workspace: "/work/app", trusted: "no", ignored: true, settings: true })).toBeUndefined()
    expect(projectTrustStatus({ workspace: "/work/app", trusted: false, ignored: true })).toBeUndefined()
    expect(projectTrustStatus("<!doctype html>")).toBeUndefined()
    expect(projectTrustStatus(null)).toBeUndefined()
    expect(projectTrustStatus(undefined)).toBeUndefined()
  })
})

describe("projectTrustHostDecides", () => {
  test("tells an invited guest that the host decides about a repository's ignored settings", () => {
    expect(projectTrustHostDecides({ ...ignored, approvable: false })).toBe(true)
  })

  test("says nothing to the owner, about a trusted repository, or about one with no settings of its own", () => {
    expect(projectTrustHostDecides({ ...ignored, approvable: true })).toBe(false)
    expect(projectTrustHostDecides({ ignored: false, settings: true, approvable: false })).toBe(false)
    expect(projectTrustHostDecides({ ignored: true, settings: false, approvable: false })).toBe(false)
    expect(projectTrustHostDecides(undefined)).toBe(false)
  })
})

describe("projectTrustParent", () => {
  const repository = { worktree: "/work/app", name: "App", sandboxes: ["/work/app/.vector/workspaces/agent-1/app"] }
  const other = { worktree: "/work/site", sandboxes: [] }

  test("finds the repository an agent or parallel workspace folder belongs to", () => {
    const folder = "/work/app/.vector/workspaces/agent-1/app"
    expect(projectTrustParent([other, repository], folder, folder)).toBe(repository)
  })

  test("a repository's own folder has no parent, so its question may point to its menu on Home", () => {
    expect(projectTrustParent([other, repository], "/work/app", "/work/app")).toBeUndefined()
    expect(projectTrustParent([other, repository], "/work/app", "/work/app/packages/web")).toBeUndefined()
  })

  test("a folder that no repository lists reads as a repository", () => {
    expect(projectTrustParent([other, repository], "/work/new", "/work/new")).toBeUndefined()
    expect(projectTrustParent([], "/work/app", "/work/app")).toBeUndefined()
  })
})
