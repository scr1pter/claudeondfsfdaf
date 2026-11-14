import { expect, test } from "bun:test"
import { JIRA_SCOPES } from "../../../api/_lib/everywhere/jira/client"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()
test("the manifest is source-only native A2A with exact read scopes, endpoint references and indexed uninstall cleanup", async () => {
  const root = new URL("../../../integrations/jira-forge/", import.meta.url)
  const value = Bun.YAML.parse(await Bun.file(new URL("manifest.yml", root)).text()) as {
    app: { id: string }; modules: { "rovo:agentConnector": { name: string; icon: string; productContexts: string[]; protocols: { agent2Agent: { version: string; jsonRpcTransport: { endpoint: string; streaming: boolean } } } }[];
      endpoint: { key: string; remote: string; route: { path: string } }[]; preUninstall: { key: string; endpoint: string }[]; function?: unknown };
    remotes: { key: string; baseUrl: string; auth: { appUserToken: { enabled: boolean }; appSystemToken: { enabled: boolean } }; storage: { inScopeEUD: boolean } }[];
    permissions: { scopes: string[] };
  }
  const agent = value.modules["rovo:agentConnector"][0]!
  expect(agent.name).toBe("Vector")
  expect(agent.name.length).toBeLessThanOrEqual(30)
  expect(agent.productContexts).toEqual(["jira"])
  expect(agent.protocols.agent2Agent).toEqual({ version: "1.0", jsonRpcTransport: { endpoint: "vector-a2a", streaming: false } })
  expect(value.modules.endpoint).toEqual([{ key: "vector-a2a", remote: "vector-backend", route: { path: "/a2a" } }, { key: "vector-uninstall", remote: "vector-backend", route: { path: "/uninstall" } }])
  expect(value.modules.preUninstall).toEqual([{ key: "vector-pre-uninstall", endpoint: "vector-uninstall" }])
  expect(value.remotes[0]?.baseUrl).toBe("https://vectordev.ai/api/jira")
  expect(value.remotes[0]?.auth).toEqual({ appUserToken: { enabled: true }, appSystemToken: { enabled: true } })
  expect(value.remotes[0]?.storage.inScopeEUD).toBe(true)
  expect(value.permissions.scopes).toEqual([...JIRA_SCOPES])
  expect(value.permissions.scopes.some((scope) => /write|email|admin/i.test(scope))).toBe(false)
  expect(value.modules.function).toBeUndefined()
  expect(await Bun.file(new URL("package.json", root)).exists()).toBe(false)
  expect(await Bun.file(new URL("assets/vector.svg", root)).exists()).toBe(true)
  expect(value.app.id).toBe("ari:cloud:ecosystem::app/00000000-0000-0000-0000-000000000000")
})
