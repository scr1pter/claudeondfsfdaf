export * as HostedFollow from "./follow"

import { createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { HostedResult } from "@vectordevai/core/hosted-result"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionMemory } from "@/session/memory"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { TaskNotify } from "@/task/notify"
import type { TaskPromptOps } from "@/tool/task"

export class Refused extends Schema.TaggedErrorClass<Refused>()("HostedFollow.Refused", { message: Schema.String }) {}
type Link = { id: string; parentID: string; fingerprint: string; title?: string; createdAt: number; delivered?: boolean }
export type View = { id: string; title?: string; delivered: boolean }
export interface Interface {
  readonly attach: (parentID: SessionID, id: string, ops: TaskPromptOps) => Effect.Effect<View, Refused>
  readonly resume: (parentID: SessionID, ops: TaskPromptOps) => Effect.Effect<View[], Refused>
}
export class Service extends Context.Service<Service, Interface>()("@vector/HostedFollow") {}
const key = (parentID: string, id: string) => ["hosted-link", parentID, id]
const fingerprint = (token: string) => createHash("sha256").update(`hosted-follow-v1\u0000${token}`).digest("hex")

/** Only local owner API handlers call this service. Associations never leave this engine. */
export function make(input: {
  auth: Pick<Auth.Interface, "get">
  sessions: Session.Interface
  storage: Storage.Interface
  jobs: BackgroundJob.Interface
  notes: TaskNotify.Interface
  request?: (url: string, init: RequestInit) => Promise<Response>
  pollMs?: number
  environment?: () => string | undefined
}): Interface {
  const account = Effect.fn("HostedFollow.account")(function* () {
    const stored = yield* input.auth.get("vector").pipe(Effect.orElseSucceed(() => undefined))
    const token = yield* Effect.tryPromise({
      try: () => VectorAccount.resolveVectorToken({ environment: input.environment ? input.environment() : process.env.VECTOR_CLI_TOKEN,
        stored: async () => stored?.type === "api" ? stored.key : undefined }),
      catch: () => new Refused({ message: "Sign in to Vector to reconnect your hosted job." }),
    })
    if (!token) return yield* new Refused({ message: "Sign in to Vector to reconnect your hosted job." })
    return { token, fingerprint: fingerprint(token) }
  })
  const parent = Effect.fn("HostedFollow.parent")(function* (parentID: SessionID) {
    if (SessionMemory.agentStarted()) return yield* new Refused({ message: "Link a hosted job from your own desktop conversation." })
    const session = yield* input.sessions.get(parentID).pipe(Effect.mapError(() => new Refused({ message: "This conversation is unavailable." })))
    if (session.parentID || session.internal) return yield* new Refused({ message: "Return a hosted job to its original main conversation." })
    return session
  })
  const read = Effect.fn("HostedFollow.read")(function* (id: string, identity: { token: string }) {
    return yield* Effect.tryPromise({
      try: async () => {
        const response = await (input.request ?? ((url, init) => Egress.fetch("cloud-computer", url, init)))(
          `${ModelPlanStatus.SITE}/api/hosted/jobs/${id}`, {
            headers: { Authorization: `Bearer ${identity.token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
          })
        if (!response.ok) throw new Error("Hosted job is unavailable for the signed-in account.")
        const length = Number(response.headers.get("content-length"))
        if (length > 128 * 1024) throw new Error("Hosted job response is too large.")
        // This is an owner read, never a browser-supplied report or a model's claim that a job completed.
        if (!response.body) throw new Error("Hosted job response is empty.")
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > 128 * 1024) throw new Error("Hosted job response is too large.")
            chunks.push(next.value)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
        const view = HostedResult.decode(JSON.parse(Buffer.concat(chunks).toString("utf8")), id)
        if (!view) throw new Error("Hosted job returned an invalid report.")
        return view
      }, catch: () => new Refused({ message: "Vector could not read this account's hosted job. Reconnect it from Cloud computer → Jobs." }),
    })
  })
  const start = Effect.fn("HostedFollow.start")(function* (link: Link, ops: TaskPromptOps) {
    if (link.delivered) return
    const parentID = SessionID.make(link.parentID)
    const session = yield* parent(parentID)
    yield* input.jobs.start({
      id: `hosted:${parentID}:${link.id}`, type: "hosted", title: link.title ? `Hosted: ${link.title}` : "Hosted job",
      metadata: { parentSessionId: parentID, background: true, hostedID: link.id },
      durable: { parentSessionID: parentID, directory: session.directory, metadata: { hostedID: link.id } },
      run: Effect.gen(function* () {
        while (true) {
          const identity = yield* account()
          if (identity.fingerprint !== link.fingerprint)
            return yield* new Refused({ message: "The Vector sign-in changed. Reconnect this job from your original conversation." })
          const view = yield* read(link.id, identity).pipe(Effect.option)
          if (view._tag === "Some" && HostedResult.final(view.value)) {
            const current = yield* parent(parentID)
            if (current.revert) {
              yield* Effect.sleep(input.pollMs ?? 60_000)
              continue
            }
            const receipt = HostedResult.receipt(parentID, view.value)
            const text = HostedResult.note(view.value)
            yield* input.notes.post({ parentID, agent: "build", ops, notes: [{
              kind: "hosted", hostedID: link.id, state: view.value.state, text, wake: false, hold: "subagent",
              receipt: { messageID: MessageID.make(receipt.messageID), partID: PartID.make(receipt.partID) },
            }] })
            // post() may have held the note for a revert, or logged a write failure. The actual stable part is the
            // receipt: a row is complete only after that part exists, never merely because delivery was attempted.
            const written = yield* input.sessions.getPart({ sessionID: parentID,
              messageID: MessageID.make(receipt.messageID), partID: PartID.make(receipt.partID) })
            if (written?.type === "text" && written.text === text) {
              yield* input.storage.write(key(parentID, link.id), { ...link, delivered: true }).pipe(Effect.orDie)
              return `Hosted job ${link.id}: ${view.value.state}. Its report was returned to the originating conversation.`
            }
          }
          yield* Effect.sleep(input.pollMs ?? 60_000)
        }
      }),
      // Interrupting this local reader never cancels, approves, retries, or otherwise writes to the paid remote job.
    })
  })
  const shown = (link: Link): View => ({ id: link.id, ...(link.title ? { title: link.title } : {}), delivered: link.delivered === true })
  return {
    attach: Effect.fn("HostedFollow.attach")(function* (parentID, id, ops) {
      yield* parent(parentID)
      if (!HostedResult.JOB.test(id)) return yield* new Refused({ message: "Choose a valid hosted job." })
      const identity = yield* account()
      const view = yield* read(id, identity)
      const keys = yield* input.storage.list(["hosted-link", parentID]).pipe(Effect.orDie)
      if (keys.length >= 100 && !keys.some((item) => item[2] === id))
        return yield* new Refused({ message: "This conversation already has 100 linked hosted jobs." })
      const previous = yield* input.storage.read<Link>(key(parentID, id)).pipe(Effect.orElseSucceed(() => undefined))
      const link: Link = { id, parentID, fingerprint: identity.fingerprint, createdAt: view.createdAt,
        ...(view.title ? { title: view.title } : {}), ...(previous?.delivered ? { delivered: true } : {}) }
      yield* input.storage.write(key(parentID, id), link).pipe(Effect.orDie)
      if (previous && previous.fingerprint !== link.fingerprint)
        yield* input.jobs.cancel(`hosted:${parentID}:${id}`)
      yield* start(link, ops)
      return shown(link)
    }),
    resume: Effect.fn("HostedFollow.resume")(function* (parentID, ops) {
      yield* parent(parentID)
      const identity = yield* account()
      const keys = (yield* input.storage.list(["hosted-link", parentID]).pipe(Effect.orDie)).slice(0, 100)
      const links: Link[] = []
      for (const path of keys) {
        const link = yield* input.storage.read<Link>(path).pipe(Effect.orElseSucceed(() => undefined))
        if (!link || link.parentID !== parentID || !HostedResult.JOB.test(link.id) || link.fingerprint !== identity.fingerprint) continue
        links.push(link)
        yield* start(link, ops)
      }
      return links.map(shown)
    }),
  }
}

const layer = Layer.effect(Service, Effect.gen(function* () {
  return make({ auth: yield* Auth.Service, sessions: yield* Session.Service, storage: yield* Storage.Service,
    jobs: yield* BackgroundJob.Service, notes: yield* TaskNotify.Service })
}))
export const node = LayerNode.make({ service: Service, layer,
  deps: [Auth.node, Session.node, Storage.node, BackgroundJob.node, TaskNotify.node] })
