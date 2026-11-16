import { describe, expect, test } from "bun:test"
import path from "path"
import { AGENT_MARKER, inherit, untrustedChildEnvironment } from "../src/child-environment"

describe("untrustedChildEnvironment", () => {
  test("removes Vector control secrets while preserving provider credentials", () => {
    const environment = untrustedChildEnvironment({
      BLOB_READ_WRITE_TOKEN: "release-store-secret",
      VECTOR_AUTH_CONTENT: '{"provider":{"key":"aggregate-secret"}}',
      VECTOR_CONSOLE_TOKEN: "console-secret",
      VECTOR_SERVER_PASSWORD: "server-secret",
      VECTOR_BROWSER_BRIDGE_TOKEN: "browser-secret",
      VECTOR_CLOUD_TOKEN: "cloud-secret",
      VECTOR_CREDENTIAL_KEY: "vault-secret",
      VECTOR_INSTALLER_BLOB_TOKEN: "installer-secret",
      VECTOR_LICENSE_SECRET: "license-secret",
      VECTOR_MCP_AUTH_KEY: "mcp-secret",
      vector_future_bridge_key: "future-secret",
      OPENAI_API_KEY: "provider-secret",
      PATH: "/usr/bin:/bin",
      UNDEFINED_VALUE: undefined,
    })

    expect(environment).toEqual({ OPENAI_API_KEY: "provider-secret", PATH: "/usr/bin:/bin" })
  })

  test("keeps the user's own runtime variables for their commands", () => {
    const user = {
      NODE_OPTIONS: "--max-old-space-size=8192",
      PYTHONPATH: "/work/src",
      LD_LIBRARY_PATH: "/usr/local/cuda/lib64",
      DYLD_FALLBACK_LIBRARY_PATH: "/opt/homebrew/lib",
      PERL5LIB: "/home/user/perl5/lib/perl5",
      CLASSPATH: "/work/lib/app.jar",
      BUN_OPTIONS: "--smol",
    }

    expect(untrustedChildEnvironment(user)).toEqual(user)
  })

  test("does not expose scrubbed values to a real child process", () => {
    const environment = untrustedChildEnvironment(process.env, {
      VECTOR_CONSOLE_TOKEN: "console-secret",
      VECTOR_SERVER_PASSWORD: "server-secret",
      VECTOR_CLOUD_TOKEN: "cloud-secret",
      VECTOR_CREDENTIAL_KEY: "vault-secret",
      VECTOR_FUTURE_BRIDGE_TOKEN: "bridge-secret",
      OPENAI_API_KEY: "provider-secret",
    })
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify({
          console: process.env.VECTOR_CONSOLE_TOKEN,
          password: process.env.VECTOR_SERVER_PASSWORD,
          cloud: process.env.VECTOR_CLOUD_TOKEN,
          vault: process.env.VECTOR_CREDENTIAL_KEY,
          bridge: process.env.VECTOR_FUTURE_BRIDGE_TOKEN,
          provider: process.env.OPENAI_API_KEY,
        }))`,
      ],
      { env: environment },
    )

    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual({ provider: "provider-secret" })
  })
})

test("foreign runtime secret suffixes are stripped without dropping provider keys", () => {
  expect(
    untrustedChildEnvironment({
      LEGACY_FIXTURE_SERVER_PASSWORD: "synthetic",
      legacy_fixture_server_guest_password: "synthetic",
      LEGACY_FIXTURE_AUTH_CONTENT: "synthetic",
      LEGACY_FIXTURE_CONSOLE_TOKEN: "synthetic",
      OPENAI_API_KEY: "fixture-key",
      GITHUB_TOKEN: "fixture-git-token",
    }),
  ).toEqual({ OPENAI_API_KEY: "fixture-key", GITHUB_TOKEN: "fixture-git-token" })
})

// INV-S5: on GitHub Actions a child the model can start sees no credential of the runner, GitHub or Vector, and no name
// that looks like a secret. Defence in depth beneath the agent sandbox, for own-key runs on self-hosted runners above all.
describe("on GitHub Actions", () => {
  const visible = {
    PATH: "/usr/bin:/bin",
    CI: "true",
    GITHUB_REPOSITORY: "octo/widgets",
    GITHUB_WORKSPACE: "/home/runner/work/widgets/widgets",
    RUNNER_TEMP: "/home/runner/work/_temp",
  }

  test("Actions runs hide runner, GitHub, provider and named secrets from children", () => {
    const environment = untrustedChildEnvironment({
      ...visible,
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/request",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-secret",
      ACTIONS_RUNTIME_TOKEN: "runtime-secret",
      ACTIONS_RESULTS_URL: "https://results.actions.example/",
      GITHUB_TOKEN: "github-secret",
      GH_TOKEN: "gh-secret",
      VECTOR_CLI_TOKEN: "cli-secret",
      VECTOR_BIND_CODE: "bind-secret",
      VECTOR_TICKET: "ticket-secret",
      AWS_SESSION_TOKEN: "aws-secret",
      HF_TOKEN: "hf-secret",
      DEEPSEEK_KEY: "deepseek-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      DB_PASSWORD: "db-secret",
      SIGNING_SECRET: "signing-secret",
      MY_PROVIDER_CREDS: "listed-secret",
      // Spaces are trimmed; a name the generator could not have written is ignored.
      VECTOR_SECRET_ENV_NAMES: " MY_PROVIDER_CREDS ,bad-name,",
    })

    expect(environment).toEqual({
      ...visible,
      GITHUB_ACTIONS: "true",
      VECTOR_SECRET_ENV_NAMES: " MY_PROVIDER_CREDS ,bad-name,",
    })
  })

  test("outside Actions, GITHUB_TOKEN is kept", () => {
    const user = {
      ...visible,
      GITHUB_TOKEN: "github-token",
      HF_TOKEN: "hf-token",
      DEEPSEEK_KEY: "deepseek-key",
      ACTIONS_RUNTIME_TOKEN: "runtime-token",
      MY_PROVIDER_CREDS: "creds",
      VECTOR_SECRET_ENV_NAMES: "MY_PROVIDER_CREDS",
    }

    expect(untrustedChildEnvironment(user)).toEqual(user)
    expect(untrustedChildEnvironment({ ...user, GITHUB_ACTIONS: "false" })).toEqual({
      ...user,
      GITHUB_ACTIONS: "false",
    })
  })

  test("names are compared upper-cased, as on Windows", () => {
    expect(
      untrustedChildEnvironment({
        ...visible,
        GITHUB_ACTIONS: "true",
        github_token: "github-secret",
        my_key: "key-secret",
        actions_runtime_url: "https://runtime.actions.example/",
        Vector_Ticket: "ticket-secret",
        my_provider_creds: "listed-secret",
        vector_secret_env_names: "my_provider_creds",
      }),
    ).toEqual({ ...visible, GITHUB_ACTIONS: "true", vector_secret_env_names: "my_provider_creds" })
  })

  test("a later source cannot lift the filter or empty the list", () => {
    const environment = untrustedChildEnvironment(
      {
        ...visible,
        GITHUB_ACTIONS: "true",
        MY_PROVIDER_CREDS: "listed-secret",
        VECTOR_SECRET_ENV_NAMES: "MY_PROVIDER_CREDS",
      },
      // A project MCP server's environment, say, that a writer of the repository controls.
      {
        GITHUB_ACTIONS: "false",
        VECTOR_SECRET_ENV_NAMES: "",
        GITHUB_TOKEN: "github-secret",
        SERVER_TOKEN: "own-secret",
      },
    )

    expect(environment).toEqual({ ...visible, GITHUB_ACTIONS: "false", VECTOR_SECRET_ENV_NAMES: "" })
  })

  test("the agent marker and Vector Local floor still apply after the filter", () => {
    inherit({ agent: true, local: { enabled: true, web: "network" } })
    try {
      expect(untrustedChildEnvironment({ ...visible, GITHUB_ACTIONS: "true", GITHUB_TOKEN: "github-secret" })).toEqual({
        ...visible,
        GITHUB_ACTIONS: "true",
        [AGENT_MARKER]: "1",
        VECTOR_LOCAL: "1",
        VECTOR_LOCAL_WEB: "network",
      })
    } finally {
      inherit({ agent: false })
    }
  })

  // Most callers pass no source (infrastructure git, LSP servers, core's shell helper), so the filter must read the
  // process's own environment as it reads a source.
  test("with no source, the process's own environment is filtered", () => {
    const environment = withProcessEnvironment(RUNNER, () => untrustedChildEnvironment())

    expect(Object.keys(RUNNER).filter((name) => name in environment)).toEqual(["GITHUB_ACTIONS", "FIXTURE_VISIBLE"])
    expect(environment.GITHUB_ACTIONS).toBe("true")
    expect(environment.FIXTURE_VISIBLE).toBe("kept")
  })
})

// The same with a real child. It starts Bun, so its name stays out of the "on GitHub Actions" filter the lane's local
// runs use to avoid nested Bun processes; the lane runs it with the whole file.
test("a real child of a process on an Actions runner reads none of its credentials", () => {
  const child = withProcessEnvironment(RUNNER, () =>
    Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify({
          actions: process.env.GITHUB_ACTIONS,
          github: process.env.GITHUB_TOKEN,
          runtime: process.env.ACTIONS_RUNTIME_TOKEN,
          oidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
          provider: process.env.FIXTURE_PROVIDER_KEY,
          visible: process.env.FIXTURE_VISIBLE,
        }))`,
      ],
      { env: untrustedChildEnvironment() },
    ),
  )

  expect(child.exitCode).toBe(0)
  expect(JSON.parse(child.stdout.toString())).toEqual({ actions: "true", visible: "kept" })
})

// A name configured for a child (an MCP server's `environment`, say) is withheld on Actions too, and the process says so
// once per name on stderr, so a server that fails for want of its token can be diagnosed. Inherited names, Vector's
// own private names and values never appear. It runs in a Bun child, whose stderr is its own, so it also stays out of
// the local filter.
test("a credential configured for a child is withheld with one notice per name", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { untrustedChildEnvironment } from ${JSON.stringify(path.join(import.meta.dir, "../src/child-environment.ts"))}
      const runner = { PATH: "/usr/bin", GITHUB_ACTIONS: "true", GITHUB_TOKEN: "inherited-secret", ACTIONS_RUNTIME_TOKEN: "inherited-secret" }
      const environments = [
        untrustedChildEnvironment(runner),
        untrustedChildEnvironment(runner, { GITHUB_PERSONAL_ACCESS_TOKEN: "configured-secret", LOG_LEVEL: "debug" }),
        untrustedChildEnvironment(runner, {
          github_personal_access_token: "configured-secret",
          SENTRY_AUTH_TOKEN: "configured-secret",
          VECTOR_CLOUD_TOKEN: "private-secret",
        }),
        untrustedChildEnvironment({ GITHUB_ACTIONS: "false" }, { NPM_TOKEN: "configured-secret" }),
      ]
      process.stdout.write(JSON.stringify(environments.map((environment) => Object.keys(environment).sort())))`,
    ],
    { env: { PATH: process.env.PATH ?? "" } },
  )

  expect(child.exitCode).toBe(0)
  expect(JSON.parse(child.stdout.toString())).toEqual([
    ["GITHUB_ACTIONS", "PATH"],
    ["GITHUB_ACTIONS", "LOG_LEVEL", "PATH"],
    ["GITHUB_ACTIONS", "PATH"],
    ["GITHUB_ACTIONS", "NPM_TOKEN"],
  ])
  const notices = child.stderr.toString().trim().split("\n")
  expect(notices.map((line) => line.split("Withheld from one: ")[1])).toEqual([
    "GITHUB_PERSONAL_ACCESS_TOKEN.",
    "SENTRY_AUTH_TOKEN.",
  ])
  expect(child.stderr.toString()).not.toContain("secret")
})

// What a GitHub runner puts in the engine's own environment, planted in this process's.
const RUNNER = {
  GITHUB_ACTIONS: "true",
  GITHUB_TOKEN: "github-secret",
  ACTIONS_RUNTIME_TOKEN: "runtime-secret",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-secret",
  FIXTURE_PROVIDER_KEY: "provider-secret",
  FIXTURE_VISIBLE: "kept",
}

/** Sets `values` in this process's environment while `run` runs, then puts back what was there. */
function withProcessEnvironment<T>(values: Record<string, string>, run: () => T) {
  const before = Object.keys(values).map((name) => [name, process.env[name]] as const)
  Object.assign(process.env, values)
  try {
    return run()
  } finally {
    before.forEach(([name, value]) => {
      if (value !== undefined) {
        process.env[name] = value
        return
      }
      delete process.env[name]
    })
  }
}
