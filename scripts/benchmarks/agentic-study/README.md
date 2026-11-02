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
values can contain `{arm}` and `{app}`. Owned browser tooling is supplied explicitly
with `--chrome` and `--playwright-module`. The independent evaluator retains
`VECTOR_BENCH_CHROME` / `VECTOR_BENCH_PLAYWRIGHT_MODULE`; the coding CLI receives
these library/browser variables only in the explicit legacy mode described below.
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

## Browser access modes

New paired plans default to `--browser-access-mode shared-client`. Both coding
CLIs receive `NODE_EXE` and the common client's path, endpoint, and scoped token.
They do **not** receive `PLAYWRIGHT_MODULE`, `CHROME_PATH`,
`VECTOR_BENCH_PLAYWRIGHT_MODULE`, or `VECTOR_BENCH_CHROME`, even if those values
were present in a base environment. The prompt requires the common client and
prohibits importing browser libraries, directly launching or connecting to a
browser, and attaching existing profiles. Paid shared-mode execution requires
the owned driver and explicit frozen Chrome/Playwright paths. The supervisor and
independent evaluator still receive their required paths outside the CLI's
environment.

`--browser-access-mode legacy-library-env` preserves the previous four library
variables and the exact previous prompt for reproducing earlier stages. Older
plans without a browser-mode field normalize to this legacy mode. A missing-arm
continuation must match that normalized mode explicitly; it cannot silently
switch the other runtime to shared-only provisioning. Plans, summaries, and arm
records identify the selected mode. Model, High reasoning, one-agent policy,
context/output settings, and spending caps are unchanged.

The environment and prompt are a provisioning policy, **not an operating-system
sandbox**. The coding CLIs still have a general shell; removing four variables
does not prove that arbitrary code cannot locate and start a browser. The earlier
runner explicitly advertised `PLAYWRIGHT_MODULE` and `CHROME_PATH`, then described
the common client as the only permitted external benchmark helper. Those were
conflicting instrument instructions, and both capabilities were offered to both
runtimes. Observed use of the advertised raw libraries is an instrument
confound, not evidence of agent misconduct. Historical results are not
retroactively treated as exclusively using the common client.

After each agent finishes, a bounded audit projects its tool JSONL into fixed
observations and counts. It can inspect a directly invoked authored script only
inside that attempt's application workspace. It does not crawl source trees,
read arbitrary referenced files, or publish commands, paths, identifiers, or
tokens. Clear direct-browser execution references, browser-related ambiguity,
and missing/incomplete/oversized telemetry require review in shared mode. General
shell-quoting ambiguity without a browser marker remains an informational
coverage limitation; it does not automatically block the arm. Ordinary source
writes/reads or merely unexecuted browser code are not automatically classified
as a direct launch. Legacy mode retains observations without changing its
historical execution policy.

Vector terminal actions are interpreted using its explicit action schema.
`list`, `read`, `wait`, `resize`, `close`, and `reveal` only observe or manage a
terminal; they are not new shell executions. Interrupt/redraw-only control keys
such as `ctrl-c` are likewise separate from commands. An `open` command is
inspected, including explicit argument arrays. Missing open commands, typed
interactive input, Enter/history/editing keys, and unknown actions retain a
manual-review marker when execution cannot be reconstructed safely. Browser
code typed interactively is never silently classified as a harmless read.

Every known, unchanged submission still receives the free independent functional
gate and core worker/session/exit checks before an audit decision. An unresolved
browser-related review marker then stops the arm as `coordinator_review_required`
before any further paid attempt, retaining the free gate's result, source
snapshot, and completed agent's usage. The owned token is still disarmed and
settled; every charge remains retained. It is not a regex-based product failure and never
produces automatic repair feedback. A clean audit means only that this bounded
projection found no clear bypass; dynamic execution, indirect processes, and
incomplete telemetry remain limits of this method. Manual review is required to
interpret suspicious or unknown evidence.

The shell lexer is deliberately incomplete. In free diagnostics on completed
historical traces, PowerShell wrapper escaping and here-string commands produced
`shell_execution_unparseable` markers even where recognized browser calls used
the common client. These remain in the total unknown and coverage counts. Only
ones with browser/library/process/common-client markers require review; other
quoting ambiguity is informational. Neither category proves a raw browser
launch, agent misconduct, or a failed product. `no_clear_bypass_observed` means
only that the bounded projection found no review-triggering evidence; its
coverage explicitly does not prove adherence. The audit does not clear an
entire trace merely because some common-client invocations were recognized.
Direct `createRequire(...)(...)` browser-module references and known scoped
browser packages are included in its bounded recognition.

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

## Manual continuation of an absent arm

A transport interruption can leave a paired output with one recorded, settled
arm and the other runtime never started. An audited manual continuation may run
only that absent runtime in a new output directory:

```sh
python runner.py <the same source/tool/browser/profile arguments> --order vector --continue-from <original-paired-output> --out <new-private-output> --label <new-synthetic-case-name>
```

The default command still plans both arms. A single `--order vector` or
`--order codex` is rejected without `--continue-from`; paired orders cannot use
that flag. Continuations cannot be chained, and an existing runtime cannot be
rerun through this path. A partial directory for the requested runtime also
blocks continuation, even if the old summary omitted it.

The free plan validates the original `plan.json`, `summary.json`, and recorded
arm's `run.json`. The original pair must have exactly one recorded arm, matching
summary/run records, acknowledged scoped disarm, zero active/reserved/open-batch
state, and internally consistent settled usage. The same clean product source,
model, High reasoning, one-agent policy, context/output limits, executable hashes,
browser driver, task descriptor, provider route, and stopping/cap settings remain
pinned. The current reviewed runner may include the transport/continuation fix;
both old and new runner inventories remain recorded.

If an independently reviewed evaluator correction changes the task digest,
explicitly add `--previous-task-sha <exact-original-task-sha>`. A wrong or missing
old hash is rejected. The public agent prompt and seed must remain unchanged.
This flag records instrument lineage; it does not authorize new requirements or
conceal the prior arm's outcome.

For a previous plan that has no `browserAccessMode` field, also specify
`--browser-access-mode legacy-library-env`. A mode mismatch blocks continuation
during the free plan, before credentials are read or a paid batch is opened.

Review the free plan, then supply its exact `--expected-source` and
`--expected-task-sha` with `--run` as usual. Output must be new and outside the
source, task, and original output trees. Original records are read-only and
hash-pinned before funding and throughout execution. The live ledger must also
remain at or above the prior settled request, total-cost, and per-actor totals;
all existing healthy-state and hard-budget checks still apply.

The new plan and summary identify the previous case, both task hashes, the
already-recorded runtime and outcome, retained prior charges, and the requested
missing runtime. Only the missing arm appears in the new `arms` object. Exit
zero means that new arm passed; it is not a verdict on the combined pair. Reports
must combine the original outcome and every charge with the continuation,
including any explicit unchanged-source reevaluation after an instrument fix.
This is manual recovery of an absent observation, never omission or rerunning of
a losing result. No continuation or paid retry is automatic.

## Read-only controller transport retry

Only `GET /status` may retry once after an `OSError`/timeout transport failure.
Each attempt uses a ten-second I/O timeout, with at most two attempts and no
backoff. Mutation routes, including `/control` and token-scoped `/disarm`, are
attempted once. HTTP errors, non-200 responses, oversized/malformed JSON, and
healthy-state/policy failures are never retried. Diagnostics identify only the
route and exception class, without echoing authorization or response payloads.
The retry neither admits nor repeats a model request.
