import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GithubAgents, GithubConnectionError, githubAgentsVisible, readGithubBindings,
  requestGithubBindCode, requestGithubUnbind, type GithubAgentsPreview, type GithubBinding } from "../src/components/marketing/account/GithubAgents"

const binding: GithubBinding = { repositoryId: "42", repository: "owner/parser", binder: { login: "maintainer" },
  boundAt: Date.UTC(2026, 10, 10), lastUsedAt: Date.UTC(2026, 10, 11), workflowVersion: "3", codium: "ready" }
const config = { enabled: true, listed: ["github-agents"] }
const code = { code: `vbc_${"a".repeat(43)}`, expiresAt: Date.now() + 600_000, repository: "owner/parser" }
const render = (preview: GithubAgentsPreview, search = "") => renderToStaticMarkup(createElement(GithubAgents, { accessToken: "", preview, search }))

describe("account GitHub agents", () => {
  test("missing or disabled public listing stays hidden; only the exact owner preview parameter overrides it", () => {
    expect(githubAgentsVisible(undefined)).toBe(false)
    expect(githubAgentsVisible({ enabled: true })).toBe(false)
    expect(githubAgentsVisible({ enabled: false, listed: ["github-agents"] })).toBe(false)
    expect(render({ config: { enabled: true }, bindings: [binding] })).toBe("")
    expect(render({ config: { enabled: false }, bindings: [] })).toBe("")
    expect(render({ config: { enabled: false }, bindings: [] }, "?github-preview=1")).toContain('id="github"')
    expect(render({ config: { enabled: false }, bindings: [] }, "?github-preview=true")).toBe("")
  })

  test("fixture rendering shows connection metadata and the Actions/default-branch bind steps", () => {
    const html = render({ config, bindings: [binding], code })
    expect(html).toContain("in your own repo, on your own Actions minutes")
    expect(html).toContain("owner/parser")
    expect(html).toContain("maintainer")
    expect(html).toContain("Last used")
    expect(html).toContain("Codium ready")
    expect(html).toContain("Workflow v3")
    expect(html).toContain("default branch")
    expect(html).toContain("Actions tab")
    expect(html).toContain("Run workflow")
    expect(html).toContain("<code>mode</code> to <code>bind</code>")
    expect(html).toContain("<code>code</code>")
    expect(html.split(code.code)).toHaveLength(2)
    expect(html).toContain("Copy code")
    expect(html).toContain("Leaving this page clears the code")
    expect(html).toContain('for="github-agent-repository"')
    expect(html).toContain('aria-label="Unbind owner/parser"')
  })

  test("binder-left names stay hidden even when a stale response includes them", () => {
    const lost: GithubBinding = { ...binding, repository: "secret/internal-name", binder: { login: "private-person" }, suspended: "binder-left" }
    const html = render({ config, bindings: [lost] })
    expect(html).toContain("Repository access changed")
    expect(html).toContain("Codium unavailable")
    expect(html).not.toContain("secret/internal-name")
    expect(html).not.toContain("private-person")
    expect(html).not.toContain("Codium ready")
    expect(readGithubBindings({ bindings: [lost] })).toEqual([{ repositoryId: "42", boundAt: lost.boundAt,
      lastUsedAt: lost.lastUsedAt, workflowVersion: "3", codium: "unavailable", suspended: "binder-left" }])
  })

  test("an expired code is absent and the section copy has no account details or misleading service claims", () => {
    const html = render({ config, bindings: [binding], code: { ...code, expiresAt: Date.now() - 1 } })
    expect(html).not.toContain(code.code)
    expect(html).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
    expect(html).not.toMatch(/[$€£]|\b(?:billing|invoice|payment|credits|dollars|tokens)\b/i)
    expect(html).not.toMatch(/\b(?:hosted|compute|exclusive|guaranteed|SLA)\b|cloud hours|cloud capacity|our cloud|every PR|every pull request|24\/7|when my Mac is off/i)
    expect(html).toContain("/vector")
  })

  test("unbind posts only the selected repository ID using the existing account sign-in", async () => {
    const calls: { url: string; body: unknown }[] = []
    await requestGithubUnbind("fixture-account-session", "42", async (url, init) => {
      expect(init?.method).toBe("POST")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-account-session")
      expect(init?.redirect).toBe("error")
      expect(init?.cache).toBe("no-store")
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return Response.json({ ok: true })
    })
    expect(calls).toEqual([{ url: "/api/cloud-agents/unbind", body: { repositoryId: "42" } }])
    await expect(requestGithubUnbind("fixture-account-session", "../other", async () => { throw new Error("must not call") })).rejects.toMatchObject({ status: 400 })
  })

  test("bind-code creation is an explicit repository-only request with a one-time typed response", async () => {
    const result = await requestGithubBindCode("fixture-account-session", " owner/parser ", async (url, init) => {
      expect(url).toBe("/api/cloud-agents/bind-code")
      expect(init?.method).toBe("POST")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-account-session")
      expect(JSON.parse(String(init?.body))).toEqual({ repository: "owner/parser" })
      return Response.json({ code: code.code, expiresAt: code.expiresAt })
    })
    expect(result).toEqual(code)
    for (const name of ["https://github.com/owner/parser", "../other", "owner/..", "owner/name with spaces"])
      await expect(requestGithubBindCode("fixture-account-session", name, async () => { throw new Error("must not call") })).rejects.toMatchObject({ status: 400 })
    await expect(requestGithubBindCode("fixture-account-session", "owner/parser", async () => Response.json({ code: "vrt_wrong-audience", expiresAt: code.expiresAt }))).rejects.toMatchObject({ status: 503 })
  })

  test("authentication and service failures expose neutral recovery copy rather than server account details", async () => {
    try {
      await requestGithubUnbind("fixture-account-session", "42", async () => Response.json({ error: {
        message: "private@example.test has a payment issue and $100 left", code: "PRIVATE_REASON" } }, { status: 401 }))
      throw new Error("expected refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(GithubConnectionError)
      expect((error as Error).message).toBe("Sign in again to manage your GitHub repositories.")
      expect((error as Error).message).not.toMatch(/@|\$|payment|PRIVATE_REASON/)
    }
    await expect(requestGithubUnbind("", "42", async () => { throw new Error("must not call") })).rejects.toMatchObject({ status: 401 })
  })

  test("malformed connection identities and duplicate rows fail closed", () => {
    expect(() => readGithubBindings({ bindings: [{ ...binding, repositoryId: "../other" }] })).toThrow(GithubConnectionError)
    expect(() => readGithubBindings({ bindings: [binding, binding] })).toThrow(GithubConnectionError)
    expect(() => readGithubBindings({ bindings: [{ ...binding, binder: { login: "private@example.test" } }] })).toThrow(GithubConnectionError)
    expect(() => readGithubBindings({ bindings: [{ ...binding, codium: "maybe" }] })).toThrow(GithubConnectionError)
  })
})
