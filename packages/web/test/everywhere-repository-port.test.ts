import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { drainAfter } from "../../../api/_lib/everywhere/after"
import { createRepositoryPort } from "../../../api/_lib/everywhere/adapters/cloud-agents"
import { ENV_NAMES, readConfig } from "../../../api/_lib/everywhere/config"
import { findMapping, setMapping } from "../../../api/_lib/everywhere/identity"
import { readJob, recordSeen } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { productionPorts } from "../../../api/_lib/everywhere/runtime"
import { createSlackRoutes } from "../../../api/_lib/everywhere/slack/routes"
import { setJson } from "../../../api/_lib/everywhere/store"
import { githubAppFixture } from "./github-app-fixture"
import { RouteHarness, everywhereEnv } from "./lib/everywhere-account"
import { BINDING_KEY, bindingFields, type Command } from "./lib/everywhere-cloud-agents"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeSlack, slackFixture } from "./lib/everywhere-slack"

installFetchGuard()
const harness = new RouteHarness()
const slack = new FakeSlack()
beforeAll(async () => {
  await harness.start()
  slack.start()
})
afterAll(async () => {
  await drainAfter()
  slack.stop()
  await harness.stop()
})

const fullName = "fixture-owner/project"
const accountBindings = "vector:cloud-agents:bindings:"

function fixtureBindings(repositoryId: string, account: string) {
  const state = { repository: bindingFields({ repositoryId, account }) }
  const commands: Command[] = []
  const store = async (command: Command) => {
    commands.push(command)
    expect(command[0]).toBe("EVAL")
    expect(command[2]).toBe("1")
    const key = String(command[3])
    if (key.startsWith(accountBindings)) return [repositoryId]
    expect(key.startsWith(BINDING_KEY)).toBe(true)
    return [key === BINDING_KEY + repositoryId ? Object.entries(state.repository).flat() : []]
  }
  return { state, store, commands }
}

test("production exposes repository verification only when Vector everywhere is enabled", () => {
  const env = everywhereEnv()
  expect(productionPorts(readConfig({ ...env, [ENV_NAMES.enabled]: "false" })).repository).toBeUndefined()
  expect(typeof productionPorts(readConfig(env)).repository).toBe("function")
})

test("live App metadata verifies canonical name and treats public and internal repositories as shared", async () => {
  await using fixture = await githubAppFixture()
  const account = randomUUID()
  const id = Number(fixture.repositoryId)
  const binding = fixtureBindings(fixture.repositoryId, account)
  const lookup = createRepositoryPort({ store: binding.store, app: fixture.app })
  const requested = { account, id, fullName: fullName.toUpperCase() }
  for (const [visibility, privateRepository, shared] of [
    ["public", false, true],
    ["private", true, false],
    ["internal", true, true],
  ] as const) {
    fixture.state.repository.private = privateRepository
    fixture.state.repository.visibility = visibility
    expect(await lookup(requested)).toEqual({ id, fullName, shared })
  }

  fixture.state.repository.visibility = undefined
  expect(await lookup(requested)).toBeUndefined()
  fixture.state.repository.visibility = "public"
  expect(await lookup(requested)).toBeUndefined()
  expect(fixture.state.minted).toHaveLength(5)
  for (const mint of fixture.state.minted) {
    expect(mint.body.permissions).toEqual({ metadata: "read" })
    expect(mint.body.repository_ids).toEqual([id])
  }
  expect(fixture.tokens.size).toBe(0)
})

test("a foreign requester or mismatched mapping cannot cause any GitHub App call", async () => {
  await using fixture = await githubAppFixture()
  const account = randomUUID()
  const stranger = randomUUID()
  const binding = fixtureBindings(fixture.repositoryId, account)
  const lookup = createRepositoryPort({ store: binding.store, app: fixture.app })
  const id = Number(fixture.repositoryId)
  for (const request of [
    { account: stranger, id, fullName },
    { account: stranger, fullName },
    { account, id: id + 1, fullName },
    { account, id, fullName: "fixture-owner/unmapped" },
    { account, fullName: "fixture-owner/unmapped" },
  ]) {
    expect(await lookup(request)).toBeUndefined()
  }
  binding.state.repository.suspended = "binder-left"
  expect(await lookup({ account, id, fullName })).toBeUndefined()
  expect(fixture.state.requests).toEqual([])
  expect(fixture.state.minted).toEqual([])
})

test("a canonical rename or superseded binding refuses a stale mapped repository", async () => {
  await using fixture = await githubAppFixture()
  const account = randomUUID()
  const id = Number(fixture.repositoryId)
  const binding = fixtureBindings(fixture.repositoryId, account)
  const requested = { account, id, fullName }
  fixture.state.repository.private = true
  fixture.state.repository.visibility = "private"

  const lookup = createRepositoryPort({ store: binding.store, app: fixture.app })
  fixture.state.repository.full_name = "fixture-owner/renamed"
  expect(await lookup(requested)).toBeUndefined()
  fixture.state.repository.full_name = fullName
  expect(await lookup(requested)).toEqual({ id, fullName, shared: false })

  const racingLookup = createRepositoryPort({
    store: binding.store,
    app: {
      attachmentRepository: async (repo, options) => {
        const proof = await fixture.app.attachmentRepository(repo, options)
        binding.state.repository.generation = "2"
        return proof
      },
    },
  })
  expect(await racingLookup(requested)).toBeUndefined()
  expect(fixture.tokens.size).toBe(0)
})

test("signed Slack mapping and intake use the same verified repository and preserve the admission gates", async () => {
  await using fixture = await githubAppFixture()
  fixture.state.repository.private = true
  fixture.state.repository.visibility = "private"
  const f = await slackFixture()
  const binding = fixtureBindings(fixture.repositoryId, f.account)
  const id = Number(fixture.repositoryId)
  f.ports.repository = createRepositoryPort({ store: binding.store, app: fixture.app })
  f.ports.presence = async () => ({ online: false, computers: 0 })
  const link = (account: string) =>
    setJson(f.store, everywhereKeys.link(f.installation, "U0ALICE01"), { account, linkedAt: f.fake.clock.now })
  await link(f.account)
  await recordSeen(f.context(), f.account, f.computer)
  const routes = createSlackRoutes({ config: () => f.config, context: f.context, ports: f.ports, fetcher: slack.fetch })
  harness.mount({ "/events": routes.events })
  const send = async (text: string) => {
    const body = f.envelope(`<@U0BOT0001> ${text}`)
    expect((await harness.call("POST", "/events", { body, headers: f.sign(JSON.stringify(body)) })).status).toBe(200)
    await drainAfter()
  }

  const perk = f.ports.perk
  const gateReads: string[] = []
  f.ports.perk = async (account, name) => {
    gateReads.push(name)
    return perk(account, name)
  }
  await send("Tell me how to map a repository")
  expect(gateReads).toEqual(["everywhere", "remote"])
  expect(binding.commands).toEqual([])
  f.ports.perk = perk

  await send(`repo ${fullName.toUpperCase()}`)
  expect(await findMapping(f.store, f.installation, "C123")).toMatchObject({
    setBy: f.account,
    repositories: [{ id, fullName }],
  })
  await send("Repair only the login button")
  const jobs = f.fake.sorted(everywhereKeys.jobs(f.account))
  expect(jobs).toHaveLength(1)
  expect(await readJob(f.store, jobs[0]!)).toMatchObject({
    sponsor: f.account,
    state: "waiting",
    repository: { id, fullName, shared: false },
  })
  expect(fixture.state.minted).toHaveLength(2)

  const other = randomUUID()
  await link(other)
  const beforeControl = binding.commands.length
  await send(`repo ${fullName}`)
  expect(binding.commands).toHaveLength(beforeControl)
  await send("Do not admit another account's repository")
  expect(f.fake.sorted(everywhereKeys.jobs(other))).toEqual([])

  await link(f.account)
  f.ports.switch = async (name) => name === "everywhere" ? "no-new" : "on"
  const beforePause = binding.commands.length
  await send("Do not resolve during no-new")
  expect(binding.commands).toHaveLength(beforePause)
  f.ports.switch = async () => "on"
  const lookup = f.ports.repository
  const pauseAfterLookup: typeof lookup = async (input) => {
    const resolved = await lookup(input)
    f.ports.switch = async (name) => name === "everywhere" ? "no-new" : "on"
    return resolved
  }
  f.ports.repository = pauseAfterLookup
  await send("Do not admit after the switch changed")
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual(jobs)
  expect(fixture.state.minted).toHaveLength(3)
  f.ports.switch = async () => "on"
  f.ports.repository = lookup
  const maybeMapped = await setMapping(f.context(), {
    account: f.account,
    installation: f.installation,
    place: "C123",
    repositories: [{ id: id + 1, fullName }],
  })
  expect(maybeMapped.ok).toBe(true)
  await send("Do not admit a stale mapping")
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual(jobs)
  f.ports.repository = pauseAfterLookup
  const beforeRefusal = slack.calls.length
  await send("Do not ask for a repository after intake was paused")
  const replies = slack.calls.slice(beforeRefusal).filter((call) => call.method === "chat.postEphemeral")
  expect(replies.map((call) => call.body.text)).toEqual(["Vector is paused here."])
  expect(fixture.state.minted).toHaveLength(3)
  expect(fixture.tokens.size).toBe(0)
})
