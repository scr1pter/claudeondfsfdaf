# Vector Hands engineering guide

Vector Hands is the attended desktop feature scheduled for 1.99.112. Source checkpoints and actual native evidence are tracked in [hands-progress.md](./build/hands-progress.md); that ledger, rather than source presence, determines what has been validated. The complete contract is [hands-build-spec.md](./build/hands-build-spec.md), with intentional corrections in [hands-deviations.md](./build/hands-deviations.md).

## Architecture

The renderer requests work through the narrow `window.api.computer` preload bridge. Desktop Main owns consent, per-task grants, the live gate, overlays, retention and native helper supervision. The local engine owns the `computer` tool, provider/model eligibility, screenshot budgets, permission checks and attended control flow. Native helpers own current OS identity, desktop availability, capture, accessibility and input checks immediately before effects.

Screen text and accessibility labels are untrusted data. They cannot grant app access, approve a sensitive step, change policy or choose an executable. Protected apps, secure fields, developer text edits, unsafe shortcuts and instruction/configuration files remain subject to their independent refusal rules after an approval.

The helpers serve only a verified containing Vector installation and actual caller process. macOS uses a separately responsible helper app with its own privacy identity. Windows uses a normal-integrity process, exact process/file/token observations and a private release guardian for confirmed owned input. Running Vector as administrator never enables elevated input. Windows background operation and locked-session operation are unavailable.

## The three version seams

1. **Renderer ↔ Main:** preload exposes the typed desktop API. A web page, remote engine or incompatible desktop cannot manufacture a local bridge or enable native capability.
2. **Main ↔ engine:** the authenticated loopback bridge and its versioned schemas carry the lease, current native phase, app permissions and bounded screenshots. The bridge URL/token pair is supplied only to the matching local engine at startup. Linux, WSL and remote engines receive no working local Hands bridge.
3. **Main ↔ helper:** protocol negotiation, helper manifest, platform/architecture and code identity are checked before serving. Windows Main additionally checks the SHA-256 compiled for the actual packaged helper architecture. Unknown or incompatible facts refuse; an environment variable at runtime cannot replace a compiled production pin.

Never add `computer` as a user or project top-level configuration key. Personal choices belong to the desktop store. The managed `computer` policy requires Vector 1.99.112 or later and may restrict, but never manufacture, user consent.

## Names and identities

User-facing names come from `packages/schema/src/hands.ts`. Internal tool, permission, IPC, file and configuration identifiers remain `computer`. Never put the feature's brand in those identifiers. In particular, do not rename helper bundle IDs or executable names: macOS grants attach to those stable bundle IDs, separately for prod, beta and dev. The native helper is not an Electron `.helper` child bundle.

## Safe local verification

Run one named test file at a time from its package, followed by that package's typecheck:

```sh
cd packages/desktop
bun test --only-failures --timeout 30000 src/main/computer-gate.test.ts
bun typecheck
```

The coordinator owns the single local Bun slot. Do not run tests from the repository root, use Turbo/full suites locally, start Electron, build/package Windows or macOS, or operate the owner's capture/input/clipboard/privacy settings as a substitute for CI. Engine focused tests need the executor's localhost permission for their preload. Node transport checks execute the compiled bundle with actual Node; Bun may compile it, but is not a replacement child transport runtime.

Native compilation, reproducibility, OS matrices, signing fixtures, Electron smokes and broad regression run on GitHub. Each result must identify its immutable commit and actual test report. A workflow's green optional step does not prove its assertions passed when `continue-on-error` is enabled.

## Native self-test layers

- **Unit:** deterministic tests over production codec, identity, policy, geometry, registry, cleanup and injected native seams. Source group counts are not execution evidence.
- **Required core:** version/probe, bounded protocol transcripts and actual EOF/parent-death lifecycle checks, with verified test-only callers. Test callers and targets are archived separately and never shipped.
- **Isolated privileged:** finite real native scenarios against the verified own test target. Missing grants, desktop availability or explicitly unsupported hardware prerequisites are reported as skips. A failed assertion is never converted into a missing-permission skip.
- **Packaged:** run the helper's version and packaged self-test from its final location after signature, manifest and architecture verification.

Exit codes are `0` pass, `1` failure, `2` invalid usage and `77` an explicitly reported unavailable prerequisite. Reports contain the fixed check catalog and bounded reason tokens; never upload screenshots, observed text, account identifiers or arbitrary native exception output.

Windows CI normally runs elevated. The verified caller must obtain and observe a real medium token for serving/input checks. The test elevation switch adds a refusal only; it cannot enable serving or replace actual token checks. Real UAC, hardware input and interactive multi-display checks remain owner-machine gates.

## Measured identity lock

`native/computer-helper/macos/identity.lock.json` is an enforced measurement of the reproducible **production ad-hoc** helper. It records helper version, full source digest, exact toolchain and per-slice cdhash. It is not a placeholder and is not interchangeable with a newly issued Developer ID signature or another channel's helper.

To update it:

1. Bump the helper version before changing already measured macOS inputs. The digest includes native sources, identity/blocklist generation, the native builder, channel IDs and icon. Consult the builder's actual digest function rather than guessing the input set.
2. Build twice with the pinned toolchain and require byte reproducibility, native units, required core and truthful isolated reports. Preserve unrelated platform failures explicitly.
3. Download candidate and report artifacts from that exact run. Independently verify artifact ZIP hashes and the raw candidate hash. Archive the exact source commit and recompute its digest with its own generator/builder and the measured toolchain.
4. Copy the measured raw candidate unchanged, retaining enforcement. Commit its immutable evidence/provenance and run the matching macOS/Windows matrix. A Windows-only diagnostic run cannot replace the macOS matrix.

Do not invent cdhashes, disable enforcement, accept a candidate after failed native assertions or change helper sources without accounting for an already accepted measurement. The latest accepted source measurement and pending matrix are recorded in the ledger.

## Packaging and signing order

Packaging first verifies the requested channel's actual helper files, manifest/source digest, architecture, Info.plist and icon. Correct prebuilt signed bytes must not be relabelled in place. A different channel requires its corresponding build.

On macOS, preserve a verified pre-sign baseline before any deep signing. Sign the helper with its own empty entitlements and hardened runtime. Restore that signature after an unsigned outer deep pass; finalize only the allowed signature-file changes and update the packaged manifest and sealed signing receipt before sealing the outer app. Certificate signing excludes the helper subtree from Electron's signer. Fuse handling must preserve the helper's own signature/entitlements and be followed by actual final verification. The pinned builder's fuse hook order and universal temporary-app behavior require explicit coverage; an `afterPack` check alone is not post-sign proof.

The receipt retains the original strict helper manifest and actual pre-sign cdhashes, and binds final hashes. Production provenance checks the enforced ad-hoc baseline; beta/dev additionally require their independently verified channel/source artifact and the measured version/toolchain. Final Developer ID checks require the actual outer seal, matching team, secure timestamp, runtime and empty helper entitlements. A standalone unsealed receipt cannot prove provenance.

On Windows, sign the verified helper bytes before compiling Main's architecture pins. Rewrite the manifest for those final bytes and exclude the helper from electron-builder's second signing pass. Final verification checks actual PE architecture, embedded `asInvoker`/`uiAccess=false`, Authenticode posture, manifest and compiled pin before executing packaged checks. Unsigned preview and signed release checks are distinct.

## CI and release boundaries

The reusable native workflow is `computer-helper.yml`, invoked through the registered `test.yml` dispatch. A normal native dispatch covers macOS and Windows; its explicit Windows-only diagnostic option preserves a concurrent macOS run and has narrower evidence.

The desktop release must restore the exact tested helper artifacts, verify them before signing/packaging, sign Windows helpers before pin compilation and verify each final package. A rerun must reuse the run's existing artifact bytes. See [RELEASE-WORKFLOW.md](./RELEASE-WORKFLOW.md) and the 1.99.112 owner checklist before release.

No build agent may substitute successful source tests for owner grant-persistence, clean-machine onboarding, real UAC, layout/hardware, lock/saver or multi-display evidence. Enabling Reset, releasing installers, changing legal pages and publishing approved release copy remain the concrete owner gates documented with the release checklist.
