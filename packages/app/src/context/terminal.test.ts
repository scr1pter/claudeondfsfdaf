import { beforeAll, describe, expect, mock, test } from "bun:test"
import { ServerScope } from "@/utils/server-scope"

let getWorkspaceTerminalCacheKey: typeof import("./terminal").getWorkspaceTerminalCacheKey
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let migrateTerminalState: (value: unknown) => unknown

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  mock.module("@vectordevai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const mod = await import("./terminal")
  getWorkspaceTerminalCacheKey = mod.getWorkspaceTerminalCacheKey
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  migrateTerminalState = mod.migrateTerminalState
})

describe("getWorkspaceTerminalCacheKey", () => {
  test("uses workspace-only directory cache key", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo"))).toBe("local\u0000/repo\u0000__workspace__")
  })

  test("can include a server scope", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo", "ssh:debian" as ServerScope))).toBe(
      "ssh:debian\u0000/repo\u0000__workspace__",
    )
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("includes legacy session path before workspace path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual([
      "/repo/terminal/session-123.v1",
      "/repo/terminal.v1",
    ])
  })
})

describe("migrateTerminalState", () => {
  test("drops invalid terminals and restores a valid active terminal", () => {
    expect(
      migrateTerminalState({
        active: "missing",
        all: [
          null,
          { id: "one", title: "Terminal 2" },
          { id: "one", title: "duplicate", titleNumber: 9 },
          { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
          { title: "no-id" },
        ],
      }),
    ).toEqual({
      active: "one",
      all: [
        { id: "one", title: "Terminal 2", titleNumber: 2 },
        { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
      ],
    })
  })

  test("keeps a valid active id", () => {
    expect(
      migrateTerminalState({
        active: "two",
        all: [
          { id: "one", title: "Terminal 1" },
          { id: "two", title: "shell", titleNumber: 7 },
        ],
      }),
    ).toEqual({
      active: "two",
      all: [
        { id: "one", title: "Terminal 1", titleNumber: 1 },
        { id: "two", title: "shell", titleNumber: 7 },
      ],
    })
  })

  test("keeps an agent terminal's session, its finished process's exit code and a PTY gone without one", () => {
    expect(
      migrateTerminalState({
        active: "one",
        all: [
          { id: "one", title: "dev server", titleNumber: 1, agent: "ses_agent", exitCode: 0 },
          { id: "two", title: "tests", titleNumber: 2, agent: 7, exitCode: "1" },
          { id: "three", title: "watch", titleNumber: 3, agent: "ses_agent", gone: true },
          { id: "four", title: "logs", titleNumber: 4, gone: "yes" },
        ],
      }),
    ).toEqual({
      active: "one",
      all: [
        { id: "one", title: "dev server", titleNumber: 1, agent: "ses_agent", exitCode: 0 },
        { id: "two", title: "tests", titleNumber: 2 },
        { id: "three", title: "watch", titleNumber: 3, agent: "ses_agent", gone: true },
        { id: "four", title: "logs", titleNumber: 4 },
      ],
    })
  })
})
