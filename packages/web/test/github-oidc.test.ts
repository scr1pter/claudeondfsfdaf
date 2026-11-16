import { afterAll, expect, test } from "bun:test"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import {
  consumeGithubOidc,
  createGithubOidcVerifier,
  githubOidcAudiences,
  githubOidcIssuer,
  githubOidcJwks,
  type GithubIdentity,
  type GithubOidcPurpose,
} from "../../../api/_lib/github-oidc"

const key = await generateKeyPair("RS256", { modulusLength: 2048 })
const jwk = { ...(await exportJWK(key.publicKey)), kid: "fixture-key", alg: "RS256", use: "sig" }
const state = { status: 200, oversized: false, redirect: false, reads: 0 }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    state.reads++
    if (state.redirect) return new Response(null, { status: 302, headers: { location: "/elsewhere" } })
    if (state.status !== 200) return new Response(null, { status: state.status })
    return state.oversized ? new Response(" ".repeat(64_001)) : Response.json({ keys: [jwk] })
  },
})
afterAll(() => server.stop(true))

function verifier() {
  return createGithubOidcVerifier((url, init) => {
    expect(url).toBe(githubOidcJwks)
    expect(init.redirect).toBe("error")
    return fetch(server.url, init)
  })
}

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: githubOidcIssuer,
    aud: githubOidcAudiences.token,
    sub: "repo:fixture-owner/project:ref:refs/heads/main",
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    jti: crypto.randomUUID(),
    repository: "fixture-owner/project",
    repository_id: "123",
    repository_owner: "fixture-owner",
    repository_owner_id: "456",
    actor: "fixture-person",
    actor_id: "789",
    run_id: "1000",
    run_attempt: "1",
    check_run_id: "1001",
    sha: "a".repeat(40),
    workflow_sha: "a".repeat(40),
    ref: "refs/heads/main",
    ref_type: "branch",
    workflow_ref: "fixture-owner/project/.github/workflows/vector.yml@refs/heads/main",
    event_name: "issue_comment",
    head_ref: "",
    base_ref: "",
    ...overrides,
  }
}

function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  return new SignJWT(claims(overrides))
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: jwk.kid, ...header })
    .sign(key.privateKey)
}

test("verifies real RSA signatures, fixed audiences, immutable IDs and both documented subject formats", async () => {
  const verify = verifier()
  const before = state.reads
  const result = await verify(await token(), "token")
  expect(result).toMatchObject({
    repository: "fixture-owner/project",
    repositoryId: "123",
    ownerId: "456",
    actorId: "789",
    runId: "1000",
    checkRunId: "1001",
  })
  expect(
    (await verify(await token({ sub: "repo:fixture-owner@456/project@123:ref:refs/heads/main" }), "token"))
      .repositoryId,
  ).toBe("123")
  expect((await verify(await token({ aud: githubOidcAudiences.installation }), "installation")).audience).toBe(
    githubOidcAudiences.installation,
  )
  expect(state.reads - before).toBe(1)
})

test.each([
  { iss: "https://attacker.invalid" },
  { aud: "https://attacker.invalid" },
  { aud: [githubOidcAudiences.token, "extra"] },
  { aud: githubOidcAudiences.installation },
  { sub: "repo:fixture-owner/other:ref:refs/heads/main" },
  { sub: "repo:fixture-owner@455/project@123:ref:refs/heads/main" },
  { repository_id: "9007199254740992" },
  { repository_owner_id: "0" },
  { actor_id: 789 },
  { jti: undefined },
  { nbf: undefined },
  { exp: undefined },
  { iat: undefined },
  { environment: "Production" },
  { job_workflow_ref: "fixture-owner/reusable/workflow.yml@main" },
  { actor: "some-bot[bot]" },
  { check_run_id: undefined },
])("rejects a correctly signed token with invalid claims: %j", async (change) => {
  await expect(verifier()(await token(change), "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
})

test.each(["pull_request", "pull_request_target", "workflow_run", "repository_dispatch", "dynamic"])(
  "rejects unsupported event %s",
  async (event) => {
    await expect(verifier()(await token({ event_name: event }), "token")).rejects.toMatchObject({
      code: "EVENT_NOT_ALLOWED",
    })
  },
)

test("rejects wrong workflow/ref/commit, old/future/expired tokens and excessive lifetime", async () => {
  const now = Math.floor(Date.now() / 1000)
  for (const change of [
    { iat: now - 301, nbf: now - 305, exp: now + 100 },
    { exp: now - 1 },
    { iat: now + 31 },
    { nbf: now + 31 },
    { exp: now + 601 },
  ])
    await expect(verifier()(await token(change), "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
  for (const change of [
    { workflow_ref: "fixture-owner/project/.github/workflows/evil.yml@refs/heads/main" },
    { workflow_sha: "b".repeat(40) },
    { head_ref: "fork" },
    { base_ref: "main" },
  ])
    await expect(verifier()(await token(change), "token")).rejects.toMatchObject({ code: "WORKFLOW_NOT_TRUSTED" })
})

test("rejects algorithm/key/header confusion, wrong signatures and oversized input", async () => {
  for (const header of [
    { jku: "https://attacker.invalid/keys" },
    { jwk },
    { x5u: "https://attacker.invalid/cert" },
    { kid: "other-key" },
    { typ: "not-jwt" },
    { critical: "extra" },
  ])
    await expect(verifier()(await token({}, header), "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
  const other = await generateKeyPair("RS256")
  const wrong = await new SignJWT(claims())
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: jwk.kid })
    .sign(other.privateKey)
  await expect(verifier()(wrong, "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
  const symmetric = await new SignJWT(claims())
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: jwk.kid })
    .sign(new Uint8Array(32))
  await expect(verifier()(symmetric, "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
  await expect(verifier()("a".repeat(16_385), "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
})

test("JWKS network/redirect/size failures fail closed without alternate issuers or keys", async () => {
  try {
    state.status = 503
    await expect(verifier()(await token(), "token")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" })
    state.status = 200
    state.redirect = true
    await expect(verifier()(await token(), "token")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" })
    state.redirect = false
    state.oversized = true
    await expect(verifier()(await token(), "token")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" })
  } finally {
    state.status = 200
    state.redirect = false
    state.oversized = false
  }
})

// V08 (spec 2.10): the mint and bind audiences, job-workflow claims, review comments and the App bot. Every case above
// is unchanged; each one below signs its claims for the audience it is verified against, unless it tests that reuse.
const mint = { aud: githubOidcAudiences.mint, runner_environment: "github-hosted" }
const bind = { aud: githubOidcAudiences.bind, event_name: "workflow_dispatch" }
const review = {
  ...mint,
  event_name: "pull_request_review_comment",
  ref: "refs/pull/12/merge",
  workflow_ref: "fixture-owner/project/.github/workflows/vector.yml@refs/pull/12/merge",
  sub: "repo:fixture-owner/project:pull_request",
  head_ref: "feature",
  base_ref: "main",
}
// One valid token's claims for each audience, and a review comment, which only the mint takes.
const presets: Array<[string, GithubOidcPurpose, Record<string, unknown>]> = [
  ["token", "token", {}],
  ["installation", "installation", { aud: githubOidcAudiences.installation }],
  ["mint", "mint", mint],
  ["bind", "bind", bind],
  ["mint review comment", "mint", review],
]

// Each case's outcome by its label, "accepted" or the error code, so a failure names the case.
async function outcomes(purpose: GithubOidcPurpose, cases: Record<string, Record<string, unknown>>) {
  const verify = verifier()
  const result: Record<string, unknown> = {}
  for (const [label, change] of Object.entries(cases))
    result[label] = await verify(await token(change), purpose).then(
      () => "accepted",
      (error: { code?: unknown }) => error.code,
    )
  return result
}

function every(cases: Record<string, unknown>, outcome: string) {
  return Object.fromEntries(Object.keys(cases).map((label) => [label, outcome]))
}

function pullRef(ref: string) {
  return { ref, workflow_ref: `fixture-owner/project/.github/workflows/vector.yml@${ref}` }
}

test("equal job-workflow claims are accepted on every audience", async () => {
  for (const [label, purpose, preset] of presets) {
    const base = claims(preset)
    const verify = verifier()
    const equal = await verify(
      await token({ ...preset, job_workflow_ref: base.workflow_ref, job_workflow_sha: base.workflow_sha }),
      purpose,
    )
    expect([label, equal.jobWorkflowRef, equal.workflowRef]).toEqual([label, base.workflow_ref, base.workflow_ref])
    expect([label, (await verify(await token(preset), purpose)).jobWorkflowRef]).toEqual([label, undefined])
    // Equal claims excuse nothing else: the workflow path and the commit are still checked.
    const evil = base.workflow_ref.replace("vector.yml", "evil.yml")
    expect(
      await outcomes(purpose, {
        "evil path": { ...preset, workflow_ref: evil, job_workflow_ref: evil, job_workflow_sha: base.workflow_sha },
        "other commit": {
          ...preset,
          workflow_sha: "b".repeat(40),
          job_workflow_ref: base.workflow_ref,
          job_workflow_sha: "b".repeat(40),
        },
      }),
    ).toEqual({ "evil path": "WORKFLOW_NOT_TRUSTED", "other commit": "WORKFLOW_NOT_TRUSTED" })
  }
})

test("unequal or lone job-workflow claims are refused on every audience", async () => {
  for (const [label, purpose, preset] of presets) {
    const base = claims(preset)
    const cases = {
      "ref alone": { ...preset, job_workflow_ref: base.workflow_ref },
      "sha alone": { ...preset, job_workflow_sha: base.workflow_sha },
      "reusable workflow": {
        ...preset,
        job_workflow_ref: "fixture-owner/reusable/.github/workflows/vector.yml@refs/heads/main",
        job_workflow_sha: base.workflow_sha,
      },
      "other sha": { ...preset, job_workflow_ref: base.workflow_ref, job_workflow_sha: "b".repeat(40) },
      "ref not a string": { ...preset, job_workflow_ref: [base.workflow_ref], job_workflow_sha: base.workflow_sha },
      "sha null": { ...preset, job_workflow_ref: base.workflow_ref, job_workflow_sha: null },
      // Refused as a claim mismatch before the workflow path is read, so the code stays OIDC_INVALID.
      "mismatch with an evil path": {
        ...preset,
        workflow_ref: base.workflow_ref.replace("vector.yml", "evil.yml"),
        job_workflow_ref: base.workflow_ref,
        job_workflow_sha: base.workflow_sha,
      },
    }
    expect([label, await outcomes(purpose, cases)]).toEqual([label, every(cases, "OIDC_INVALID")])
  }
})

test("environment is refused on every audience", async () => {
  for (const [label, purpose, preset] of presets) {
    const cases = {
      named: { ...preset, environment: "Production" },
      empty: { ...preset, environment: "" },
      "not a string": { ...preset, environment: 1 },
    }
    expect([label, await outcomes(purpose, cases)]).toEqual([label, every(cases, "OIDC_INVALID")])
  }
})

test("mint accepts a review comment, and token still refuses it", async () => {
  const verify = verifier()
  expect(await verify(await token(review), "mint")).toMatchObject({
    event: "pull_request_review_comment",
    ref: "refs/pull/12/merge",
    subject: "repo:fixture-owner/project:pull_request",
    pullRequest: 12,
    headRef: "feature",
    baseRef: "main",
    actorIsBot: false,
    audience: GithubAgents.AUDIENCE.mint,
  })
  const immutable = await verify(
    await token({ ...review, sub: "repo:fixture-owner@456/project@123:pull_request" }),
    "mint",
  )
  expect(immutable.subject).toBe("repo:fixture-owner@456/project@123:pull_request")
  expect((await verify(await token({ ...review, ref_type: undefined }), "mint")).pullRequest).toBe(12)
  const longest = await verify(await token({ ...review, ...pullRef("refs/pull/9999999999/merge") }), "mint")
  expect(longest.pullRequest).toBe(9_999_999_999)
  const branch = "b".repeat(240)
  expect(await verify(await token({ ...review, head_ref: branch, base_ref: "release/1.x" }), "mint")).toMatchObject({
    headRef: branch,
    baseRef: "release/1.x",
  })
  // The same claims signed for each other audience fail at the ref, before the event list.
  for (const purpose of ["token", "installation", "bind"] as const) {
    const signed = { [purpose]: { ...review, aud: githubOidcAudiences[purpose] } }
    expect(await outcomes(purpose, signed)).toEqual(every(signed, "OIDC_INVALID"))
  }
  const invalid = {
    "ref subject": { ...review, sub: "repo:fixture-owner/project:ref:refs/pull/12/merge" },
    "branch subject": { ...review, sub: "repo:fixture-owner/project:ref:refs/heads/main" },
    "other repository subject": { ...review, sub: "repo:fixture-owner/other:pull_request" },
    "branch ref": { ...review, ...pullRef("refs/heads/main") },
    "pull request 0": { ...review, ...pullRef("refs/pull/0/merge") },
    "leading zero": { ...review, ...pullRef("refs/pull/012/merge") },
    "11 digits": { ...review, ...pullRef("refs/pull/12345678901/merge") },
    "head ref": { ...review, ...pullRef("refs/pull/12/head") },
    "pull ref on issue_comment": {
      ...review,
      event_name: "issue_comment",
      sub: "repo:fixture-owner/project:ref:refs/pull/12/merge",
    },
    "pull ref on dispatch": {
      ...review,
      event_name: "workflow_dispatch",
      sub: "repo:fixture-owner/project:ref:refs/pull/12/merge",
    },
  }
  expect(await outcomes("mint", invalid)).toEqual(every(invalid, "OIDC_INVALID"))
  const untrusted = {
    "head_ref missing": { ...review, head_ref: undefined },
    "head_ref empty": { ...review, head_ref: "" },
    "head_ref with a space": { ...review, head_ref: "my branch" },
    "head_ref with a colon": { ...review, head_ref: "a:b" },
    "head_ref too long": { ...review, head_ref: "b".repeat(241) },
    "head_ref not a string": { ...review, head_ref: 1 },
    "base_ref missing": { ...review, base_ref: undefined },
    "base_ref empty": { ...review, base_ref: "" },
    "base_ref with a tilde": { ...review, base_ref: "main~1" },
    "ref_type tag": { ...review, ref_type: "tag" },
    "ref_type empty": { ...review, ref_type: "" },
    "workflow at the default branch": {
      ...review,
      workflow_ref: "fixture-owner/project/.github/workflows/vector.yml@refs/heads/main",
    },
    "workflow at another commit": { ...review, workflow_sha: "b".repeat(40) },
  }
  expect(await outcomes("mint", untrusted)).toEqual(every(untrusted, "WORKFLOW_NOT_TRUSTED"))
})

test("events other than review comments keep ref_type branch and no head or base ref on every audience", async () => {
  const branchEvents: Array<[string, GithubOidcPurpose, Record<string, unknown>]> = [
    ["token", "token", {}],
    ["installation", "installation", { aud: githubOidcAudiences.installation }],
    ["mint issue_comment", "mint", mint],
    ["mint workflow_dispatch", "mint", { ...mint, event_name: "workflow_dispatch" }],
    ["bind", "bind", bind],
  ]
  for (const [label, purpose, preset] of branchEvents) {
    const accepted = {
      "empty head and base": preset,
      "no head or base": { ...preset, head_ref: undefined, base_ref: undefined },
    }
    expect([label, await outcomes(purpose, accepted)]).toEqual([label, every(accepted, "accepted")])
    const untrusted = {
      "ref_type absent": { ...preset, ref_type: undefined },
      "ref_type empty": { ...preset, ref_type: "" },
      "ref_type tag": { ...preset, ref_type: "tag" },
      "a head ref": { ...preset, head_ref: "feature" },
      "a base ref": { ...preset, base_ref: "main" },
    }
    expect([label, await outcomes(purpose, untrusted)]).toEqual([label, every(untrusted, "WORKFLOW_NOT_TRUSTED")])
  }
})

test("token and installation keep their four events, and refuse a review comment at the event list", async () => {
  for (const [purpose, preset] of [
    ["token", {}],
    ["installation", { aud: githubOidcAudiences.installation }],
  ] as const) {
    const accepted = Object.fromEntries(
      ["issue_comment", "issues", "workflow_dispatch", "schedule"].map((event) => [
        event,
        { ...preset, event_name: event },
      ]),
    )
    expect([purpose, await outcomes(purpose, accepted)]).toEqual([purpose, every(accepted, "accepted")])
    // Branch claims that are otherwise valid for this audience, so only the event decides.
    const refused = { pull_request_review_comment: { ...preset, event_name: "pull_request_review_comment" } }
    expect([purpose, await outcomes(purpose, refused)]).toEqual([purpose, every(refused, "EVENT_NOT_ALLOWED")])
  }
})

test("bind accepts only workflow_dispatch", async () => {
  expect((await verifier()(await token(bind), "bind")).event).toBe("workflow_dispatch")
  const refused = Object.fromEntries(
    [
      "issue_comment",
      "issues",
      "schedule",
      "pull_request_review_comment",
      "pull_request",
      "push",
      "repository_dispatch",
    ].map((event) => [event, { ...bind, event_name: event }]),
  )
  expect(await outcomes("bind", refused)).toEqual(every(refused, "EVENT_NOT_ALLOWED"))
})

test("the App bot is accepted only on mint for workflow_dispatch", async () => {
  const dispatch = { ...mint, event_name: "workflow_dispatch" }
  const verify = verifier()
  for (const actor of ["vector-fixture[bot]", "github-actions[bot]", "0[bot]", `${"a".repeat(99)}[bot]`])
    expect(await verify(await token({ ...dispatch, actor }), "mint")).toMatchObject({ actor, actorIsBot: true })
  for (const [purpose, preset] of [
    ["mint", dispatch],
    ["mint", mint],
    ["token", {}],
    ["bind", bind],
  ] as const)
    expect(await verify(await token(preset), purpose)).toMatchObject({ actor: "fixture-person", actorIsBot: false })
  const bot = { actor: "vector-fixture[bot]" }
  const refused: Array<[string, GithubOidcPurpose, Record<string, unknown>]> = [
    ["mint issue_comment", "mint", { ...mint, ...bot }],
    ["mint issues", "mint", { ...mint, ...bot, event_name: "issues" }],
    ["mint schedule", "mint", { ...mint, ...bot, event_name: "schedule" }],
    ["mint review comment", "mint", { ...review, ...bot }],
    ["token dispatch", "token", { ...bot, event_name: "workflow_dispatch" }],
    [
      "installation dispatch",
      "installation",
      { ...bot, aud: githubOidcAudiences.installation, event_name: "workflow_dispatch" },
    ],
    ["bind dispatch", "bind", { ...bind, ...bot }],
  ]
  for (const [label, purpose, change] of refused)
    expect([label, await outcomes(purpose, { [label]: change })]).toEqual([label, { [label]: "OIDC_INVALID" }])
  const malformed = Object.fromEntries(
    [
      "Vector-Fixture[bot]",
      "[bot]",
      "-x[bot]",
      "vector_fixture[bot]",
      "vector-fixture[BOT]",
      "vector-fixture[bot] ",
      "vector-fixture[bot][bot]",
      `${"a".repeat(100)}[bot]`,
    ].map((actor) => [actor, { ...dispatch, actor }]),
  )
  expect(await outcomes("mint", malformed)).toEqual(every(malformed, "OIDC_INVALID"))
})

test("runner_environment is recorded", async () => {
  const verify = verifier()
  for (const runner of ["github-hosted", "self-hosted"]) {
    expect((await verify(await token({ ...mint, runner_environment: runner }), "mint")).runnerEnvironment).toBe(runner)
    expect((await verify(await token({ ...review, runner_environment: runner }), "mint")).runnerEnvironment).toBe(
      runner,
    )
    expect((await verify(await token({ ...bind, runner_environment: runner }), "bind")).runnerEnvironment).toBe(runner)
    expect((await verify(await token({ runner_environment: runner }), "token")).runnerEnvironment).toBe(runner)
  }
  // Only the mint requires it.
  expect((await verify(await token(), "token")).runnerEnvironment).toBeUndefined()
  expect(
    (await verify(await token({ aud: githubOidcAudiences.installation }), "installation")).runnerEnvironment,
  ).toBeUndefined()
  expect((await verify(await token(bind), "bind")).runnerEnvironment).toBeUndefined()
  const malformed = {
    uppercase: { runner_environment: "GitHub-Hosted" },
    empty: { runner_environment: "" },
    "a space": { runner_environment: "github hosted" },
    "41 characters": { runner_environment: "a".repeat(41) },
    "not a string": { runner_environment: 1 },
  }
  const onMint = { missing: { ...mint, runner_environment: undefined }, ...prefixed(mint, malformed) }
  expect(await outcomes("mint", onMint)).toEqual(every(onMint, "OIDC_INVALID"))
  const onReview = { missing: { ...review, runner_environment: undefined }, ...prefixed(review, malformed) }
  expect(await outcomes("mint", onReview)).toEqual(every(onReview, "OIDC_INVALID"))
  const onBind = prefixed(bind, malformed)
  expect(await outcomes("bind", onBind)).toEqual(every(onBind, "OIDC_INVALID"))
  expect((await verify(await token({ ...mint, runner_environment: "a".repeat(40) }), "mint")).runnerEnvironment).toBe(
    "a".repeat(40),
  )
})

test("ref_protected and repository_visibility are recorded", async () => {
  for (const [purpose, preset] of [
    ["mint", mint],
    ["bind", bind],
    ["token", {}],
    ["installation", { aud: githubOidcAudiences.installation }],
  ] as const) {
    const verify = verifier()
    const read = async (change: Record<string, unknown>) => {
      const identity = await verify(await token({ ...preset, ...change }), purpose)
      return [identity.refProtected, identity.repositoryVisibility]
    }
    expect([purpose, await read({ ref_protected: "true", repository_visibility: "public" })]).toEqual([
      purpose,
      [true, "public"],
    ])
    expect([purpose, await read({ ref_protected: "false", repository_visibility: "private" })]).toEqual([
      purpose,
      [false, "private"],
    ])
    expect([purpose, await read({ repository_visibility: "internal" })]).toEqual([purpose, [false, "internal"]])
    expect([purpose, await read({})]).toEqual([purpose, [false, undefined]])
  }
  const malformed = {
    "ref_protected true as a boolean": { ref_protected: true },
    "ref_protected TRUE": { ref_protected: "TRUE" },
    "ref_protected yes": { ref_protected: "yes" },
    "ref_protected empty": { ref_protected: "" },
    "repository_visibility secret": { repository_visibility: "secret" },
    "repository_visibility Public": { repository_visibility: "Public" },
    "repository_visibility empty": { repository_visibility: "" },
    "repository_visibility not a string": { repository_visibility: 1 },
  }
  const onMint = prefixed(mint, malformed)
  expect(await outcomes("mint", onMint)).toEqual(every(onMint, "OIDC_INVALID"))
  const onBind = prefixed(bind, malformed)
  expect(await outcomes("bind", onBind)).toEqual(every(onBind, "OIDC_INVALID"))
})

test("token and installation accept a malformed added claim as absent, as they did before V08", async () => {
  for (const [purpose, preset] of [
    ["token", {}],
    ["installation", { aud: githubOidcAudiences.installation }],
  ] as const) {
    const identity = await verifier()(
      await token({
        ...preset,
        runner_environment: "GitHub Hosted",
        ref_protected: true,
        repository_visibility: "secret",
      }),
      purpose,
    )
    expect([purpose, identity.runnerEnvironment, identity.refProtected, identity.repositoryVisibility]).toEqual([
      purpose,
      undefined,
      false,
      undefined,
    ])
  }
})

test("mint takes its five events and no others", async () => {
  const accepted = {
    ...Object.fromEntries(
      ["issue_comment", "issues", "workflow_dispatch", "schedule"].map((event) => [
        event,
        { ...mint, event_name: event },
      ]),
    ),
    pull_request_review_comment: review,
  }
  expect(await outcomes("mint", accepted)).toEqual(every(accepted, "accepted"))
  const refused = Object.fromEntries(
    ["pull_request", "pull_request_target", "workflow_run", "repository_dispatch", "push", "dynamic"].map((event) => [
      event,
      { ...mint, event_name: event },
    ]),
  )
  expect(await outcomes("mint", refused)).toEqual(every(refused, "EVENT_NOT_ALLOWED"))
})

test("audiences are separate", async () => {
  expect(githubOidcAudiences.mint).toBe(GithubAgents.AUDIENCE.mint)
  expect(githubOidcAudiences.bind).toBe(GithubAgents.AUDIENCE.bind)
  expect(new Set(Object.values(githubOidcAudiences)).size).toBe(4)
  // Claims every audience takes (a dispatch from a GitHub-hosted runner), signed for each audience in turn and
  // verified against all four: only the audience it was signed for accepts it.
  const purposes = ["token", "installation", "mint", "bind"] as const
  for (const signedFor of purposes) {
    const signed = { ...bind, aud: githubOidcAudiences[signedFor], runner_environment: "github-hosted" }
    const verify = verifier()
    const result: Record<string, unknown> = {}
    for (const purpose of purposes)
      result[purpose] = await verify(await token(signed), purpose).then(
        () => "accepted",
        (error: { code?: unknown }) => error.code,
      )
    expect([signedFor, result]).toEqual([
      signedFor,
      Object.fromEntries(purposes.map((purpose) => [purpose, purpose === signedFor ? "accepted" : "OIDC_INVALID"])),
    ])
  }
})

test("mint and bind proofs are single-use, keyed by audience", async () => {
  // An in-process store with SET NX semantics, passed as consumeGithubOidc's store argument.
  const keys = new Set<string>()
  const store = async (command: readonly (string | number)[]) => {
    expect([command[0], command[2], command[3], command[4]]).toEqual(["SET", "1", "NX", "EX"])
    const key = String(command[1])
    if (keys.has(key)) return null
    keys.add(key)
    return "OK"
  }
  const verify = verifier()
  const jti = crypto.randomUUID()
  const minted = await verify(await token({ ...mint, jti }), "mint")
  const bound = await verify(await token({ ...bind, jti }), "bind")
  const reviewed = await verify(await token({ ...review, jti }), "mint")
  const exchanged = await verify(await token({ jti }), "token")
  for (const identity of [minted, bound, exchanged]) await consumeGithubOidc(identity, store)
  // One key per audience and jti: a review comment's mint proof with the same jti is the same proof.
  expect(keys.size).toBe(3)
  for (const identity of [minted, bound, reviewed, exchanged])
    await expect(consumeGithubOidc(identity, store)).rejects.toMatchObject({ statusCode: 409, code: "OIDC_REPLAYED" })
  expect(keys.size).toBe(3)
})

// Spec 2.10's identity, field for field. bun test does not check types; packages/web's typecheck checks this file.
test("the identity has 2.10's shape", () => {
  type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
  type Section210 = {
    repository: string
    repositoryId: string
    owner: string
    ownerId: string
    actor: string
    actorIsBot: boolean
    actorId: string
    runId: string
    runAttempt: string
    checkRunId: string
    sha: string
    workflowSha: string
    ref: string
    workflowRef: string
    jobWorkflowRef: string | undefined
    event: string
    subject: string
    jti: string
    expiresAt: number
    audience: (typeof githubOidcAudiences)[GithubOidcPurpose]
    runnerEnvironment: string | undefined
    refProtected: boolean
    repositoryVisibility: "public" | "private" | "internal" | undefined
    pullRequest: number | undefined
    headRef: string | undefined
    baseRef: string | undefined
  }
  const shape: Equal<GithubIdentity, Section210> = true
  expect(shape).toBe(true)
})

function prefixed(preset: Record<string, unknown>, cases: Record<string, Record<string, unknown>>) {
  return Object.fromEntries(Object.entries(cases).map(([label, change]) => [label, { ...preset, ...change }]))
}
