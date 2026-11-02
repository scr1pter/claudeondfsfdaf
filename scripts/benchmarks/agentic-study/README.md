# Paired agentic coding study runner

This runner is separate from historical Foundry instruments. It preserves the
existing $48 study ledger and cumulative `foundry-vector` / `foundry-codex` $20
actor caps. It starts no gateway, loads no provider API key, resets no spending,
and enables no deployment operation. Its default action only prints a plan.
Use Python 3.12 or newer; the executed Windows development runtime is 3.12.14.

Both arms use `gpt-6.1-sol`, explicit High reasoning, auto reasoning summaries,
low verbosity, one autonomous agent, a 1,050,000-token context and 32,000-token
output ceiling. Point `--provider-base` at the separately verified loopback
single-agent policy witness. The witness must strip autonomous-worker definitions
for both runtimes; the Vector profile also denies those tools. Experimental
native transport and raw-text patch mode remain off.

Run the free controls from this directory:

```sh
python -m unittest discover -p "test_*.py"
```

## Task contract

`--task-dir` contains `task.json`, the public prompt, an application seed and an
independent evaluator. An example task descriptor is:

```json
{
  "promptFile": "TASK.md",
  "seedDirectory": "seed",
  "protectedFiles": ["tests/smoke.test.ts"],
  "expectedApiGroups": 16,
  "expectedBrowserChecks": 8,
  "evaluatorCommand": [
    "{python}",
    "{task}/evaluate.py",
    "--app",
    "{app}",
    "--out",
    "{out}",
    "--bun",
    "{bun}",
    "--node",
    "{node}",
    "--task",
    "{task}"
  ],
  "evaluatorReport": "evaluation.json"
}
```

The evaluator and task tree stay outside the agent workspace. Only the seed and
public prompt are copied into the new app; `TASK.md` and `protectedFiles` cannot
change. Optional `setupCommand` uses the same placeholders as `evaluatorCommand`.
With a `bun.lock` seed and no explicit setup, locked dependency installation runs
before any batch is armed. Setup may not alter authored application files.

An evaluator report has a `verdict` of `passed`, `product_failure` or
`instrument_failure`, `sourceUnchanged: true` (or equivalent
`sourceIntegrityStatus: "unchanged"`), and complete unique `checks` containing
`name` and `status: passed|failed|not_run`. A passing verdict requires every check
to pass. Repair feedback requires a genuine failed check; missing or ambiguous
instrument results never trigger another paid attempt. The runner constructs
bounded observations rather than forwarding evaluator source or arbitrary raw
feedback. An evaluator crash or authored-source mutation stops the case.
Exit codes must agree with the report: zero for `passed`, one for
`product_failure`. A contradictory exit/verdict is an instrument failure.

Optional `generatedDirectories` lists exact app-relative generated paths. They
cannot overlap seeded or protected authored content. No nested `build`, `dist`,
`coverage` or `.next` directory is generically excluded: authored source in those
paths remains in integrity checks and snapshots. Only declared generated paths
and normal dependency/version-control/Python-cache directories are excluded.

Optional task `environment` permits `PORT`, `DATA_DIR` and `WORKFLOW_DATA_DIR`;
values can contain `{arm}` and `{app}`. Browser tooling is supplied explicitly
with `--chrome` and `--playwright-module`, through the scoped runtime variables
and `VECTOR_BENCH_CHROME` / `VECTOR_BENCH_PLAYWRIGHT_MODULE` evaluator variables.
When a browser driver root is supplied, the independent evaluator also receives
`VECTOR_BENCH_BROWSER_PROXY` pointing to its frozen `proxy.cjs` exact-origin
transport fence. It receives neither the runtime browser capability nor a model
batch token.

With `--browser-driver-root <common-browser-driver-directory>`, the runner starts
one owned browser driver per arm, using `--token-stdin` with a random local token.
It receives no provider or controller credential. The driver survives the one
same-session repair and is closed when its arm ends. Both agents receive the same
browser client protocol and prompt; the client path is the only explicitly
permitted benchmark helper outside the app. `PORT` from the task, or `--app-port`,
must identify the sole allowed loopback application origin. Existing user
browsers and profiles are never selected. The browser driver tree is frozen
alongside the task and runtime binaries.

## Plan, freeze and run

Supply the installed tools and private study directory. Do not put the private
study directory, controller configuration, scoped tokens, raw logs or credentials
in GitHub. Publish sanitized results and code through the repository workflow.

```sh
python runner.py --vector-root <clean-frozen-checkout> --codex-bin <codex-executable> --bun <bun-executable> --node <node-executable> --study-dir <existing-private-ledger-directory> --task-dir <frozen-task-directory> --out <new-private-output> --provider-base http://127.0.0.1:23130 --label <synthetic-case-name>
```

Review the printed source revision and task SHA. Reuse those exact values with
`--expected-source <revision> --expected-task-sha <sha> --run`. The run rejects a
dirty or changed source, changed task, non-loopback provider destination, existing
output directory, rewind below 449 receipts / $11.2319408, different study/actor
caps, unsettled funding state, or another open batch. The output must be outside
the source and task trees.

The defaults are two sequential arms, at most 300 provider calls and two hours
of agent execution per arm, with at most one same-session repair. `--order` can
reverse the runtime order. One scoped batch token is captured per arm and only
that token is disarmed; settlement is drained before reporting cost. Every
attempt and snapshot is retained. The session's Vector dollar allowance remains
fixed across repairs, avoiding double subtraction of already recorded spend.

The default $3 per-arm setting is a **soft stopping threshold**, checked while
the CLI runs and between attempts. A call already admitted can finish above it;
the unchanged gateway enforces the hard global and actor caps. The runner does
not reconfigure live funding policy. Uncertain admission, launch, transport,
closure or evaluator failures stop for review, with no automatic batch retry.
