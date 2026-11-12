import { prTemplate } from "@vectordevai/core/everywhere/publish"
import { BRANCH_PATTERN, type EverywhereJob } from "@vectordevai/schema/everywhere"
import { githubJson, type GithubAccess } from "./github-api"

export async function repositoryPrivate(access: GithubAccess, job: EverywhereJob) {
  const row = await githubJson<{ id: number; full_name: string; private: boolean }>(access, `/repositories/${job.repository.id}`)
  return row.id === job.repository.id && row.full_name.toLowerCase() === job.repository.fullName.toLowerCase() && row.private === true
}

/** The requester's task and the checked summary reach only the fixed template. No model-provided PR body is used. */
export async function openEverywherePr(input: {
  readonly access: GithubAccess
  readonly job: EverywhereJob
  readonly branch: string
  readonly base: string
  readonly summary: string
  readonly held: number
}) {
  if (!BRANCH_PATTERN.test(input.branch) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(input.base) || input.base.includes("..")) throw new Error("Invalid Everywhere PR references")
  if (!await repositoryPrivate(input.access, input.job)) return undefined
  const template = prTemplate({ jid: input.job.jid, platform: input.job.platform, repository: input.job.repository.fullName,
    task: input.job.task, issueKey: input.job.issue?.key, github: input.job.github, summary: input.summary, held: input.held })
  const owner = input.job.repository.fullName.split("/")[0]!
  const path = `/repos/${input.job.repository.fullName}/pulls`
  const existing = await githubJson<{ html_url: string; body?: string }[]>(input.access, `${path}?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}`)
  const marker = `<!-- vector:job ${input.job.jid} -->`
  const found = existing.find((item) => item.body?.includes(marker))
  if (found) return found.html_url
  const created = await githubJson<{ html_url: string }>(input.access, path, { method: "POST", body: { head: input.branch, base: input.base, draft: true, ...template } })
  const url = new URL(created.html_url)
  if (url.origin !== "https://github.com" || !url.pathname.startsWith(`/${input.job.repository.fullName}/pull/`)) throw new Error("Invalid Everywhere PR response")
  return url.href
}
