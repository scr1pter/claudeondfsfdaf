import { afterAll, beforeAll, expect, test } from "bun:test"
import { createFitVerifier, FIT_ISSUER } from "../../../api/_lib/everywhere/jira/fit"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { NativeJira } from "./lib/everywhere-jira"

installFetchGuard()
const native = new NativeJira()
beforeAll(() => native.start())
afterAll(() => native.stop())

test("FIT verifies the actual native signature, exact audience/app and commercial cloud/install before returning identity", async () => {
  native.reset()
  const verify = createFitVerifier({ appId: () => native.app, fetcher: native.fetch, now: () => native.now })
  expect(await verify(await native.sign())).toMatchObject({ cloudId: native.cloud, installationId: native.forgeInstallation, principal: native.user, moduleKey: "vector-a2a" })
  await verify(await native.sign())
  expect(native.calls.filter((call) => call.operation === "jwks")).toHaveLength(1)
  expect(native.calls.every((call) => call.authorization === null)).toBe(true)
})
test("wrong signature, expiry, issuer, audience, app, cloud/base and unsupported isolated claims refuse", async () => {
  native.reset()
  const verify = createFitVerifier({ appId: () => native.app, fetcher: native.fetch, now: () => native.now })
  const seconds = Math.floor(native.now / 1000)
  const app = { id: native.app, installationId: native.forgeInstallation, apiBaseUrl: `https://api.atlassian.com/ex/jira/${native.cloud}`, module: { key: "vector-a2a" } }
  for (const patch of [{ iss: "another-issuer" }, { aud: "another-app" }, { exp: seconds - 1 }, { nbf: seconds + 60 },
    { iat: seconds - 1000, nbf: seconds - 1000 }, { app: { ...app, id: "another-app" } }, { app: { ...app, installationId: "invalid" } },
    { context: { cloudId: "invalid" } }, { app: { ...app, apiBaseUrl: "https://untrusted.invalid/ex/jira/site" } }, { icLabel: "commercial-isolated" }])
    await expect(verify(await native.sign(patch))).rejects.toMatchObject({ code: "JIRA_INVOCATION_INVALID" })
  await expect(verify(await native.sign({}, 1, { kid: native.keys[0]!.kid }))).rejects.toMatchObject({ code: "JIRA_INVOCATION_INVALID" })
  expect(native.calls.every((call) => call.operation === "jwks")).toBe(true)
})
test("unknown key refresh is bounded, recovers real rotation, and the cached set expires after one hour", async () => {
  native.reset()
  const verify = createFitVerifier({ appId: () => native.app, fetcher: native.fetch, now: () => native.now })
  await verify(await native.sign())
  native.activeKey = 1
  await verify(await native.sign())
  expect(native.calls).toHaveLength(2)
  await expect(verify(await native.sign({}, 1, { kid: "unknown-other-key" }))).rejects.toMatchObject({ code: "JIRA_INVOCATION_INVALID" })
  expect(native.calls).toHaveLength(2)
  native.now += 3_600_001
  await verify(await native.sign())
  expect(native.calls).toHaveLength(3)
})
test("a valid system invocation has no inferred requester, and a nonconfigured app never fetches keys", async () => {
  native.reset()
  const verify = createFitVerifier({ appId: () => native.app, fetcher: native.fetch, now: () => native.now })
  expect((await verify(await native.sign({ principal: undefined }))).principal).toBeUndefined()
  native.calls = []
  await expect(createFitVerifier({ appId: () => undefined, fetcher: native.fetch })(await native.sign({ iss: FIT_ISSUER }))).rejects.toMatchObject({ code: "JIRA_INVOCATION_INVALID" })
  expect(native.calls).toHaveLength(0)
})
