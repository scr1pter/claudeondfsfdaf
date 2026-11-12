import { z } from "zod"
import { GithubAgents } from "@vectordevai/core/github-agents"
import {
  buildAgentsWorkflow,
  readWorkflowOptions,
  WORKFLOW_FILE,
  type AgentsWorkflowOptions,
} from "@vectordevai/core/review/workflow"
import { spreadScheduleMinutes } from "@vectordevai/core/review/schedule"

export type InstallFlags = { codium?: boolean; ownKey?: boolean; schedule?: string[] }
export type InstallProvider = {
  id: string
  name: string
  env: readonly string[]
  models: { id: string; name: string }[]
}
export type InstallPort = {
  choose: (message: string, choices: { value: string; label: string; hint?: string }[]) => Promise<string>
  confirm: (message: string, initial: boolean) => Promise<boolean>
  text: (message: string, initial: string) => Promise<string>
  info: (message: string) => void
  done: (message: string) => void
  read: () => Promise<string | undefined>
  write: (content: string) => Promise<void>
  listed: () => Promise<readonly string[]>
  installation: () => Promise<{ available: false } | { available: true; installUrl: string }>
  providers: () => Promise<InstallProvider[]>
}

const Schedule = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$(?![\s\S])/),
    cron: z.string().max(100),
    prompt: z.string().min(1).max(100_000),
  })
  .strict()
export const CODIUM_NEXT =
  "Merge this workflow, then bind the repository from the Vector app (Settings → GitHub) or at vectordev.ai/account#github."
export const UPGRADE = "Upgrade this existing GitHub workflow to the separated agent and publish jobs?"

/** Repeat --schedule with JSON objects so shell text and prompt punctuation never become executable workflow fields. */
export function installSchedules(flags: readonly string[] = []) {
  return spreadScheduleMinutes(flags.map((text) => Schedule.parse(JSON.parse(text))))
}

/** Prompt ports keep mode/listing/secret decisions testable without loading a project, contacting GitHub or opening a browser. */
export async function installWorkflow(
  input: { flags?: InstallFlags; version: string; repository: string },
  port: InstallPort,
) {
  const flags = input.flags ?? {}
  if (flags.codium && flags.ownKey) throw new Error("Choose either --codium or --own-key.")
  const existing = await port.read()
  if (existing !== undefined && !readWorkflowOptions(existing) && !(await port.confirm(UPGRADE, false)))
    return { written: false as const }
  const listed = flags.codium || flags.ownKey ? [] : await port.listed().catch(() => [])
  const choice = flags.codium
    ? "codium"
    : flags.ownKey || !listed.includes("github-agents")
      ? "own-key"
      : await port.choose("Choose how Vector runs in GitHub", [
          { value: "own-key", label: "Your own key" },
          {
            value: "codium",
            label: listed.includes("github-no-secret") ? "Codium (your plan, no API key)" : "Codium (your plan)",
          },
        ])
  if (choice !== "own-key" && choice !== "codium") throw new Error("Choose a supported GitHub mode.")
  const schedules = installSchedules(flags.schedule)
  if (choice === "codium" && schedules.length && !flags.codium && !listed.includes("scheduled"))
    throw new Error("GitHub schedules are not available in this setup yet.")
  const installation = await port.installation()
  const slug = installation.available ? GithubAgents.slugFromInstallUrl(installation.installUrl) : undefined
  const publishing = installation.available
    ? await port.choose("Choose how Vector publishes pull requests", [
        {
          value: "github",
          label: "Default publication",
          hint: "Pull requests do not automatically start repository CI",
        },
        {
          value: "app",
          label: "Use the Vector GitHub App",
          hint: "Eligible pull requests can start CI on your own Actions minutes",
        },
      ])
    : "github"
  if (publishing !== "github" && publishing !== "app") throw new Error("Choose a supported GitHub publication mode.")
  if (publishing === "app" && installation.available)
    port.info(
      `Install the Vector GitHub App for this repository before using App publication: ${installation.installUrl}`,
    )
  let options: AgentsWorkflowOptions
  if (choice === "codium") {
    options = {
      mode: "codium",
      provider: "vector",
      model: "vector-plan",
      keys: [],
      autoReview: false,
      publishAuth: publishing,
      version: input.version,
      ...(slug ? { handle: slug } : {}),
      ...(schedules.length ? { schedules } : {}),
    }
  } else {
    const providers = (await port.providers()).filter((provider) => provider.models.length > 0)
    const providerId = await port.choose(
      "Select provider",
      providers.map((provider) => ({ value: provider.id, label: provider.name })),
    )
    const provider = providers.find((entry) => entry.id === providerId)
    if (!provider) throw new Error("Choose an available provider.")
    const model = await port.choose(
      "Select model",
      provider.models.map((entry) => ({ value: entry.id, label: entry.name })),
    )
    if (!provider.models.some((entry) => entry.id === model)) throw new Error("Choose an available model.")
    const autoReview = await port.confirm("Review pull requests automatically?", true)
    const share = await port.confirm(
      "Publish task conversations, code, and tool output publicly on vectordev.ai, including future updates?",
      false,
    )
    const limit = (await port.text("Monthly limit for review spending in USD (0 for no limit)", "50")).trim()
    if (!/^\d+(?:\.\d+)?$/.test(limit) || !Number.isFinite(Number(limit)))
      throw new Error("Enter a nonnegative monthly review limit.")
    options = {
      mode: "own-key",
      provider: provider.id,
      model,
      keys: provider.id === "amazon-bedrock" ? [] : provider.env,
      autoReview,
      share,
      monthlyUsd: Number(limit),
      publishAuth: publishing,
      version: input.version,
      ...(slug ? { handle: slug } : {}),
      ...(schedules.length ? { schedules } : {}),
    }
  }
  const content = buildAgentsWorkflow(options)
  await port.write(content)
  port.info(`Added workflow file: "${WORKFLOW_FILE}"`)
  if (choice === "codium") port.done(CODIUM_NEXT)
  else {
    const keys = options.mode === "own-key" ? (options.keys ?? []) : []
    port.done(
      [
        `Commit \`${WORKFLOW_FILE}\` and push.`,
        `Add the repository secret VECTOR_CLI_TOKEN (${input.repository} → Settings → Secrets and variables → Actions). Create it at https://vectordev.ai/auth/cli.`,
        ...(keys.length
          ? [`Add your provider secret${keys.length > 1 ? "s" : ""}: ${keys.join(", ")}.`]
          : ["Configure your provider's supported Actions identity before running tasks."]),
        'Let Actions open pull requests in Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests".',
        "Comment `/vector <task>` on an issue to get a pull request back. Comment `/vectorscope review` on a pull request to request a review.",
      ].join("\n\n"),
    )
  }
  return { written: true as const, options, content }
}
