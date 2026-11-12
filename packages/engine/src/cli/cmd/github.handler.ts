import path from "path"
import { Filesystem } from "@/util/filesystem"
import * as prompts from "@clack/prompts"
import { Octokit } from "@octokit/rest"
import { graphql } from "@octokit/graphql"
import * as core from "@actions/core"
import * as github from "@actions/github"
import type { Context } from "@actions/github/lib/context"
import type {
  IssueCommentEvent,
  IssuesEvent,
  PullRequestReviewCommentEvent,
  WorkflowDispatchEvent,
  WorkflowRunEvent,
  PullRequestEvent,
} from "@octokit/webhooks-types"
import { UI } from "../ui"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { InstanceRef } from "@/effect/instance-ref"
import { Session } from "@/session/session"
import type { SessionID } from "../../session/schema"
import { Provider } from "@/provider/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { Git } from "@/git"
import { Process } from "@/util/process"
import { parseGitHubRemote } from "@/util/repository"
import { Effect } from "effect"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { formatUsd } from "@vectordevai/core/review/format"
import { escapeVectorMarkers } from "@vectordevai/core/review/state"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"
import { githubFetch } from "./github.shared"
import { GithubRunHelpers } from "./github.run-helpers"
import { sameLogin } from "./github.review-api"
import { TASK_MENTIONS, mentionsFrom, routeGithubEvent, type GithubRoute } from "./github.route"
import { WORKFLOW_FILE } from "@vectordevai/core/review/workflow"
import { PublicSession } from "@vectordevai/schema/public-session"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { resolveGithubAuth, type GithubAuth } from "./github.auth"
import { prepareGithubGit } from "./github.git"
import { appRequested, githubAppInstallation, githubListedPerks, verifyAppPullRequest } from "./github.app"
import { withGithubCallbacks, withGithubSignals } from "./github.lifecycle"
import { SessionPosting } from "@/session/posting"
import { LLMRequestPrep } from "@/session/llm/request"
import { githubSystemInstructions } from "./github.policy"
import { installWorkflow, type InstallFlags } from "./github.install"

// Reactions and commits made with GITHUB_TOKEN show up as this login.
const ACTIONS_BOT = "github-actions[bot]"
const ACTIONS_BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"
const AGENT_REACTION = "eyes"

// Event categories for routing
// USER_EVENTS: triggered by user actions, have actor/issueId, support reactions/comments
// REPO_EVENTS: triggered by automation, no actor/issueId, output to logs/PR only
const USER_EVENTS = ["issue_comment", "pull_request_review_comment", "issues", "pull_request"] as const
const REPO_EVENTS = ["schedule", "workflow_dispatch"] as const
const SUPPORTED_EVENTS = [...USER_EVENTS, ...REPO_EVENTS] as const

type UserEvent = (typeof USER_EVENTS)[number]
type RepoEvent = (typeof REPO_EVENTS)[number]

export const githubInstall = Effect.fn("Cli.github.install")(function* (flags: InstallFlags = {}) {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die("InstanceRef not provided")
  const modelCatalog = yield* ModelCatalog.Service
  const git = yield* Git.Service
  if (ctx.project.vcs !== "git") return yield* Effect.die("Run GitHub setup from a Git repository.")
  const remote = yield* git.run(["remote", "get-url", "origin"], { cwd: ctx.worktree })
  const repository = parseGitHubRemote(remote.text().trim())
  if (!repository) return yield* Effect.die("Run GitHub setup from a GitHub repository.")
  yield* Effect.promise(async () => {
    UI.empty()
    prompts.intro("Install GitHub agent")
    const file = path.join(ctx.worktree, WORKFLOW_FILE)
    await installWorkflow(
      { flags, version: InstallationVersion, repository: `${repository.owner}/${repository.repo}` },
      {
        choose: async (message, options) => {
          const choice = await prompts.select({ message, options, maxItems: 8 })
          if (prompts.isCancel(choice)) throw new UI.CancelledError()
          return choice
        },
        confirm: async (message, initialValue) => {
          const choice = await prompts.confirm({ message, initialValue })
          if (prompts.isCancel(choice)) throw new UI.CancelledError()
          return choice
        },
        text: async (message, defaultValue) => {
          const choice = await prompts.text({
            message,
            defaultValue,
            validate: (text) =>
              text && !/^\d+(?:\.\d+)?$/.test(text.trim()) ? "Enter a nonnegative number, such as 50" : undefined,
          })
          if (prompts.isCancel(choice)) throw new UI.CancelledError()
          return choice.trim() || defaultValue
        },
        info: prompts.log.info,
        done: prompts.outro,
        read: async () => ((await Filesystem.exists(file)) ? Filesystem.readText(file) : undefined),
        write: (content) => Filesystem.write(file, content),
        listed: githubListedPerks,
        installation: githubAppInstallation,
        providers: async () => {
          const catalog = await Effect.runPromise(modelCatalog.get())
          const priority: Record<string, number> = { anthropic: 1, openai: 2, google: 3 }
          return Object.values(catalog)
            .filter((provider) => provider.id !== "github-copilot")
            .sort(
              (a, b) =>
                (priority[a.id] ?? 99) - (priority[b.id] ?? 99) || (a.name ?? a.id).localeCompare(b.name ?? b.id),
            )
            .map((provider) => ({
              id: provider.id,
              name: provider.name ?? provider.id,
              env: provider.env,
              models: Object.values(provider.models)
                .filter((model) => model.status !== "deprecated")
                .map((model) => ({ id: model.id, name: model.name ?? model.id }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            }))
        },
      },
    )
  })
})

export const githubRun = Effect.fn("Cli.github.run")(function* (args: {
  event?: string
  token?: string
  context?: Context
  route?: GithubRoute
  share?: PublicSession.Consent
}) {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die("InstanceRef not provided")
  const gitSvc = yield* Git.Service
  const sessionSvc = yield* Session.Service
  const sessionPrompt = yield* SessionPrompt.Service
  const providerSvc = yield* Provider.Service
  const events = yield* EventV2Bridge.Service
  const permissions = yield* Permission.Service
  const shareSvc = args.share ? yield* PublicSessionShare.Service : undefined
  const resources: {
    auth?: GithubAuth
    acquisition?: Promise<GithubAuth>
    git?: Awaited<ReturnType<typeof prepareGithubGit>>
    preparation?: ReturnType<typeof prepareGithubGit>
  } = {}
  yield* withGithubCallbacks((runLocalEffect) =>
    Effect.promise(async (signal) => {
      const isMock = args.token || args.event

      const context = args.context ?? githubEventContext(args)
      if (!SUPPORTED_EVENTS.includes(context.eventName as (typeof SUPPORTED_EVENTS)[number])) {
        core.setFailed(`Unsupported event type: ${context.eventName}`)
        return
      }

      // Reviews have their own job. A review verb that reaches this one (an old workflow, or a stray call) gets one
      // reply, with no checkout and no model call.
      const route = args.route ?? routeGithubEvent(context, mentionsFrom(process.env["MENTIONS"], TASK_MENTIONS))
      const routed = taskRoutePlan(route, { eventName: context.eventName, prompt: process.env["PROMPT"] })
      if (routed.action === "reply") {
        const token = process.env["GITHUB_TOKEN"]
        if (token)
          await answerReviewVerb(new Octokit({ auth: token, request: { fetch: githubFetch } }), {
            ...context.repo,
            pr: routed.pr,
            actor: context.actor,
            log: (line) => console.log(line),
          })
        else console.log(REVIEW_NEEDS_WORKFLOW)
        return
      }
      if (routed.action === "exit") {
        console.log(routed.message)
        return
      }
      if (routed.action === "fail") {
        core.setFailed(routed.message)
        return
      }

      // Determine event category for routing
      // USER_EVENTS: have actor, issueId, support reactions/comments
      // REPO_EVENTS: no actor/issueId, output to logs/PR only
      const isUserEvent = USER_EVENTS.includes(context.eventName as UserEvent)
      const isRepoEvent = REPO_EVENTS.includes(context.eventName as RepoEvent)
      const isCommentEvent = ["issue_comment", "pull_request_review_comment"].includes(context.eventName)
      const isIssuesEvent = context.eventName === "issues"
      const isScheduleEvent = context.eventName === "schedule"
      const isWorkflowDispatchEvent = context.eventName === "workflow_dispatch"

      const { providerID, modelID } = await normalizeModel()
      const variant = process.env["VARIANT"] || undefined
      const runId = normalizeRunId()
      const { owner, repo } = context.repo
      // For repo events (schedule, workflow_dispatch), payload has no issue/comment data
      const payload = context.payload as
        | IssueCommentEvent
        | IssuesEvent
        | PullRequestReviewCommentEvent
        | WorkflowDispatchEvent
        | WorkflowRunEvent
        | PullRequestEvent
      const issueEvent = isIssueCommentEvent(payload) ? payload : undefined
      // workflow_dispatch has an actor (the user who triggered it), schedule does not
      const actor = isScheduleEvent ? undefined : context.actor

      const issueId = isRepoEvent
        ? undefined
        : context.eventName === "issue_comment" || context.eventName === "issues"
          ? (payload as IssueCommentEvent | IssuesEvent).issue.number
          : (payload as PullRequestEvent | PullRequestReviewCommentEvent).pull_request.number
      const serverUrl = (process.env["GITHUB_SERVER_URL"] || "https://github.com").replace(/\/+$/, "")
      const runUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`

      let appToken: string
      let octoRest!: Octokit
      let octoGraph: typeof graphql
      let session: { id: SessionID; title: string; version: string }
      // Set when GitHub refused to open the pull request because the repository
      // does not let Actions create PRs; the follow-up comment carries it.
      let prBlocked: string | undefined
      let exitCode = 0
      const published: { sessionID?: SessionID; info?: PublicSession.Info } = {}
      type PromptFiles = GithubRunHelpers.PromptFiles
      const triggerCommentId = isCommentEvent
        ? (payload as IssueCommentEvent | PullRequestReviewCommentEvent).comment.id
        : undefined
      let botLogin = ACTIONS_BOT
      const commentType = isCommentEvent
        ? context.eventName === "pull_request_review_comment"
          ? "pr_review"
          : "issue"
        : undefined
      const gitText = async (args: string[]) => {
        const result = await gitStatus(args)
        if (result.exitCode !== 0) {
          throw new Process.RunFailedError(["git", ...args], result.exitCode, result.stdout, result.stderr)
        }
        return result.text().trim()
      }
      const gitRun = async (args: string[]) => {
        const result = await gitStatus(args)
        if (result.exitCode !== 0) {
          throw new Process.RunFailedError(["git", ...args], result.exitCode, result.stdout, result.stderr)
        }
        return result
      }
      const gitStatus = async (args: string[]) => {
        signal.throwIfAborted()
        const network = ["fetch", "push"].includes(args[0])
        if (network) await resources.git?.verify()
        return await runLocalEffect(
          gitSvc.run(args, {
            cwd: ctx.worktree,
            ...(network && resources.git ? { env: resources.git.env } : {}),
          }),
        )
      }
      // Everything the task job posts or commits is checked against the owner's memory first (section 6.4a). Nobody
      // answers questions here, so what repeats it is dropped and counted, and a check that cannot run posts nothing.
      // Once the job knows it is working on a fork's pull request, what it posts links and embeds only on GitHub.
      const pulled = { fork: false }
      const checked = (parts: string[]) =>
        runLocalEffect(
          SessionPosting.headless({
            parts,
            typed: false,
            untrusted: pulled.fork,
            sessionIDs: session ? [session.id] : [],
            log: (line) => console.log(line),
          }),
        )
      const commitChanges = async (summary: string, actor?: string) => {
        // A commit message is checked when the commit is made, since nothing posts it later.
        const [message] = await checked([summary])
        const args = ["commit", "-m", message || "Update from Vector"]
        if (actor) args.push("-m", `Co-authored-by: ${actor} <${actor}@users.noreply.github.com>`)
        await gitRun(args)
      }

      const pushContext = { gitRun, commitChanges, actor }
      const evidenceContext = {
        gitText,
        sessionDiff: () => runLocalEffect(sessionSvc.diff(session.id)),
        collectSessionEvidence,
        runUrl,
        published,
      }

      try {
        // Every model request this run sends, its subagents' and follow-ups' included, carries the repository-work
        // policy and the untrusted-data rule in its system instructions (INV-S14). It is never unpinned: this process
        // serves this one task, and its background subagents, the turns their notes start and the titles the command
        // waits for go on sending requests after githubRun returns, until the instance is disposed.
        LLMRequestPrep.pin(githubSystemInstructions(`${owner}/${repo}`))
        const pullRequest =
          issueEvent?.issue.pull_request || ["pull_request", "pull_request_review_comment"].includes(context.eventName)
            ? issueId
            : undefined
        if (pullRequest && !args.token)
          await verifyAppPullRequest({ repository: `${owner}/${repo}`, pr: pullRequest, signal })
        resources.acquisition = resolveGithubAuth({
          purpose: "task",
          repository: `${owner}/${repo}`,
          pullRequest,
          providedToken: args.token,
          notice: console.log,
          signal,
        })
        // The App exchange is this process's last use of the Actions OIDC request pair (@actions/core reads it when it
        // asks), so nothing that runs later in-process finds it, whether the exchange worked or not. Defence in depth
        // for v2 workflows: /proc/<pid>/environ keeps the launch copy, which only the agent sandbox keeps from children.
        resources.auth = await resources.acquisition.finally(() => {
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
        })
        appToken = resources.auth.token
        botLogin = resources.auth.botLogin
        if (resources.auth.source === "app" || (!isMock && appRequested() && process.env.GITHUB_ACTIONS === "true")) {
          resources.preparation = prepareGithubGit({
            auth: resources.auth,
            mask: core.setSecret,
            run: (args, env) => Effect.runPromise(gitSvc.run(args, { cwd: ctx.worktree, env })),
          })
          resources.git = await resources.preparation
          signal.throwIfAborted()
        }
        octoRest = new Octokit({ auth: appToken, request: { signal, fetch: githubFetch } })
        octoGraph = graphql.defaults({
          headers: { authorization: `token ${appToken}` },
          request: { signal, fetch: githubFetch },
        })

        const { userPrompt, promptFiles } = await GithubRunHelpers.getUserPrompt({
          context,
          payload,
          isRepoEvent,
          isIssuesEvent,
          isCommentEvent,
          octoRest,
          owner,
          repo,
          botLogin,
          appToken,
          signal,
          fixContext: GithubRunHelpers.fixContext,
        })
        await configureGitIdentity()
        // Skip permission check and reactions for repo events (no actor to check, no issue to react to)
        if (isUserEvent) {
          await assertPermissions()
          await addReaction(commentType)
        }

        // Setup vector session
        const repoData = await fetchRepo()
        session = await runLocalEffect(
          sessionSvc.create({
            permission: [
              {
                permission: "question",
                action: "deny",
                pattern: "*",
              },
            ],
          }),
        )
        if (shareSvc && args.share) {
          console.log("Publishing this task conversation, code, and tool output publicly, including future updates.")
          published.info = await runLocalEffect(
            shareSvc.publish({
              sessionID: session.id,
              engine: "v1",
              consent: args.share,
              expiresAt: Date.now() + PublicSession.MAX_AGE_MS,
            }),
          )
          published.sessionID = session.id
          console.log("Public session:", published.info.url)
        }
        await subscribeSessionEvents()
        console.log("vector session", session.id)

        // Handle event types:
        // REPO_EVENTS (schedule, workflow_dispatch): no issue/PR context, output to logs/PR only
        // USER_EVENTS on PR (pull_request, pull_request_review_comment, issue_comment on PR): work on PR branch
        // USER_EVENTS on Issue (issue_comment on issue, issues): create new branch, may create PR
        if (isRepoEvent) {
          // Repo event - no issue/PR context, output goes to logs
          if (isWorkflowDispatchEvent && actor) {
            console.log(`Triggered by: ${actor}`)
          }
          const branchPrefix = isWorkflowDispatchEvent ? "dispatch" : "schedule"
          const branch = await checkoutNewBranch(branchPrefix)
          const head = await gitText(["rev-parse", "HEAD"])
          const response = await chat(userPrompt, promptFiles)
          const { dirty, uncommittedChanges, switched } = await branchIsDirty(head, branch)
          if (switched) {
            // Agent switched branches (likely created its own branch/PR)
            console.log("Agent managed its own branch, skipping infrastructure push/PR")
            console.log("Response:", response)
          } else if (dirty) {
            const summary = await summarize(response)
            // workflow_dispatch has an actor for co-author attribution, schedule does not
            await GithubRunHelpers.pushToNewBranch(pushContext, summary, branch, uncommittedChanges, isScheduleEvent)
            const triggerType = isWorkflowDispatchEvent ? "workflow_dispatch" : "scheduled workflow"
            const pr = await GithubRunHelpers.createPR(
              {
                checked,
                octoRest,
                owner,
                repo,
                hasNewCommits,
                authSource: resources.auth?.source,
                onBlocked: (message) => {
                  prBlocked = message
                },
              },
              repoData.data.default_branch,
              branch,
              summary,
              await GithubRunHelpers.evidence(evidenceContext, response, head, {
                trigger: `Triggered by ${triggerType}`,
              }),
            )
            if (pr) {
              console.log(`Created PR #${pr}`)
              await requestReview(pr, repoData.data.default_branch)
            } else {
              console.log(prBlocked ?? "Skipped PR creation (no new commits)")
            }
          } else {
            console.log("Response:", response)
          }
        } else if (
          ["pull_request", "pull_request_review_comment"].includes(context.eventName) ||
          issueEvent?.issue.pull_request
        ) {
          const prData = await GithubRunHelpers.fetchPR({ octoGraph, owner, repo, issueId })
          pulled.fork = prData.headRepository.nameWithOwner !== prData.baseRepository.nameWithOwner
          if (resources.auth.source === "app" && prData.headRepository.nameWithOwner !== `${owner}/${repo}`)
            throw new Error("Vector App tasks cannot execute a fork pull request.")
          // Local PR
          if (prData.headRepository.nameWithOwner === prData.baseRepository.nameWithOwner) {
            await GithubRunHelpers.checkoutLocalBranch(pushContext, prData)
            const head = await gitText(["rev-parse", "HEAD"])
            const dataPrompt = GithubRunHelpers.buildPromptDataForPR({ triggerCommentId }, prData)
            const response = await chat(`${userPrompt}\n\n${dataPrompt}`, promptFiles)
            const { dirty, uncommittedChanges, switched } = await branchIsDirty(head, prData.headRefName)
            if (switched) {
              console.log("Agent managed its own branch, skipping infrastructure push")
            }
            if (dirty && !switched) {
              const summary = await summarize(response)
              await GithubRunHelpers.pushToLocalBranch(pushContext, summary, uncommittedChanges)
            }
            await GithubRunHelpers.createComment(
              { checked, octoRest, owner, repo, issueId, createTaskComment },
              await GithubRunHelpers.evidence(evidenceContext, response, head),
            )
            await removeReaction(commentType)
          }
          // Fork PR
          else {
            const forkBranch = await checkoutForkBranch(prData)
            const head = await gitText(["rev-parse", "HEAD"])
            const dataPrompt = GithubRunHelpers.buildPromptDataForPR({ triggerCommentId }, prData)
            const response = await chat(`${userPrompt}\n\n${dataPrompt}`, promptFiles)
            const { dirty, uncommittedChanges, switched } = await branchIsDirty(head, forkBranch)
            if (switched) {
              console.log("Agent managed its own branch, skipping infrastructure push")
            }
            if (dirty && !switched) {
              const summary = await summarize(response)
              await pushToForkBranch(summary, prData, uncommittedChanges)
            }
            await GithubRunHelpers.createComment(
              { checked, octoRest, owner, repo, issueId, createTaskComment },
              await GithubRunHelpers.evidence(evidenceContext, response, head),
            )
            await removeReaction(commentType)
          }
        }
        // Issue
        else {
          const branch = await checkoutNewBranch("issue")
          const head = await gitText(["rev-parse", "HEAD"])
          const issueData = await GithubRunHelpers.fetchIssue({ octoGraph, owner, repo, issueId })
          const dataPrompt = GithubRunHelpers.buildPromptDataForIssue({ triggerCommentId }, issueData)
          const response = await chat(`${userPrompt}\n\n${dataPrompt}`, promptFiles)
          const { dirty, uncommittedChanges, switched } = await branchIsDirty(head, branch)
          if (switched) {
            // Agent switched branches (likely created its own branch/PR).
            // Don't push the stale infrastructure branch — just comment.
            await GithubRunHelpers.createComment(
              { checked, octoRest, owner, repo, issueId, createTaskComment },
              `${response}${footer()}`,
            )
            await removeReaction(commentType)
          } else if (dirty) {
            const summary = await summarize(response)
            await GithubRunHelpers.pushToNewBranch(pushContext, summary, branch, uncommittedChanges, false)
            const pr = await GithubRunHelpers.createPR(
              {
                checked,
                octoRest,
                owner,
                repo,
                hasNewCommits,
                authSource: resources.auth?.source,
                onBlocked: (message) => {
                  prBlocked = message
                },
              },
              repoData.data.default_branch,
              branch,
              summary,
              await GithubRunHelpers.evidence(evidenceContext, response, head, { closes: issueId }),
            )
            if (pr) {
              await GithubRunHelpers.createComment(
                { checked, octoRest, owner, repo, issueId, createTaskComment },
                `Created PR #${pr}${footer()}`,
              )
              await requestReview(pr, repoData.data.default_branch)
            } else {
              await GithubRunHelpers.createComment(
                { checked, octoRest, owner, repo, issueId, createTaskComment },
                await GithubRunHelpers.evidence(evidenceContext, response, head, { trigger: prBlocked }),
              )
            }
            await removeReaction(commentType)
          } else {
            await GithubRunHelpers.createComment(
              { checked, octoRest, owner, repo, issueId, createTaskComment },
              `${response}${footer()}`,
            )
            await removeReaction(commentType)
          }
        }
      } catch (e: unknown) {
        if (signal.aborted) return
        exitCode = 1
        let msg = e instanceof Error ? e.message : String(e)
        if (e instanceof Process.RunFailedError) {
          msg = resources.auth?.source === "app" ? "The repository-scoped Git operation failed." : e.stderr.toString()
        } else if (e instanceof Error) {
          msg = e.message
        }
        console.error(msg)
        if (isUserEvent && resources.auth && !signal.aborted) {
          await GithubRunHelpers.createComment(
            { checked, octoRest, owner, repo, issueId, createTaskComment },
            `${msg}${footer()}`,
          ).catch(() => undefined)
          await removeReaction(commentType).catch(() => undefined)
        }
        core.setFailed(msg)
        // Also output the clean error message for the action to capture
        //core.setOutput("prepare_error", e.message);
      }
      if (shareSvc && published.sessionID) {
        await runLocalEffect(shareSvc.flush(published.sessionID)).catch((error) => {
          core.setFailed(
            `Could not finish updating the public session: ${error instanceof Error ? error.message : String(error)}`,
          )
          exitCode = 1
        })
      }
      process.exitCode = exitCode

      async function normalizeModel() {
        const value = process.env["MODEL"]
        if (value) {
          const { providerID, modelID } = Provider.parseModel(value)
          if (!providerID.length || !modelID.length)
            throw new Error(`Invalid model ${value}. Model must be in the format "provider/model".`)
          const providers = await runLocalEffect(providerSvc.list())
          if (!providers[providerID]?.models[modelID])
            throw new Error("This workflow was set up by an older Vector; run vector github install again.")
          return { providerID, modelID }
        }
        // An available Vector free model is selected when no connected provider has a default.
        const configured = await runLocalEffect(providerSvc.defaultModel()).catch(() => undefined)
        if (configured) return configured
        throw new Error(
          "No GitHub model is set. Set MODEL in the workflow to provider/model and add that provider's credentials as GitHub Actions secrets. Run `vector github install` to configure the workflow.",
        )
      }

      function normalizeRunId() {
        const value = process.env["GITHUB_RUN_ID"]
        if (!value) throw new Error(`Environment variable "GITHUB_RUN_ID" is not set`)
        return value
      }

      function isIssueCommentEvent(
        event:
          | IssueCommentEvent
          | IssuesEvent
          | PullRequestReviewCommentEvent
          | WorkflowDispatchEvent
          | WorkflowRunEvent
          | PullRequestEvent,
      ): event is IssueCommentEvent {
        return "issue" in event && "comment" in event
      }

      async function subscribeSessionEvents() {
        return GithubRunHelpers.subscribeSessionEvents({
          run: runLocalEffect,
          sessions: sessionSvc,
          sessionID: session.id,
          events,
          permissions,
        })
      }

      async function summarize(response: string) {
        return GithubRunHelpers.summarize(
          {
            run: runLocalEffect,
            prompt: sessionPrompt,
            sessionID: session.id,
            variant,
            model: { providerID, modelID },
          },
          response,
          () =>
            `Fix issue: ${issueEvent ? issueEvent.issue.title : (payload as PullRequestReviewCommentEvent).pull_request.title}`,
        )
      }

      async function chat(message: string, files: PromptFiles = []) {
        return GithubRunHelpers.chat(
          {
            run: runLocalEffect,
            prompt: sessionPrompt,
            sessionID: session.id,
            variant,
            model: { providerID, modelID },
          },
          message,
          files,
        )
      }

      async function checkoutNewBranch(type: "issue" | "schedule" | "dispatch") {
        console.log("Checking out new branch...")
        const branch = GithubRunHelpers.generateBranchName({ issueId }, type)
        await gitRun(["checkout", "-b", branch])
        return branch
      }

      async function checkoutForkBranch(pr: GithubRunHelpers.GitHubPullRequest) {
        console.log("Checking out fork branch...")

        const remoteBranch = pr.headRefName
        const localBranch = GithubRunHelpers.generateBranchName({ issueId }, "pr")
        const depth = Math.max(pr.commits.totalCount, 20)

        await gitRun(["remote", "add", "fork", `https://github.com/${pr.headRepository.nameWithOwner}.git`])
        await gitRun(["fetch", "fork", `--depth=${depth}`, remoteBranch])
        await gitRun(["checkout", "-b", localBranch, `fork/${remoteBranch}`])
        return localBranch
      }

      async function pushToForkBranch(summary: string, pr: GithubRunHelpers.GitHubPullRequest, commit: boolean) {
        console.log("Pushing to fork branch...")

        const remoteBranch = pr.headRefName

        if (commit) {
          await gitRun(["add", "."])
          await commitChanges(summary, actor)
        }
        await gitRun(["push", "fork", `HEAD:${remoteBranch}`])
      }

      async function branchIsDirty(originalHead: string, expectedBranch: string) {
        console.log("Checking if branch is dirty...")
        // Detect if the agent switched branches during chat (e.g. created
        // its own branch, committed, and possibly pushed/created a PR).
        const current = await gitText(["rev-parse", "--abbrev-ref", "HEAD"])
        if (current !== expectedBranch) {
          console.log(`Branch changed during chat: expected ${expectedBranch}, now on ${current}`)
          return { dirty: true, uncommittedChanges: false, switched: true }
        }

        const ret = await gitStatus(["status", "--porcelain"])
        const status = ret.stdout.toString().trim()
        if (status.length > 0) {
          return { dirty: true, uncommittedChanges: true, switched: false }
        }
        const head = await gitText(["rev-parse", "HEAD"])
        return {
          dirty: head !== originalHead,
          uncommittedChanges: false,
          switched: false,
        }
      }

      // Verify commits exist between base ref and a branch using rev-list.
      // Falls back to fetching from origin when local refs are missing
      // (common in shallow clones from actions/checkout).
      async function hasNewCommits(base: string, head: string) {
        const result = await gitStatus(["rev-list", "--count", `${base}..${head}`])
        if (result.exitCode !== 0) {
          console.log(`rev-list failed, fetching origin/${base}...`)
          await gitStatus(["fetch", "origin", base, "--depth=1"])
          const retry = await gitStatus(["rev-list", "--count", `origin/${base}..${head}`])
          if (retry.exitCode !== 0) return true // assume dirty if we can't tell
          return parseInt(retry.stdout.toString().trim()) > 0
        }
        return parseInt(result.stdout.toString().trim()) > 0
      }

      async function assertPermissions() {
        // Only called for non-schedule events, so actor is defined
        console.log(`Asserting permissions for user ${actor}...`)

        let permission
        try {
          const response = await octoRest.repos.getCollaboratorPermissionLevel({
            owner,
            repo,
            username: actor!,
          })

          permission = response.data.permission
          console.log(`  permission: ${permission}`)
        } catch (error) {
          console.error(`Failed to check permissions: ${error}`)
          throw new Error(`Failed to check permissions for user ${actor}: ${error}`, { cause: error })
        }

        if (!["admin", "maintain", "write"].includes(permission))
          throw new Error(`User ${actor} does not have write permissions`)
      }

      async function addReaction(commentType?: "issue" | "pr_review") {
        // Only called for non-schedule events, so triggerCommentId is defined
        console.log("Adding reaction...")
        if (triggerCommentId) {
          if (commentType === "pr_review") {
            return await octoRest.rest.reactions.createForPullRequestReviewComment({
              owner,
              repo,
              comment_id: triggerCommentId!,
              content: AGENT_REACTION,
            })
          }
          return await octoRest.rest.reactions.createForIssueComment({
            owner,
            repo,
            comment_id: triggerCommentId!,
            content: AGENT_REACTION,
          })
        }
        return await octoRest.rest.reactions.createForIssue({
          owner,
          repo,
          issue_number: issueId!,
          content: AGENT_REACTION,
        })
      }

      async function removeReaction(commentType?: "issue" | "pr_review") {
        // Only called for non-schedule events, so triggerCommentId is defined
        console.log("Removing reaction...")
        if (triggerCommentId) {
          if (commentType === "pr_review") {
            const reactions = await octoRest.rest.reactions.listForPullRequestReviewComment({
              owner,
              repo,
              comment_id: triggerCommentId!,
              content: AGENT_REACTION,
            })

            const eyesReaction = reactions.data.find((r) => r.user?.login === botLogin)
            if (!eyesReaction) return

            return await octoRest.rest.reactions.deleteForPullRequestComment({
              owner,
              repo,
              comment_id: triggerCommentId!,
              reaction_id: eyesReaction.id,
            })
          }

          const reactions = await octoRest.rest.reactions.listForIssueComment({
            owner,
            repo,
            comment_id: triggerCommentId!,
            content: AGENT_REACTION,
          })

          const eyesReaction = reactions.data.find((r) => r.user?.login === botLogin)
          if (!eyesReaction) return

          return await octoRest.rest.reactions.deleteForIssueComment({
            owner,
            repo,
            comment_id: triggerCommentId!,
            reaction_id: eyesReaction.id,
          })
        }

        const reactions = await octoRest.rest.reactions.listForIssue({
          owner,
          repo,
          issue_number: issueId!,
          content: AGENT_REACTION,
        })

        const eyesReaction = reactions.data.find((r) => r.user?.login === botLogin)
        if (!eyesReaction) return

        await octoRest.rest.reactions.deleteForIssue({
          owner,
          repo,
          issue_number: issueId!,
          reaction_id: eyesReaction.id,
        })
      }

      function footer() {
        return `\n\n---\n[Vector run](${runUrl})${published.info ? ` · [Public session](${published.info.url})` : ""}`
      }

      // App-authored PR events run normal CI. The repository token retains the explicit review fallback.
      async function requestReview(pr: number, ref: string) {
        if (process.env["VECTOR_REVIEW_AUTO"] !== "1") return
        if (resources.auth?.source === "app") return
        await dispatchReview(octoRest, { owner, repo, ref, pr, log: console.log })
      }

      // Messages from the run's session and every subagent it spawned (their
      // checks and cost count too), plus the judge subagent's final text.
      async function collectSessionEvidence() {
        return GithubRunHelpers.collectSessionEvidence({
          run: runLocalEffect,
          sessions: sessionSvc,
          sessionID: session.id,
        })
      }

      async function configureGitIdentity() {
        // Do not change git config when running locally
        if (isMock || resources.auth?.source === "app") return
        // actions/checkout keeps GITHUB_TOKEN in the extraheader for push but
        // sets no committer; without one `git commit` refuses to run.
        const name = await gitStatus(["config", "--get", "user.name"])
        if (name.exitCode === 0 && name.stdout.toString().trim()) return
        await gitRun(["config", "--local", "user.name", ACTIONS_BOT])
        await gitRun(["config", "--local", "user.email", ACTIONS_BOT_EMAIL])
      }

      async function fetchRepo() {
        return await octoRest.rest.repos.get({ owner, repo })
      }
    }),
  ).pipe(
    Effect.ensuring(
      Effect.promise(async () => {
        const auth = resources.auth ?? (await resources.acquisition?.catch(() => undefined))
        const git = resources.git ?? (await resources.preparation?.catch(() => undefined))
        const results = await Promise.allSettled([git?.dispose(), auth?.dispose()])
        if (results.some((result) => result.status === "rejected"))
          core.setFailed(
            "Vector could not finish GitHub credential cleanup. The App credential expires automatically within one hour.",
          )
      }),
    ),
    withGithubSignals,
  )
})

export const REVIEW_NEEDS_WORKFLOW = "Reviews need the updated workflow. Run `vector github install` again to add them."

// The event the task job runs for: a mock one passed with --event, or the Actions event.
// The task's text part lives with the session helpers it is sent through, and the `/vector fix` finding with the prompt
// builders, which the agent phase shares without loading this module.
export { taskPart, fixContext, findingForPrompt, isFixCommand } from "./github.run-helpers"

export function githubEventContext(args: { event?: string; token?: string }): Context {
  return args.token || args.event ? (JSON.parse(args.event!) as Context) : github.context
}

export type TaskRoutePlan =
  | { action: "run" }
  | { action: "reply"; pr: number }
  | { action: "exit"; message: string }
  | { action: "fail"; message: string }

// What the task job does with a routed event (section 3.14). Review verbs get one reply; a workflow's own PROMPT on a
// pull request, dispatch or schedule event still runs as a task, as it did before reviews.
export function taskRoutePlan(route: GithubRoute, input: { eventName: string; prompt?: string }): TaskRoutePlan {
  if (route.job === "task") return { action: "run" }
  if (route.job === "control" || (route.job === "review" && route.trigger === "command"))
    return { action: "reply", pr: route.pr }
  const comment = input.eventName === "issue_comment" || input.eventName === "pull_request_review_comment"
  if (!comment && input.prompt) return { action: "run" }
  if (route.job === "review")
    return {
      action: "fail",
      message: `Pull request reviews run with \`vector github review\`. Run \`vector github install\` again to update ${WORKFLOW_FILE}.`,
    }
  return { action: "exit", message: `Nothing to do: ${route.reason}.` }
}

// Everything the task job posts goes through here. Its text can quote model output, so it must never carry a marker
// the review job would read as its own.
export async function createTaskComment(
  octo: Octokit,
  input: { owner: string; repo: string; issue: number; body: string },
) {
  return await octo.rest.issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue,
    body: escapeVectorMarkers(input.body),
  })
}

// Old workflows send review verbs here. Only a writer gets the reply, and only once per pull request, so nobody else can
// make the bot post it, and nobody can make it post it again and again. Returns whether it replied.
export async function answerReviewVerb(
  octo: Octokit,
  input: { owner: string; repo: string; pr: number; actor?: string; log?: (line: string) => void },
): Promise<boolean> {
  const log = input.log ?? (() => {})
  const writer = input.actor
    ? await octo.rest.repos
        .getCollaboratorPermissionLevel({ owner: input.owner, repo: input.repo, username: input.actor })
        .then(
          ({ data }) =>
            ["admin", "maintain", "write"].some((level) => level === data.permission || level === data.role_name),
          () => false,
        )
    : false
  if (!writer) {
    log(`${input.actor || "The commenter"} does not have write access to ${input.owner}/${input.repo}; no reply.`)
    return false
  }
  for (let page = 1; page <= 10; page++) {
    const comments: { body?: string | null; user?: { login?: string | null } | null }[] = await octo.rest.issues
      .listComments({ owner: input.owner, repo: input.repo, issue_number: input.pr, per_page: 100, page })
      .then(
        (response) => response.data,
        () => [],
      )
    if (
      comments.some(
        (comment) => sameLogin(comment.user?.login, ACTIONS_BOT) && comment.body?.includes(REVIEW_NEEDS_WORKFLOW),
      )
    ) {
      log("Vector has already asked for the updated workflow on this pull request.")
      return false
    }
    if (comments.length < 100) break
  }
  await createTaskComment(octo, { owner: input.owner, repo: input.repo, issue: input.pr, body: REVIEW_NEEDS_WORKFLOW })
  return true
}

// Asks the workflow to review a pull request Vector opened. Older workflows have no dispatch input, and some tokens
// may not dispatch; either way the task itself has succeeded, so this only logs.
export async function dispatchReview(
  octo: Octokit,
  input: { owner: string; repo: string; ref: string; pr: number; log: (line: string) => void },
) {
  try {
    await octo.rest.actions.createWorkflowDispatch({
      owner: input.owner,
      repo: input.repo,
      workflow_id: path.basename(WORKFLOW_FILE),
      ref: input.ref,
      inputs: { pr: String(input.pr) },
    })
    input.log(`Requested a review of #${input.pr}.`)
  } catch (error) {
    const status = (error as { status?: unknown } | undefined)?.status
    if (status === 403 || status === 404)
      input.log("Run `vector github install` again to review pull requests Vector opens.")
    else input.log(`Could not request a review of #${input.pr}: ${error instanceof Error ? error.message : error}`)
  }
}

export function reviewCostLine(input: { model: string; monthlyUsd?: number }): string {
  const review = formatUsd(DEFAULT_REVIEW_CONFIG.maxCostUsd)
  const pr = formatUsd(DEFAULT_REVIEW_CONFIG.maxCostUsdPerPr)
  const limits = input.monthlyUsd
    ? `Each review stops at ${review}, each pull request at ${pr}, and all reviews at ${formatUsd(input.monthlyUsd)} a month.`
    : `Each review stops at ${review} and each pull request at ${pr}, with no monthly limit.`
  return `Reviews run on ${input.model} with your key. ${limits} Change these in .vector/review.json and the workflow file.`
}
