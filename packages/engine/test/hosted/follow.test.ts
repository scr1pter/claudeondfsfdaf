import { afterEach, describe, expect } from "bun:test"
import { Effect, Result } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BackgroundJob } from "@/background/job"
import { HostedFollow } from "@/hosted/follow"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { TaskNotify } from "@/task/notify"
import { MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import type { TaskPromptOps } from "@/tool/task"
import type { SessionPrompt } from "@/session/prompt"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(disposeAllInstances)
const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, Storage.node, BackgroundJob.node, TaskNotify.node])))
const id = `jb_${"a".repeat(26)}`
const model = { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") }

describe("same-conversation hosted result", () => {
  it.instance("a restarted local reader returns one quiet report, without writing to the remote job", () => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const jobs = yield* BackgroundJob.Service
    const storage = yield* Storage.Service
    const notes = yield* TaskNotify.Service
    const parent = yield* sessions.create({ title: "Original conversation" })
    const prompts: SessionPrompt.PromptInput[] = []
    const ops: TaskPromptOps = {
      cancel: () => Effect.void,
      resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
      prompt: (input) => Effect.gen(function* () {
        prompts.push(input)
        const info = yield* sessions.updateMessage({ id: input.messageID ?? MessageID.ascending(),
          sessionID: input.sessionID, role: "user", agent: "build", model: input.model ?? model,
          time: { created: Date.now() } })
        const parts = []
        for (const part of input.parts) if (part.type === "text") parts.push(yield* sessions.updatePart({ ...part,
          id: part.id ?? PartID.ascending(), messageID: info.id, sessionID: input.sessionID }))
        return { info, parts }
      }),
    }
    let done = false
    let token = "vct_fixture"
    const calls: { url: string; method?: string; body: unknown }[] = []
    const client = HostedFollow.make({ sessions, jobs, storage, notes, environment: () => undefined, pollMs: 20,
      auth: { get: () => Effect.succeed({ type: "api" as const, key: token }) },
      request: async (url, init) => {
        calls.push({ url, method: init.method, body: init.body })
        return Response.json({ job: { id, state: done ? "reported" : "running", createdAt: Date.now() - 1000,
          ...(done ? { endedAt: 1790000600000, report: { summary: "Proposed a fix; review its pull request.", links: [] } } : {}),
        } })
      },
    })
    yield* client.attach(parent.id, id, ops)
    yield* pollWithTimeout(Effect.sync(() => calls.length > 1 ? true : undefined), "Hosted reader did not start")
    const jobID = `hosted:${parent.id}:${id}`
    // Explicit reattachment under a rotated account token restarts the local reader instead of leaving the old
    // token-fenced reader in place until the next app navigation. The server still authorizes the real job first.
    token = "vct_rotated_fixture"
    yield* client.attach(parent.id, id, ops)
    expect((yield* jobs.get(jobID))?.status).toBe("running")
    yield* jobs.cancel(jobID)
    expect(prompts).toHaveLength(0)
    done = true
    yield* client.resume(parent.id, ops)
    const ended = yield* jobs.wait({ id: jobID, timeout: 3000 })
    expect(ended.timedOut).toBe(false)
    expect(ended.info?.status).toBe("completed")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.sessionID).toBe(parent.id)
    expect(prompts[0]?.noReply).toBe(true)
    expect(yield* client.resume(parent.id, ops)).toMatchObject([{ id, delivered: true }])
    expect(prompts).toHaveLength(1)
    expect(calls.every((call) => call.url.endsWith(`/api/hosted/jobs/${id}`) && !call.url.includes(parent.id) && !call.body && (!call.method || call.method === "GET"))).toBe(true)
  }))

  it.instance("a child conversation is refused before any account or network read", () => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const parent = yield* sessions.create()
    const child = yield* sessions.create({ parentID: parent.id })
    let requests = 0
    const client = HostedFollow.make({ sessions, jobs: yield* BackgroundJob.Service, storage: yield* Storage.Service,
      notes: yield* TaskNotify.Service, environment: () => undefined,
      auth: { get: () => Effect.die("must not read account") },
      request: async () => { requests++; return Response.json({}) },
    })
    const ops: TaskPromptOps = { cancel: () => Effect.void, resolvePromptParts: () => Effect.succeed([]), prompt: () => Effect.die("must not prompt") }
    const result = yield* client.attach(child.id, id, ops).pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    expect(requests).toBe(0)
  }))
})
