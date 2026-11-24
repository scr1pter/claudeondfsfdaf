import { describe, expect, spyOn, test } from "bun:test"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"

import { githubErrorMessage, githubJson, parseGithubRemote, pickBaseRemote, readTail } from "./github-api"

test("the Desktop GitHub client honors its named Vector Local allowance", async () => {
  const requests: Request[] = []
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return Response.json({ id: 42 })
      },
      { preconnect: () => undefined },
    ),
  )
  const access = { token: "fixture-token", source: "vector" as const }
  const previous = Egress.policy()
  try {
    Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
    await expect(githubJson(access, "/repositories/42")).rejects.toThrow("Vector Local blocked")
    expect(requests).toEqual([])

    Egress.configure(
      LocalPolicy.resolve({
        global: {
          enabled: true,
          allow: [{ source: "github", reason: "Fixture", added_at: 1, added_by: "app" }],
        },
      }),
    )
    expect(await githubJson(access, "/repositories/42")).toEqual({ id: 42 })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer fixture-token")
    expect(Egress.events().at(-1)).toMatchObject({ source: "github", purpose: "integration", decision: "allow" })
  } finally {
    Egress.configure(previous)
    fetch.mockRestore()
  }
})

describe("parseGithubRemote", () => {
  test("reads every remote spelling git accepts for github.com", () => {
    const repo = { owner: "scr1pter", name: "Vectordev.ai" }
    expect(parseGithubRemote("https://github.com/scr1pter/Vectordev.ai.git")).toEqual(repo)
    expect(parseGithubRemote("https://github.com/scr1pter/Vectordev.ai")).toEqual(repo)
    expect(parseGithubRemote("https://x-access-token:abc@github.com/scr1pter/Vectordev.ai.git")).toEqual(repo)
    expect(parseGithubRemote("git@github.com:scr1pter/Vectordev.ai.git")).toEqual(repo)
    expect(parseGithubRemote("ssh://git@github.com/scr1pter/Vectordev.ai.git")).toEqual(repo)
    expect(parseGithubRemote("ssh://git@github.com:22/scr1pter/Vectordev.ai")).toEqual(repo)
    expect(parseGithubRemote("git://github.com/scr1pter/Vectordev.ai.git")).toEqual(repo)
  })

  test("refuses hosts that are not github.com", () => {
    expect(parseGithubRemote("https://gitlab.com/scr1pter/Vectordev.ai.git")).toBeUndefined()
    expect(parseGithubRemote("https://github.com.evil.example/scr1pter/Vectordev.ai")).toBeUndefined()
    expect(parseGithubRemote("/home/user/repo")).toBeUndefined()
  })
})

describe("pickBaseRemote", () => {
  test("a fork's clone opens pull requests against upstream, not the fork", () => {
    const picked = pickBaseRemote([
      { name: "origin", url: "git@github.com:me/vector.git" },
      { name: "upstream", url: "https://github.com/scr1pter/Vectordev.ai.git" },
    ])
    expect(picked?.repo).toEqual({ owner: "scr1pter", name: "Vectordev.ai" })
  })

  test("skips remotes that are not on GitHub", () => {
    const picked = pickBaseRemote([
      { name: "origin", url: "https://gitlab.com/me/vector.git" },
      { name: "backup", url: "git@github.com:me/vector.git" },
    ])
    expect(picked?.name).toBe("backup")
    expect(pickBaseRemote([{ name: "origin", url: "/srv/git/vector" }])).toBeUndefined()
  })
})

describe("githubErrorMessage", () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers })

  test("an expired sign-in asks the user to sign in again", async () => {
    expect(await githubErrorMessage(response(401, { message: "Bad credentials" }))).toContain("Sign in to GitHub again")
  })

  test("an organization's single sign-on names where to authorize Vector", async () => {
    const message = await githubErrorMessage(
      response(
        403,
        { message: "Resource protected by organization SAML enforcement." },
        {
          "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=abc",
        },
      ),
    )
    expect(message).toContain("https://github.com/orgs/acme/sso?authorization_request=abc")
  })

  test("a used-up rate limit says so", async () => {
    const message = await githubErrorMessage(
      response(
        403,
        { message: "API rate limit exceeded" },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791439800" },
      ),
    )
    expect(message).toContain("API limit")
  })

  test("validation failures keep GitHub's own explanation", async () => {
    const message = await githubErrorMessage(
      response(422, {
        message: "Validation Failed",
        errors: [{ message: "A pull request already exists for scr1pter:feature." }],
      }),
    )
    expect(message).toBe("Validation Failed: A pull request already exists for scr1pter:feature.")
  })
})

describe("readTail", () => {
  test("keeps only the end of a long body and says it was cut", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 64; index += 1) controller.enqueue(chunk)
        controller.enqueue(new TextEncoder().encode("THE END"))
        controller.close()
      },
    })
    const tail = await readTail(new Response(body), 4096)
    expect(tail.truncated).toBe(true)
    expect(Buffer.byteLength(tail.text)).toBe(4096)
    expect(tail.text.endsWith("THE END")).toBe(true)
  })

  test("returns a short body whole", async () => {
    expect(await readTail(new Response("short log"), 4096)).toEqual({ text: "short log", truncated: false })
  })
})
