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
