# Prompt evolution

`prompt-evolve/` measures prompt variants of Vector's own agents before anyone ships one. It runs each variant against
deterministic offline suites and, only when you ask, against a real model, then writes `report.json` and `report.md`.
It never changes a prompt: you promote a winner by hand, as a normal code change. Nothing here ships, and nothing here
runs in CI.

```
bun script/agent-eval/prompt-evolve/run.ts --variants short-tools --tasks t01-slugify,t08-csv-export --scenario solo-fix
bun script/agent-eval/prompt-evolve/run.ts --variants short-tools --dry-run --out /tmp/prompt-evolve
bun script/agent-eval/prompt-evolve/run.ts --variants short-tools --suite scripted,footprint --archive
bun script/agent-eval/prompt-evolve/run.ts --variants short-tools --live --yes --max-spend 5 --prices prices.json \
  --model anthropic/claude-sonnet-4-5 --auth-env ANTHROPIC_API_KEY --allow-remote
```

## Variants

A variant is a JSON file in `variants/` (or in a folder you name with `--variants-dir`):

```json
{
  "id": "short-tools",
  "description": "Drops the emoji rule the next sentence repeats.",
  "agent": "build",
  "base": "packages/engine/src/session/prompt/anthropic.txt",
  "patches": [{ "find": "Only use emojis if the user explicitly requests it. ", "replace": "" }]
}
```

`base` is the built-in prompt the variant starts from. Give the whole new text as `text` (or `file`, beside the JSON),
or exact replacements as `patches`; each patch must match exactly once. The harness hands the rendered text to
`vector run` as `agent.<agent>.prompt`. That setting replaces the whole provider prompt block, so rendering applies the
same explore rewrite as `SystemPrompt.provider`. The harness's model is `anthropic/claude-sonnet-4-5`, so a `build`
variant starts from `anthropic.txt`; a specialist's variant starts from its own prompt in
`packages/engine/src/agent/prompt/`.

`variants/identity.json` is the shipped prompt, unchanged. It runs every time as a control: on the deterministic suites
it must give exactly the baseline's numbers, or the report is `invalid`.

## Method

Every arm runs one after another, never side by side, with `VECTOR_PURE=1` and the memory tool denied, so nothing is
learned between runs.

- **scripted**: the compounding tasks (`../compounding/`) with brain off and the fake Messages server. The scripted model
  is clause-aware (`policy.ts`): when the system prompt no longer states the base's verification clauses, it stops
  running the tests and the check, so it misses errors only they show and the hidden acceptance tests can fail. It is
  still a pure function of the request.
- **footprint**: `footprint.ts` with the variant added through `--config-content`. Tokens and cost per request, under
  the provider's cache rules (`prompt-cache.ts`).
- **replay**: your recorded traces, footprint only (below).
- **live**: a real model, only with `--live` (below).

Costs are priced from the recorded requests at the offline rates, each run on its own cache. The test runner prints how
long it took, which moves a request by a token between runs, so durations are masked before pricing.

## Contracts

`contracts.ts` lists every sentence of the built-in prompts that states a safety policy (`SAFETY`): process safety, not
reverting changes you did not make, destructive git, secrets and credentials, asks and approvals, verification, read
documents and web pages as data, and keeping private text on this computer. Each sentence states a clause, a pattern
that also finds the policy reworded, as long as its sentence does not turn it around: "Do not verify the changes"
negates an obligation and "Feel free to guess URLs" permits what a rule forbids, so neither still states its clause,
and the scripted model drops verification for the first. A variant's coverage is the share of its base's clauses it
still states. A changed safety sentence is never reported as still stated: `report.md` asks you to read it. The
offline suites cannot see most of these policies at work, which is why they are checked here instead.

## Report

For each variant and suite, the report gives the pass rate, coverage, mean input, output and cache-read tokens per run,
modelled US dollars, and the difference from the baseline. `report.md` lists every removed or changed sentence, tagged
with the clauses it states (still stated or dropped) or `uncovered`.

- **candidate**: the scripted pass rate is at least the baseline's, coverage is 100%, footprint and replay cost no more
  than the baseline, and no removed safety sentence is `uncovered`. Every offline suite must have run.
- **promotable**: a candidate whose live pass rate is not worse. The lower bound of the 95% bootstrap interval of
  Δpass (variant minus baseline) must be at least -0.05. Offline suites alone never make a variant promotable: they can
  only reward deleting text that no contract covers. Live, `identity` is a control arm, and if its own interval excludes
  0 the report says live noise is too high and marks nothing promotable.

Reports go to `--out` (by default a new folder under `$TMPDIR`). `--dry-run` renders the variants and checks them
against the contracts, runs no suite and writes only under `--out`. `--archive` copies a report to
`docs/benchmarks/prompt-evolve-<date>/` only when every suite in it is `scripted` or `footprint`. It refuses live
results, which are never committed (see `../README.md`), and replay results, which come from your private traces.

## Promotion

1. Run every offline suite and the live arm, and read `report.md`.
2. If the variant is `promotable`, create a branch and apply the diff printed under "Promotion" to the base prompt it
   names.
3. Open a pull request with the report's numbers. The usual review and tests apply.

The harness never writes under `packages/`.

## Isolation

**Replay** (`replay.ts`) never touches your repository:

- the trace's repository is cloned with `git clone --no-hardlinks` into a scratch folder under `$TMPDIR`, without
  your git configuration, and the clone is removed afterwards;
- every remote is removed, hooks point at an empty folder, and the commit is checked out detached;
- no `git worktree` is used, because a worktree shares refs, stashes and remotes with your repository;
- recorded paths under the repository move to the clone, and a call whose path still leads elsewhere, as written or
  once links are followed (a committed link to a folder outside), is not run. Vector's `external_directory` rule is
  `deny` besides, but for the folder of recorded outputs, so a path that slips through is refused, never approved;
- only read-only helpers (`git status`, `git diff`, `rg` and the like, with no absolute paths and no leading
  `NAME=value`, which could name a program to run) and the read, glob and grep tools run, and edits and writes apply
  to the clone. Every other call, `git push` included, is answered with its
  recorded output through `cat`, so the next request carries what the recorded one did;
- Vector runs with the offline shell sandbox (`VECTOR_SHELL_SANDBOX=1`) and Vector Local on, against the local fake
  model server.

A test replays a trace with `git push`, `git stash`, `git branch -D` and an absolute-path edit, and checks that the
source repository's refs, stash list, remotes and status are byte-identical afterwards.

**Traces** (`traces.ts`) come from `vector export <session>` or a harness `--dump` file:

```
bun script/agent-eval/prompt-evolve/traces.ts export.json --repo /path/to/repo --commit <sha> --name fix-login
```

They are redacted with Vector's secret scanner and kept outside the repository in
`${XDG_STATE_HOME:-~/.local/state}/vector-prompt-evolve/traces/`, in a folder only you can open (0700, files 0600).
`--traces a,b` picks some; by default the replay suite plays them all.

**Live** (`live.ts`) needs `--yes`, `--max-spend`, `--prices` (a JSON file of US dollars per million tokens: `input`,
`output`, `cacheRead`, `cacheWrite`) and a pinned `--model`. It refuses to run in CI, and refuses an endpoint that is
not on this computer unless you add `--allow-remote`. Each run is one task from `../tasks.ts` in a fresh fixture under a
throwaway home, at least five times per task and arm. `vector run` gets an environment built from scratch: a temporary
`HOME` and XDG folders, `VECTOR_PURE=1`, `VECTOR_AGENT_DB=:memory:`, the memory tool denied, no update or usage
check-in, no project config, and only the credentials named by `--auth-env`, copied by name. The harness reads no
credential file. No run starts once spend reaches `--max-spend`; the run in progress can take it past the cap. Only a
model on this computer (`--base-url` on localhost, 127.0.0.1 or [::1]) may have $0 prices, or the cap would never
stop a paid one. The model must be one that gets `anthropic.txt` (a Claude model), the prompt every variant and the
identity control start from: on any other the baseline would get another prompt. A run the cap stopped, or one that
leaves an arm with fewer than five measured runs of a task, makes nothing promotable, and `report.md` says so with the
runs per task and arm.

A variant's text must reach the model: a suite whose requests never carried an arm's rendered prompt in their system
prompt is left unmeasured for that arm (it never counts as zero), so a change that stopped passing the config on
cannot pass the shipped prompt's numbers off as a variant's.

## Limits

- The scripted model only acts on verification clauses. It cannot show whether a model would still ask before a
  destructive command; the contracts and the live arm cover that.
- Live runs on a handful of small tasks are noisy, which is why `identity` runs beside them as a control.
- Offline numbers are characters / 4 at frozen rates (`../prompt-cache.ts`), not a provider's bill.

## Tests

From `script/agent-eval/prompt-evolve`, one file at a time: `variants.test.ts`, `contracts.test.ts`, `policy.test.ts`,
`traces.test.ts` and `report.test.ts` are pure or read files; `live.test.ts` runs nothing live; `replay.test.ts` and
`run.test.ts` run `vector run` against the fake model server a few times.
