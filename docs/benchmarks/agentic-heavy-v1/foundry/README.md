# Heavy Foundry application task

This is a development replication of the previously executed Foundry build,
adapted for a separately matched native team. Its specification and old outputs
are already public and known. It is not a new holdout, and no new paid outcome is
asserted here. The participant workspace receives an empty dependency scaffold,
not a previous delivered implementation.

The application connects customer management, inventory and immutable stock,
multi-line orders, atomic/idempotent fulfillment, invoices, project/kanban delivery,
comments, local attachments, CSV import/export, roles/invitations, activity, live
data and restart recovery. It requires real API behavior, a complete React UI and
browser verification. This is substantially broader than one maintenance change.
All identities and data are synthetic; there are no cloud/account deployments.

## Exact inherited instrument

`instrument/` contains **18 byte-identical files** copied from the published
[historical instrument](../../tokenomics-2026-11-01/foundry/instrument/README.md).
The original complete historical freeze was
`fcc3611fc1a5ca397405e00073936c51a60c5d2327ac93373563dc11d89966bd`.
That freeze covered more files than this portable public subset. Do not mistake
the old `browser-instrument-validation.json` intermediate static snapshot for a
fresh execution or the final executed browser source hash.

[provenance.json](provenance.json) records every copied hash. Important final
executed sources are:

| Source | SHA256 |
| --- | --- |
| `instrument/BUILD_SPEC.md` | `62c42361ffec2b6cf91ef3ef5fb49706503aa05ff420ecf315e270904467c35a` |
| `instrument/evaluate.py` | `ebaa5108a5493b737a61f3f6f7edb013626f6af762a7415271e0fb9a00df68cc` |
| `instrument/browser-eval.cjs` | `b6784542f7ac1d943e96f58029e1f890a92a0bb8ec039dd1ce345ab47bd8a262` |

Copied archives retain their original line endings byte for byte. Their local
Git attributes preserve those bytes and recognize CRLF line endings; newly
authored adapter files retain the ordinary repository text/whitespace rules.

The historical common evaluation retained all **32 API groups and 40 browser
checks**, typecheck/build/startup, post-stop cryptographic password verification,
restart persistence, concurrency, tenant boundaries, and authored-source
integrity. The saved five application cases passed all browser checks and all API
groups except one genuine draft-order API failure in the native-first case. Those
are historical results, not fresh team-study passes. See the original
[per-check evidence](../../tokenomics-2026-11-01/foundry/evaluation-results.json).

## Participant workspace and runner bindings

The runner copies the four files under `instrument/seed`, then copies the public
prompt as **`BUILD_SPEC.md`**, preserving the original five-file empty scaffold:
`.gitignore`, `BUILD_SPEC.md`, `bun.lock`, `package.json`, `tsconfig.json`. There is
no server, frontend, database, test solution or previous app in that seed.
`workspacePromptFile` must be honored; adding a second `TASK.md` is unnecessary.
Keep the lockfile and specification protected. Run the task's frozen dependency
setup before any funded arm; setup must not modify authored files.

The task contract uses explicit `{playwright_module}` and `{chrome}` evaluator
bindings in addition to `{python}`, `{task}`, `{app}`, `{out}`, `{bun}`, `{node}`.
These are evaluator-only tool paths. Coding agents receive only the common browser
client, its owned endpoint/token and `NODE_EXE`. The historical specification's
optional raw-tool environment hints are absent; the shared-client instructions
apply to this study. Participants must not read the independent evaluator or old
submissions.

The runner's evaluator timeout is 1,500 seconds. The adapter's bounded original
evaluation uses the copied byte-identical public `owned_process.py` helper with
a 1,440-second deadline and Windows Job cleanup of its owned child tree. The
executed platform remains Windows; cross-platform child-tree behavior is not
qualified here. This operation still needs the single Bun workload lease.

## Format-only adapter and acceptance

The new root `evaluate.py` runs the exact original evaluator under
`<out>/original`. Its raw report/logs remain untouched. It writes a separate
normalized `<out>/evaluation.json`, carrying the raw report hash and every
original outcome. There are **76 normalized rows**: the original 32 API groups,
the original 40 browser checks, and four separately labelled prerequisites
(typecheck, build, startup, source integrity). This does not invent four new API
groups. `expectedTotalChecks=76` must be used by the heavy runner.

A pass requires all 72 original checks and all four prerequisites, agreement with
the original full gate and exit status, post-stop password verification evidence,
and unchanged authored source. Missing/duplicate/extra check inventories,
contradictory counters/gates/exits, crashed/timed-out evaluation, missing browser
output after startup, or unassessed/changed source require instrument review.
Build/startup product failures remain explicit prerequisite failures; the 72
unexecuted checks remain **not run** rather than being renamed failures or passes.

The 48-point blinded source review and matched screenshot review remain separate.
Passing functional checks or native team telemetry does not establish equal code
quality. Every child, specialist, judge, helper and repair must be charged by the
separate funded coordinator. This task neither changes actor caps nor starts a
paid run. No provider/controller credential or runtime configuration is loaded.

## Free verification

Run from this directory with Python 3.11 or newer:

```sh
python -B -m unittest test_adapter -v
python -B -m unittest discover -s instrument -p test_instrument.py -v
```

The adapter controls exercise the actual normalization function using labelled
synthetic reports and negative mutations. They start no app, model, browser or
Bun process; a synthetic complete report is not evidence that an application
passes. The original browser/source check bodies have not been changed or
weakened.

## Recorded free runtime qualification

On November 2, 2026, the wrapper ran on a disposable exact copy of the known
public readiness-first app, then the original empty scaffold, sequentially under
the Bun lease. The positive passed **32/32 API + 40/40 browser + 4/4 explicit
prerequisites**, including post-stop cryptographic password verification, in
46.062 seconds. The empty scaffold returned product failure in 5.031 seconds:
three failed build/startup prerequisites, one passed source-integrity prerequisite,
and all **72 API/browser checks not run**, with zero application check passes.

All 17 positive authored files and all five scaffold files were byte-unchanged
before/after independently of the inherited evaluator. The runs reused matching
locked dependencies from an earlier owned evaluation, with no network install,
provider call or source edit. The initial preparation's overstrict whole-package
equality assertion is retained: the reference app has additional test scripts,
while dependency sets and the lockfile match the scaffold. It stopped before any
application/Bun run; no reference implementation was modified to qualify.

[qualification.json](qualification.json) records allowlisted counts, per-check
statuses, tool/code hashes and limits. Raw paths, logs and configuration remain
private. These are reference/negative controls, not fresh model-generated
deliveries, paid outcomes, or proof of production readiness.
