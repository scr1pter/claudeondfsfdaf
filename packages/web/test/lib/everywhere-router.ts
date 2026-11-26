import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto"
import { readConfig } from "../../../../api/_lib/everywhere/config"
import { createJob, type JobRecord, type JobsContext } from "../../../../api/_lib/everywhere/jobs"
import type { ParsedTrigger, PlatformAdapter } from "../../../../api/_lib/everywhere/platform"
import type { Ports } from "../../../../api/_lib/everywhere/ports"
import { routeFacts, type Routing } from "../../../../api/_lib/everywhere/router"
import type { Store } from "../../../../api/_lib/everywhere/store"
import type { InboundTrigger } from "../../../../packages/schema/src/everywhere"
import { seedJobAuthority } from "./everywhere-job-authority"
import { everywhereEnv } from "./everywhere-account"
import { FakeStore, testAccountAuthority, withTestAccountAuthority } from "./everywhere-store"

/**
 * `store` replaces the FakeStore (a real Redis, EV-19), and `fake` is then only the clock. `env` is what `config` was
 * read from, for routes that read their own configuration (the jobs routes).
 */
export function routerFixture(options: { readonly store?: Store } = {}) {
  const fake = new FakeStore()
  const store: Store = options.store ?? withTestAccountAuthority(async (command) => fake.send(command))
  const env = everywhereEnv()
  const config = readConfig(env)
  const account = randomUUID()
  const computer = randomBytes(16).toString("base64url")
  const offer = { kid: "test-offer-key", key: generateKeyPairSync("ed25519").privateKey }
  const context = (): JobsContext => ({ store, keys: config.dataKeys, now: fake.clock.now, offer, accountAuthority: testAccountAuthority })
  const trigger: InboundTrigger = {
    platform: "slack", installation: "slack:T0123ABCD", deliveryId: randomUUID(),
    actor: { userId: "U0ALICE01", bot: false, guest: false, external: false }, kind: "mention",
    thread: { ref: "C123:1731335400.000100" }, task: "Fix the login button", context: [], shared: false,
  }
  const parsed: ParsedTrigger = { trigger, place: "C123", reply: { ref: trigger.thread.ref, channel: "C123", thread: "1731335400.000100" } }
  const calls: { kind: string; value?: unknown }[] = []
  const adapter: PlatformAdapter = {
    id: "slack", ackMs: 2_500, verify: async () => ({ ok: true, body: {} }), parse: () => parsed,
    acknowledge: async () => { calls.push({ kind: "ack" }) },
    progress: async (_, value) => { calls.push({ kind: "progress", value }) },
    finish: async (_, value) => { calls.push({ kind: "finish", value }) },
    linkPrompt: async () => { calls.push({ kind: "link" }) },
    help: async () => { calls.push({ kind: "help" }) },
    refuse: async (_, value) => { calls.push({ kind: "refuse", value }) },
    repositoryPrompt: async () => { calls.push({ kind: "repository" }) },
    erase: async () => undefined,
  }
  const ports: { -readonly [K in keyof Ports]: Ports[K] } = {
    accountAuthority: testAccountAuthority,
    presence: async () => ({ online: true, computers: 1 }),
    offer: async () => { calls.push({ kind: "offer" }); return "sent" },
    binding: async () => undefined, perk: async () => true, switch: async () => "on",
    repository: async ({ fullName }) => ({ id: 101, fullName, shared: false }),
  }
  const routing: Routing = {
    context, adapter, ports, now: () => fake.clock.now,
    sleep: async (ms) => { fake.clock.advance(ms) },
    view: (job) => ({ jid: job.jid, platform: job.platform, installation: job.installation, shared: job.shared, reply: parsed.reply, job }),
  }
  const facts = () => routeFacts({
    ctx: context(), ports, trigger, sponsor: account, repository: { id: 101, fullName: "acme/app" },
    counts: { sponsorToday: 0, sponsorLive: 0, requesterHour: 0, installationToday: 0 }, receivedAt: fake.clock.now,
  })
  const create = async (): Promise<JobRecord> => {
    await seedJobAuthority(context(), { platform: trigger.platform, installation: trigger.installation, sponsor: account, requester: { userId: trigger.actor.userId, account } })
    const created = await createJob(context(), {
      platform: trigger.platform, installation: trigger.installation, kind: "mention",
      requester: { userId: trigger.actor.userId, account }, sponsor: account,
      repository: { id: 101, fullName: "acme/app", shared: false }, shared: trigger.shared,
      task: trigger.task, context: [], reply: parsed.reply,
    })
    if (!created.ok) throw new Error("Fixture job was refused")
    return created.job
  }
  return { fake, store, env, config, context, account, computer, trigger, parsed, calls, adapter, ports, routing, facts, create }
}
