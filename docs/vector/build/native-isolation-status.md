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
