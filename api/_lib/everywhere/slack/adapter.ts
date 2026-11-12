import { randomUUID } from "node:crypto"
import { LIMITS, isRepositoryName, sanitizeLabel, type InboundTrigger, type UntrustedItem } from "../../../../packages/schema/src/everywhere.js"
import { renderRefusal } from "../../../../packages/schema/src/everywhere-policy.js"
import { ApiError } from "../../http.js"
import type { EverywhereConfig } from "../config.js"
import { eraseInstallation } from "../erase.js"
import { findLink, installationAuthority, installToken, readInstall, readInstallSnapshot, redeemLinkCode, setMappingByWord, unlink, type InstallRecord } from "../identity.js"
import { jobEraser, openReply, readComputer, readJob, readJobBody, updateJobReply, type JobsContext } from "../jobs.js"
import { everywhereKeys } from "../keys.js"
import type { JobView, ParsedTrigger, PlatformAdapter, ReplyReference } from "../platform.js"
import type { Ports } from "../ports.js"
import { setValue, swapValue } from "../store.js"
import { createSlackClient, SlackFailure, type SlackClient } from "./client.js"
import { slackCooldown } from "./cooldown.js"
import { slackCommand } from "./parse.js"
import { slackPlan, slackResult } from "./render.js"
import { slackObject, slackTimestamp, verifySlack } from "./verify.js"

export type SlackDeps = {
  readonly config: () => EverywhereConfig
  readonly context: () => JobsContext
  readonly ports: Ports
  readonly fetcher?: typeof fetch
}

function reference(reply: ReplyReference) {
  if (typeof reply.channel !== "string" || !/^[CDG][A-Z0-9]{1,31}$/.test(reply.channel) ||
    !slackTimestamp(reply.thread) || typeof reply.user !== "string" || !/^[UW][A-Z0-9]{1,31}$/.test(reply.user))
    throw new ApiError(400, "SLACK_REFERENCE_INVALID", "The Slack thread is unavailable.")
  return { channel: reply.channel, thread_ts: reply.thread, user: reply.user }
}

function triggerView(trigger: InboundTrigger): JobView {
  const split = trigger.thread.ref.indexOf(":")
  return { jid: "", platform: "slack", installation: trigger.installation, shared: trigger.shared,
    reply: { channel: trigger.thread.ref.slice(0, split), thread: trigger.thread.ref.slice(split + 1), user: trigger.actor.userId } }
}

/** No registry side effects: routes, reports and sweeps construct the same adapter with current configuration. */
export function createSlackAdapter(deps: SlackDeps): PlatformAdapter {
  const ctx = deps.context
  const erase = (installation: string) => eraseInstallation({ ...ctx(), jobs: jobEraser(ctx().store) }, installation, "tokens-revoked").then(() => undefined)
  const client = async (installation: string, record?: InstallRecord, view?: JobView): Promise<SlackClient> => {
    const current = async () => {
      const snapshot = view?.job ? await readInstallSnapshot(ctx().store, installation) : undefined
      if (view?.job && (!snapshot || typeof view.reply.installRevision !== "string" || installationAuthority(snapshot) !== view.reply.installRevision))
        throw new ApiError(409, "SLACK_AUTHORITY_CHANGED", "The Slack connection changed. This result is held for review.")
      const installed = snapshot?.record ?? record ?? await readInstall(ctx().store, installation)
      const token = installed && installToken(ctx().keys, installation, installed)
      if (!token) throw new ApiError(503, "SLACK_UNAVAILABLE", "The Slack installation is unavailable.")
      return createSlackClient({ token, fetcher: deps.fetcher, now: () => ctx().now, revoked: () => erase(installation),
        cooldown: slackCooldown(ctx().store, installation) })
    }
    const first = await current()
    // Re-read before every effect, including a later rename, plan, private summary or terminal status in this call.
    return view?.job ? async (method, body) => (await current())(method, body) : first
  }
  const ephemeral = async (view: JobView, text: string) => {
    const ref = reference(view.reply)
    await (await client(view.installation, undefined, view))("chat.postEphemeral", { ...ref, text, unfurl_links: false, unfurl_media: false, parse: "none" })
  }
  const status = async (view: JobView, value: "processing" | "active" | "closed") => {
    const ref = reference(view.reply)
    await (await client(view.installation, undefined, view))("agents.sessions.setStatus", { channel_id: ref.channel, thread_ts: ref.thread_ts, status: value })
  }
  const answer = async (trigger: InboundTrigger, text: string) => {
    const view = triggerView(trigger)
    await ephemeral(view, text)
    if (trigger.kind !== "command" && trigger.kind !== "stop") await status(view, "active")
  }
  const locked = async (view: JobView, terminal: boolean, work: () => Promise<void>) => {
    const token = randomUUID()
    const key = everywhereKeys.jobStatusLock(view.jid)
    // Longer than a whole serverless invocation. A successor never interleaves terminal status with old progress.
    if (!await setValue(ctx().store, key, token, { ttlMs: 120_000, onlyNew: true })) {
      if (terminal) throw new SlackFailure(false)
      return
    }
    try { await work() } finally { await swapValue(ctx().store, key, token, undefined) }
  }
  const ended = (state: string) => ["settled", "cancelled", "expired", "failed", "refused", "lost"].includes(state)

  /** A timeout after the first post is ambiguous. Retain the receipt and summary; never blindly create a duplicate. */
  const post = async (view: JobView, call: SlackClient, kind: "plan" | "result" | "private", body: Record<string, unknown>) => {
    const job = await readJob(ctx().store, view.jid)
    const reply = job && openReply(ctx(), job)
    if (!job || !reply) throw new ApiError(503, "SLACK_JOB_UNAVAILABLE", "The Slack job is unavailable.")
    const ts = reply[`${kind}Ts`]
    if (kind === "private" && reply.privateDone === true) return
    if (typeof ts === "string" && slackTimestamp(ts)) {
      await call("chat.update", { channel: body.channel, ts, text: body.text, blocks: body.blocks, parse: "none" })
      return
    }
    if (reply[`${kind}Attempt`] === true) throw new SlackFailure(true)
    if (!await updateJobReply(ctx(), view.jid, { [`${kind}Attempt`]: true })) throw new SlackFailure(true)
    try {
      const result = await call(kind === "private" ? "chat.postEphemeral" : "chat.postMessage", body)
      const posted = kind === "private" ? result.message_ts : result.ts
      if (!slackTimestamp(posted)) throw new SlackFailure(true)
      if (!await updateJobReply(ctx(), view.jid, kind === "private" ? { privateDone: true } : { [`${kind}Ts`]: posted })) throw new SlackFailure(true)
    } catch (error) {
      if (error instanceof SlackFailure && !error.uncertain) await updateJobReply(ctx(), view.jid, { [`${kind}Attempt`]: false })
      throw error
    }
  }

  const adapter: PlatformAdapter = {
    id: "slack", ackMs: 2_500, heartbeats: true,
    verify: async (raw, headers, now) => {
      if (!verifySlack(raw, headers, deps.config().slack?.signingSecret, now)) return { ok: false, status: 401 }
      try { return { ok: true, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) } }
      catch { return { ok: false, status: 400 } }
    },
    parse: () => ({ ignore: "installation-required" }),
    acknowledge: async (view) => { if (view.reply.control !== true) await status(view, "processing") },
    prepare: async (parsed, record) => {
      const call = await client(parsed.trigger.installation, record)
      const user = slackObject((await call("users.info", { user: parsed.trigger.actor.userId })).user)
      const enterprise = slackObject(user.enterprise_user)
      const local = user.team_id === parsed.reply.team || (enterprise.enterprise_id === parsed.reply.enterprise &&
        typeof parsed.reply.enterprise === "string" && Array.isArray(enterprise.teams) && enterprise.teams.includes(parsed.reply.team))
      if (user.id !== parsed.trigger.actor.userId || user.deleted === true) return { ignore: "identity" }
      const proven = [user.is_bot, user.deleted, user.is_restricted, user.is_ultra_restricted].every((flag) => typeof flag === "boolean")
      const actor = { ...parsed.trigger.actor, bot: user.is_bot === true || user.id === record.botUserId,
        guest: user.is_restricted === true || user.is_ultra_restricted === true, external: !proven || user.is_stranger === true || !local }
      const context: UntrustedItem[] = []
      if (!actor.bot && !actor.external && !actor.guest && parsed.reply.threadRead === true && parsed.reply.control !== true) {
        const team = parsed.reply.team
        const allowed = typeof team === "string" && await setValue(ctx().store, everywhereKeys.slackThreadRead(team), "1", { ttlMs: 60_000, onlyNew: true })
        if (allowed) {
          try {
            const ref = reference(parsed.reply)
            const result = await call("conversations.replies", { channel: ref.channel, ts: ref.thread_ts, limit: LIMITS.threadMessages })
            for (const value of Array.isArray(result.messages) ? result.messages.slice(0, LIMITS.threadMessages) : []) {
              const message = slackObject(value)
              if (typeof message.text !== "string" || message.ts === parsed.reply.eventTs) continue
              context.push({ from: message.user === actor.userId ? "requester" : message.bot_id ? "bot" : "teammate", text: message.text.slice(0, LIMITS.itemChars) })
              if (context.reduce((size, item) => size + item.text.length, 0) >= 18_000) break
            }
            if (result.has_more === true) context.push({ from: "platform", text: "Additional thread messages were omitted." })
          } catch {
            if (!await readInstall(ctx().store, parsed.trigger.installation)) return { ignore: "installation-revoked" }
            context.push({ from: "platform", text: "Thread context was unavailable; only the requester's current message is the task." })
          }
        } else context.push({ from: "platform", text: "Thread context was omitted because this workspace already used its one thread read this minute." })
      }
      return { ...parsed, trigger: { ...parsed.trigger, actor, context } }
    },
    control: async (parsed) => {
      const command = slackCommand(parsed.trigger.task)
      if (!command || command.name === "stop") return false
      const view = { ...triggerView(parsed.trigger), reply: parsed.reply }
      const identity = { installation: parsed.trigger.installation, userId: parsed.trigger.actor.userId, actor: parsed.trigger.actor }
      if (command.name === "help") { await adapter.help(parsed.trigger); return true }
      if (command.name === "link") {
        const result = await redeemLinkCode(ctx(), { ...identity, code: command.argument, place: parsed.trigger.shared ? "shared" : "private" })
        await ephemeral(view, result.ok ? "Your Vector account is linked. Use help for task instructions." : result.code === "shared-place" ?
          "That code was discarded. Generate a new code and send link <code> only in a direct message to Vector." : "The account could not be linked. Generate a new code in Vector and try again in a direct message.")
        return true
      }
      if (command.name === "unlink") {
        const linked = await findLink(ctx().store, identity.installation, identity.userId)
        if (linked) await unlink(ctx(), { account: linked.account, installation: identity.installation, userId: identity.userId })
        await ephemeral(view, "Your Vector link for this workspace has been removed.")
        return true
      }
      const linked = await findLink(ctx().store, identity.installation, identity.userId)
      if (!linked) { await adapter.linkPrompt(parsed.trigger); return true }
      if (command.name === "status") {
        const computer = await readComputer(ctx().store, linked.account)
        const online = computer.lastSeen !== undefined && ctx().now - computer.lastSeen < 90_000
        await ephemeral(view, online ? "Your computer has checked in recently. Task availability also depends on your Remote Control settings, local mapping and caps." : "Your computer has not checked in recently. Open Vector and check Remote Control settings.")
        return true
      }
      const repository = isRepositoryName(command.argument) ? await deps.ports.repository?.(command.argument) : undefined
      if (!repository) { await ephemeral(view, "That repository cannot be verified. Connect GitHub and choose a repository in Vector settings."); return true }
      const mapped = await setMappingByWord(ctx(), { ...identity, place: parsed.place, repository, maySponsor: (account) => deps.ports.perk(account, "everywhere") })
      await ephemeral(view, mapped.ok ? "The repository mapping for this channel was updated." : "This repository mapping could not be changed. Ask the workspace connector to update it in Vector settings.")
      return true
    },
    progress: async (view, milestone) => {
      if (!view.job) return
      await locked(view, false, async () => {
        const current = await readJob(ctx().store, view.jid)
        if (!current || ended(current.state)) return
        await status(view, "processing")
        if (milestone === "heartbeat") return
        const afterStatus = await readJob(ctx().store, view.jid)
        if (!afterStatus || ended(afterStatus.state)) return
        const call = await client(view.installation, undefined, view)
        const ref = reference(view.reply)
        const body = await readJobBody(ctx(), view.jid)
        if (milestone === "started" && body) await call("agents.sessions.rename", { channel_id: ref.channel, thread_ts: ref.thread_ts,
          title: view.shared ? "Vector task" : `${current.repository.fullName}: ${sanitizeLabel(body.task.split(/\s+/).slice(0, 6).join(" ")).slice(0, 60)}` })
        await post(view, call, "plan", { channel: ref.channel, thread_ts: ref.thread_ts, text: "Vector is working on this task.",
          blocks: [slackPlan(milestone)], unfurl_links: false, unfurl_media: false, parse: "none" })
      })
    },
    finish: async (view, result) => {
      await locked(view, true, async () => {
        const call = await client(view.installation, undefined, view)
        const ref = reference(view.reply)
        await post(view, call, "result", { channel: ref.channel, thread_ts: ref.thread_ts, text: result.text,
          blocks: [slackPlan("pushing", true), ...slackResult(result.text)], unfurl_links: false, unfurl_media: false, parse: "none" })
        if (result.privateText) await post(view, call, "private", { ...ref, text: result.privateText, unfurl_links: false, unfurl_media: false, parse: "none" })
        const latest = await readJob(ctx().store, view.jid)
        await status(view, latest?.state === "cancelled" ? "closed" : "active")
      })
    },
    linkPrompt: (trigger) => answer(trigger, "Link your own Vector account first: open Vector Everywhere settings, generate a Slack link code, then send link <code> to this bot in a direct message. Never post a code in a channel."),
    help: (trigger) => ephemeral(triggerView(trigger), "Mention Vector with a coding task, or send one in a direct message. Link your account with link <code> in a direct message; use repo owner/name to map this channel. Use status, stop or unlink. Tasks use your own mapped computer or an explicitly configured GitHub Actions runner; no one can approve tools during a run."),
    refuse: (trigger, code) => answer(trigger, renderRefusal(code, { platform: "slack", shared: trigger.shared })),
    repositoryPrompt: (trigger) => answer(trigger, "Choose the repository in Vector Everywhere settings, or use repo owner/name for a repository you can sponsor."),
    erase,
  }
  return adapter
}
