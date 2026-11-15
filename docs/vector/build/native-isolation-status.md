# Native isolation build checkpoint

Work remains on the isolated `build-isolation` branch. No main merge, release, default activation, owner application launch or owner computer operation is part of this checkpoint.

## Verified shared command integration

Production checkpoint `93387de557129c56c48a1b32cfaa1845023b56bf` has 21 successful test jobs, three intentional manual skips and no failures in workflow `43320552566`. Typecheck workflow `43320558105` passed all four jobs. Both Windows command fixture groups and both App browser jobs passed. Namespace experiment `43320554570` passed its limited experiment; it does not qualify a production kernel or isolation floor.

The production changes include coherent native build identity for the Engine, Core and Brain worker; readonly-parent masking and conservative nested mount/alias refusal; and the shared command spawner using the private native lifecycle owner. Cancellation joins the owned execution before release. Source guards remain monotonic across the reviewed provider and credential-loading boundaries. No blanket arbitrary-JavaScript containment claim follows.

## Shell lifecycle fixtures

Commit `b68f7aae5` adds three unmounted CI fixture entrypoints under `packages/engine/test/fixture/native-shell-*`. They exercise the actual global private loader, Shell tool, permission flow, command spawner and native lifecycle. The matrix is Node/Bun by own key/Codium, with ten baseline scenarios and a separate fresh-cell Engine-death case for each combination.

Only aggregate `InstanceBootstrap.run` is replaced with a no-op in this fixture. Full Engine bootstrap remains unqualified. Synthetic secret material enters through stdin and private JavaScript state, not credential files or child command arguments/environment. The host independently checks process identities, descriptor state, namespace separation, canaries, readonly behavior and survivors before its final UID sweep.

The finite asset manifest binds all three entrypoints, five emitted WASM files and copied runtimes. Verification reads pinned regular root-owned immutable file descriptors in bounded chunks, checks path/descriptor identity before and after hashing, and runs before host loading, secret-channel generation or Engine tool imports. There is no mutable workspace or package-directory fallback.

Independent source review, Engine typecheck, pure manifest boundary checks, static Python AST parsing, and coherent Node/Bun source builds of all three entrypoints passed. These are source checks: no emitted Shell fixture, native helper, privileged installer or kernel probe was executed locally.

## Remaining qualification

Actual CI must first prove the installed Python metadata observer and runtime/profile provenance on the same host. Then a reviewed immutable installer and workflow must run the complete baseline matrix and four fresh Engine-death cells, including owned cleanup on every path. The stock Ubuntu reader fix is being qualified separately on `build-scope`/`build-scope-witness`; an integration must preserve its exact reviewed implementation instead of substituting a path-only interpreter check.

Full bootstrap, preconstruction alias/canary cases, native profile/LSM compatibility, installed runtime provenance, root installation and production floor qualification remain open. No production activation is authorized by this document.

## Prepare diagnostic continuation, 14 November 2026

The genuine baseline at source `faa1fa09b697b900e6125ad316a7e961de616981`
([run 43566766483](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43566766483),
job `132362207081`) failed before the first keeper marker. Its closed diagnostic
was `prepare-keeper-child-exit-log-no-marker-info-child-created`, exit 1. Cleanup
also refused its proof; neither result is a successful isolation or cleanup
witness. The child-created metadata alone does not prove completed mounts,
interpreter startup or execution of the keeper.

The `native-finish` source extends only the private-output-free diagnostic
projection for setup failures between child creation and keeper execution.
Additional fixed bubblewrap operation prefixes come from the already-pinned
[v0.9.0 source](https://github.com/containers/bubblewrap/blob/8e51677abd7e3338e4952370bf7d902e37d8cbb6/bubblewrap.c).
Unknown prose, paths, arguments and stderr remain private. The native decoder
accepts the exact expanded closed product; malformed and unknown values still
refuse. No mount, capability, profile, admission, timeout or cleanup requirement
is relaxed, and the native build remains inactive outside its existing CI seam.

Both Python sources parse and `git diff --check` passes at this checkpoint.
The pure diagnostic tests and Engine types await the coordinator's serial Bun
slot. One explicitly selected Bun/own-key/baseline hosted cell is intended to
locate the remaining prepare failure; it is not the full qualification matrix.
The workflow permits that branch only through manual dispatch. No native code,
privileged operation or owner application was executed locally.

The separate legacy @vector sandbox job `132364311238` at source `ceed2426`
also refused prepare before its runtime probes. Its generic error is not evidence
of the same cause as the native keeper failure. No native implementation is
transplanted wholesale into the legacy preparation path by this diagnostic step.

The first bounded diagnostic dispatch,
[43619796230](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43619796230)
at `065287ba`, stopped in the pure-policy step: 29 cases passed, and one still
expected the old 114-element diagnostic product rather than the expanded 162.
Both stale Python expectations are corrected; no native prepare ran in that
dispatch. A local request to execute only its pure diagnostic class was refused
by the fixture's CI-only gate before tests or native initialization. That gate
was left intact; the correction awaits a fresh bounded hosted dispatch.

The corrected single-cell run
[43620478356](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43620478356)
at `c12c144e` passed all 30 pure-policy cases and both installed Node/Bun metadata
preflights. Actual prepare then refused with
`prepare-keeper-child-exit-log-bwrap-destination-info-child-created` (exit 1).
Cleanup proof remained refused. This establishes a bubblewrap destination
construction error, not the target responsible or a successful keeper launch.

The next diagnostic source narrows that category only to the ABI's ten fixed
destination kinds (mask roots, checkout/scratch and device/proc roots). Exact
known targets can yield a closed label; other paths retain the generic category
and never appear in output. The 37-log/222-stage product is checked consistently
in the Python source/fixture and native TypeScript decoder. AST parsing and
static vocabulary agreement pass; the new target-classification test and actual
prepare still require the next bounded hosted cell. Runtime construction and
cleanup behavior remain unchanged.


## Inactive source integration with v2/Hands, 14 November 2026

The native continuation integrates release source `df0e3b1c5` in its own worktree.
This updates the historical branch-only statement above: source integration is now
authorized, while native activation and real-host qualification remain separate gates.
Both source native build switches remain false and the legacy bubblewrap `FLOOR`
remains explicitly held false. No runtime or environment setting activates either.

The shared spawner preserves typed planning failures and captured-output ownership.
A command has one lifetime signaler: ordinary background commands retain the owned
process controller, and native foreground commands retain the native owner. Native
commands registered with `OwnedProcess` are refused before launch, including a later
pipeline stage, until a qualified delegated control adapter exists (spawn review §4.4).
Hands' early and final shell/PTY rechecks and protected-overlay exclusions are retained.

The two fixed Python helper seams (`directory-identity` and `read-only-git`) now refuse
required process isolation at admission and immediately before spawn. They do not claim
a fixed-helper exception or run a raw fallback. The CI metadata-reader source digest is
updated to the exact integrated reviewed reader, not an older adapter implementation.
The native Shell fixture includes the real new ComputerSession and Session dependencies;
its only harness omission remains aggregate unrelated InstanceBootstrap.

Validation on Windows in this isolated worktree: Core and Engine `bun typecheck` pass;
Core native policy/planning/refusal suites: 49 pass, 2 platform skips; Engine sandbox and
native-adapter pure suites: 50 pass, 2 platform skips; shared-spawner regression suite:
35 pass. The owned-native pipeline policy case and Linux kernel-alias case are Windows
skips, not successful Linux witnesses. Fixed-helper refusal runs in a separate process
with the actual irreversible guard and passes. Both Python sources parse. No local
native helper, root installer, privileged operation, model call or owner app was run.

The single hosted target-classification diagnostic at `f141ef16` is still queued as run
[43621985900](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43621985900).
No expanded matrix was dispatched. Prepare, cleanup, full bootstrap and production
activation remain unqualified; source/type/pure test passes do not close these gates.


The queued single-cell diagnostic has completed: run `43621985900`, job
`132529480650`, at `f141ef16` passed all 31 pure Python policy tests, the three
control-policy tests, compilation, and same-host Node/Bun metadata preflights.
Actual prepare failed with the exact closed label
`prepare-keeper-child-exit-log-bwrap-destination-host-temp-info-child-created`.
The failing construction target is therefore the fixed hosted temporary root,
`/home/runner/work/_temp`. Keeper startup, Shell lifecycle and Engine-death cells
were not reached. Cleanup proof also refused. No successful isolation/cleanup
claim follows. Mask geometry, runner permissions and privilege lifetimes have
not been relaxed; any ancestor-mask construction needs a complete alias/mount
proof before a further bounded hosted qualification.


## Connect C5 private Git status proof

A live index's stat-cache-only rewrite no longer invalidates a review merely because
its raw bytes changed. The observer copies changed bytes into its own exact private
observation file, uses the same pinned runtime/configuration and verified private
objects, and compares both canonical staged entries and the captured tree OID.
HEAD and symbolic-ref identity remain exact. Source index bytes, hooks and executable
configuration are never written or executed. Required-isolation helper refusals remain.

The review's normalized private index now keeps its own refreshed stat cache between
status checks. Refreshes serialize, retain explicit ctime/full-stat checks, and permit
only the ordinary clean/dirty return codes; source skip/fsmonitor/stat flags are still
discarded at capture. Six real Linux regressions cover a harmless live status refresh,
concurrent checks, actual staged content/mode and HEAD/branch changes, and equal-size
content modification with the original mtime restored. On Windows these are explicit
skips pending the existing hosted repository-identity lane; pure/import/refusal checks
pass. This does not implement startup deletion of stale private directories: that
requires a separate ownership/liveness/retention proof and must not delete another
active review's private files.

The native workflow's explicit manual ref allowlist now also permits `main` and
`release-finish`, so the held qualification lane remains reachable after integration.
Its diagnostic-cell selector, full matrix, pinned actions, runtime provenance, host
and cleanup checks are unchanged. No further workflow has been dispatched here.


Final C5 source formatting and Core `bun typecheck` pass. Windows import/pure/refusal
selection reported 7 passes and 65 explicit Linux skips before the final private-cache
refresh addition; the additional restored-mtime integration case is also Linux-only.
The six new Linux cases have not been represented as local passes. No hosted lane was
automatically started for this C5 source change.


## Hosted C5 correction: stat-cache optimization held

At exact `f2988d6ad8e076a4bf435f93c6b8c64134df196e`, repository-identity run
`43629547399`, job `132552901107`, passed 69 read-only Git cases and explicitly
skipped the unsupported-host case. The new equal-size/restored-mtime negative
failed: size and mtime matched, high-resolution ctime changed, but the refreshed
private Git stat cache returned `dirty=false`. This is a correctness failure,
not a successful C5 optimization or a flaky timeout. Earlier source/type passes
above do not qualify it. The other five new semantic-index/HEAD cases passed.

The optimization is removed. The review retains its normalized private index
with empty source stat/skip/fsmonitor cache fields, and status continues to hash
rather than trusting refreshed Git metadata. The original semantic HEAD/ref,
staged-entry and index-tree proof remains, so an ordinary live `git status`
rewrite does not cancel the review. The restored-mtime negative remains fully
asserted. Cache-performance work is held until a stronger metadata witness
preserves that detection guarantee; no delay, skip or weakened fixture replaces it.
The corrected source needs fresh hosted qualification at its own revision.


Correction validation on this Windows host: Core `bun typecheck` passes, and the
named read-only Git/pure spawn-refusal selection passes 7 cases with 66 explicit
Linux-only skips. The six genuine Linux cases, including the restored-mtime
negative, require fresh hosted qualification and are not local passes. No fixture,
assertion, native control, evidence pin or model/provider route was weakened here.

## Lane dispatch and destination errno diagnostics, 15 November 2026

The `native-qualify` lane (from `release-finish` `0ee486e3`) adds
`refs/heads/native-qualify` to the native workflow's manual ref allowlist. It is
reachable only through `workflow_dispatch`; push triggers, the diagnostic-cell
selector and its default, the full matrix, pinned actions, permissions, runtime
provenance, host and cleanup checks are unchanged. The lane's bounded dispatches and
their results are logged in `native-qualify-notes.md`.

The keeper destination diagnostic now also names a closed cause. After one of the ten
fixed destination kinds, only the complete C-locale strerror text of six errnos maps to
a suffix: `eacces`, `erofs`, `enoent`, `enotdir`, `eloop` or `eperm` (for example
`bwrap-destination-host-temp-eacces`). Bubblewrap v0.9.0 never calls `setlocale` and
the keeper starts it under `env -i`, so this is the text it prints. Every other errno
text, any prose, any unknown target and every path still stays private: an unknown
remainder keeps the unsuffixed target label and an unknown target keeps
`bwrap-destination`. This supersedes the 37-log/222-stage count of the 14 November
section: the closed product is now 97 logs and 582 stages, checked consistently in the
Python source, the Python fixture and the native TypeScript decoder.

Nothing is relaxed in mounts, capabilities, profile, admission, timeout or cleanup.
Both native build switches and `FLOOR` remain false, and native commands registered with
`OwnedProcess` remain refused before launch. The authoritative evidence for the Python
changes is the CI `native-guard-unit.yml` run of the 35-test pure fixture; it and the
hosted label are CI-only and are logged in `native-qualify-notes.md`. Local evidence:
both Python sources parse; an AST-only agreement check and the TypeScript decoder agree
on exactly the 582 stages; the Engine isolation decoder suite passes 31 tests; Core and
Engine `bun typecheck` pass. A local AST-extracted smoke of the five pure keeper
diagnostic functions also passed; it is supplementary only, outside the lane's allowed
local checks, and no substitute for guard-unit.

Ubuntu's `0.9.0-1ubuntu0.3` build rewrites bubblewrap's userns-denied message, so the
exact upstream `bwrap-userns-denied` label cannot match on the hosted runner; such a
failure would classify as `no-marker`. That gap fails closed and is left for a later
package. An `eacces` result would confirm the errno only, not which ancestor of the
hosted temporary root blocks the keeper. No production activation is authorized by this
document.

## Keeper search admission, 15 November 2026

The bounded lane dispatch `43660129312` (job `132647364562`, head `597dbcc9`) closed with
`prepare-keeper-child-exit-log-bwrap-destination-host-temp-eacces-info-child-created`:
bubblewrap could not build the parents of the hosted temporary root as the keeper and
got `EACCES`. The keeper runs as `vector-agent` with no supplementary groups in a user
namespace that maps only its own uid and gid, so its namespace capabilities override
permissions only on its own inodes; Root- and runner-owned ancestors are searchable only
through their one selected mode class.

Admission now refuses such a geometry before any construction, with fixed labels only:
`prepare-mask-<label>-keeper-search` when a strict ancestor of a mask is not searchable
by the keeper (checked after every other mask predicate, from the parent metadata those
predicates already admitted), and `prepare-keeper-search-checkout` when the container
ancestry of the checkout and scratch binds is not (checked after every other
pre-construction predicate). No path, mode, owner or group leaves the private log.
Nothing is relaxed: geometry the keeper's mode bits allow is admitted as before, no
`chmod` is added, and `MASKS` and the keeper argv are unchanged.

This adds to, and does not change, the 15 November keeper product, which stays 97 logs
and 582 stages. The mask admission product grows from 68 to 73 stages (the TypeScript
per-mask entries from 57 to 62), plus the one container-ancestry stage, checked
consistently in `entry.py`, the CI-only Python fixture (40 tests) and the native
TypeScript decoder and its test file `github.isolation.test.ts` (33 tests, 2 new). Both
native build switches and `FLOOR` remain false, and native commands registered with
`OwnedProcess` remain refused before launch.

The expected hosted label for the next bounded diagnostic cell is
`prepare-mask-host-temp-keeper-search`. It would confirm at admission that `/` and
`/home` are searchable by the keeper and that `/home/runner` or `/home/runner/work` is
not. Which of those two blocks remains unproven; the planned `/home/runner` mask does not
depend on it, but a narrower `/home/runner/work` mask would need a per-ancestor witness
first. ACLs and mandatory access control are not modelled, and the hosted run is the
authority. The run and its result are logged in `native-qualify-notes.md`. No production
activation is authorized by this document.

## Runner-home mask, 15 November 2026

The bounded lane dispatch `43675930370` (job `132695971881`, head `f05f9916`) closed at
admission with `prepare-mask-host-temp-keeper-search`. The keeper cannot search a strict
ancestor of the fixed hosted temporary root `/home/runner/work/_temp`, which is
`/home/runner` or `/home/runner/work`; which of the two is still unproven. The earlier
dispatch `43660129312` closed with `...-bwrap-destination-host-temp-eacces-...` on that
same fifth mask. Bubblewrap applies its operations in order, so the four earlier masks
over Root-owned host directories did not fail. That last step is code reading of
bubblewrap, not a hosted witness.

The mask list is now `/home/vector-agent`, `/tmp`, `/var/tmp`, `/run` and `/home/runner`,
each an empty read-only tmpfs in that order. This supersedes every earlier mask list in
this document that names `/home/runner/work/_temp` as a mask root. The fixed
`RUNNER_TEMP` stays `/home/runner/work/_temp` for the TypeScript `hostedTemporary`
equality and is hidden beneath the runner-home mask. The mask now also hides every other
runner-home path, such as the runner install and diagnostic trees, `~/.bun` and tool
caches. This is a fact about the mask's extent, not a security or qualification claim.

Proof obligations in the source:

- Admission requires the following:
  - the runner home is a canonical directory owned by the runner uid, with no group or
    other write;
  - the runner account's home directory is exactly `/home/runner`;
  - every mask parent is canonical, Root-owned, without group or other write, and
    keeper-searchable;
  - each mask root's mount is descriptor-pinned on its recorded device;
  - nested mounts beneath any mask are pinned origins.
  Alias refusal and the capture closure are unchanged.
- Construction checks each mask twice as a live, read-only, empty, keeper-owned `0755`
  tmpfs.
- No published container, stage, scratch, directory or socket path may lie under a mask
  (`validate_spec`, `parseSpec`).
- The native `run()` refuses any engine or runtime beneath a mask. That now includes
  `/home/runner`, so a runtime installed there (for example by setup-bun) is refused, which
  is stricter. The CI fixture runs only its copies under `/usr/libexec`.
- After prepare, mask-source validation re-checks each root record's mode, uid and gid,
  and the runner-owned `/home/runner` is now one of those records. A runner-owned step
  that changes `/home/runner`'s mode or owner after prepare therefore makes validation
  refuse in a later step. That fails closed; the check is not to be widened.
- Still open until a hosted run passes prepare, as CI witnesses:
  - the runner-home canaries are exactly `ENOENT` through the mask;
  - `/home/runner/work` cannot be recreated (`EROFS`);
  - Root reads both hosted seeds before the agent's privilege drop.

The hosted temporary label families are removed and replaced in place by `runner-home`
ones, consistently in `entry.py`, the CI-only Python fixture (45 tests) and the
TypeScript decoder with its test file `github.isolation.test.ts` (34 tests). The mask
admission product stays 73 stages, the TypeScript per-mask entries 62, and the keeper
product 97 logs and 582 stages. No `chmod` or `chown` is added, no mask is dropped, and
no alias or capture check is weakened. The run and its result are logged in
`native-qualify-notes.md`.

No qualification follows from this change. Both native build switches and `FLOOR` stay
false, and native plus `OwnedProcess` stays refused. No production activation is
authorized by this document.
