# Native binary identifier decision

**Status:** resolved by the owner's decision of 1 October 2026 (the last section). The first section is the historical record of the Part 1 development binary and no longer describes the release gate.

The final Part 1 macOS arm64 development binary has 16 case-insensitive byte matches for the former product name, zero UTF-16 matches, zero retired shared-key literals, zero checked borrowed OAuth-registration literals, and zero former-product host matches. Its SHA-256 is `3531514e590ab1b94d9e72cbebfbea40ebdf432ce5f1e01b5afb3397d54621a4`. The strict byte-level check therefore did **not** pass at the time, and no exception was assumed.

All 16 matches have identified origins:

| Matches | Origin                                     | Meaning                                                                 |
| ------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| 2       | Embedded third-party notices               | Required legal attribution; the brief permits legal text                |
| 13      | Monaco's editor-opening method identifiers | Internal editor API names, not product branding or network destinations |
| 1       | Bun's built-in package table               | Runtime dependency metadata, not a configured Vector service            |

The same 16 attributed matches existed in the prior reviewed native build. They were previously classified as dependency provenance, not eliminated. The new brief's literal byte rule is stricter than that previous classification. The agent asked the owner to choose between:

1. Permit these documented third-party identifiers alongside required legal attribution, while retaining the complete source/path guard, service-endpoint checks and borrowed-registration checks.
2. Expand the maintenance scope to reproducible Vector-owned runtime/editor changes that remove every non-license match. Do not patch compiled bytes or hide the name through string splitting/encoding. Keep upstream license notices intact, and verify editor navigation plus runtime/package behavior on every target after any maintained source changes.

Since the environment migration fix, `packages/core/src/flag/legacy.ts` imports `THIRD_PARTY_NOTICES.md` as text to derive the earlier product's environment prefix and default server username. The engine and TUI bundles therefore embed the notices text one more time, so the next audit will show extra "Embedded third-party notices" hits. They are expected legal-attribution hits, not new product identifiers.

The development artifact is not a published release or an installed replacement. Its final audit is recorded at `~/.cache/vector-rebuild-evidence/part1-binary-audit.json`, with exact occurrence attribution in `part1-final-native-attribution.json` beside it. Repeat the audit for each later release artifact. Until the 1 October decision below, the strict binary check was reported as unresolved rather than as complete removal.

## Automated release audit

`script/artifact-audit.ts` enforces this rule on every package a CLI or desktop release publishes, before it is uploaded or published:

- npm CLI: `packages/engine/script/publish-vector.ts` audits every `dist/vector-<target>` package and the `@vectordevai/cli` umbrella.
- Plugin: `packages/plugin/script/publish.ts` audits the staged `dist-publish` directory before `npm pack` or `npm publish`. `publish-vector.ts` runs it, so `@vectordevai/plugin` is audited before any CLI package is published.
- Standalone CLI: `packages/cloud/src/upload-cli-release.ts` audits the prepared `.tar.gz` and `.zip` archives (decompressed while streaming) after `prepare` and again before a separate `stage`.
- Desktop: `packages/desktop/scripts/verify-package.ts` (macOS `.app`) and `packages/desktop/scripts/verify-notices.ts` (Windows and Linux unpacked apps) audit each app, including `app.asar` and the bundled engine, before the release workflow uploads installers.

The standalone archives that `packages/engine/script/build.ts` uploads to GitHub Releases when `VECTOR_RELEASE` is set are audited right before that upload. The CLI archives are audited inside `packageCliRelease` (before any archive reaches the output directory) and `stageCliRelease` (before the first Blob upload). Both desktop scripts reach the audit through `verifyNotices`.

Not covered: `packages/sdk/js/script/publish.ts` and `packages/ui/script/publish.ts` do not run the audit. No release workflow and no CLI publish calls either of them; before publishing either package by hand, run the audit on its staged output (`dist-publish` for the SDK, the packed `.tgz` for the UI package).

The artifact audit allows one borrowed registration and rejects every other: the Codex CLI's public client, which Sign in with ChatGPT used from the owner's decision of 10 October 2026. The owner turned the sign-in off on 23 October 2026; `provider-policy.ts` still names the client, unused by default, until a release removes it. See [the decision record](chatgpt.md).

## Decision: both desktop identifier classes are allowed (1 October 2026)

The owner's rule is that the former name may appear only in license text and third-party code. Both desktop classes are third-party identifiers that contain the name by coincidence, so they are allowed in `script/artifact-audit.ts` like the Monaco and Bun entries: each matches only its exact identifier between non-identifier boundaries, is counted in the audit summary, and has a fixture test. The audit checks the identifier and its boundaries only: it does not check which file the match is in or what surrounds it. That is acceptable because the source guard (`packages/engine/test/compliance/upstream-free.test.ts`) keeps the name out of every tracked Vector file, so only third-party code can supply an exact match.

| Class     | Where it comes from                                                                                                             | Allowed form                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `node`    | Node.js `util.styleText` inside Electron's executable (`Electron Framework` on macOS, the main executable on Windows and Linux) | the local variable for the opening ANSI codes: the Monaco casing followed by `s` (in Electron it sits next to `closeCodes`) |
| `drizzle` | drizzle-orm 1.0.0-rc.2's no-op encoder export, carried by the engine bundle in `app.asar`                                       | `no` + the name with its third letter capitalised + `r`                                                                     |

Anything else that contains the name, in any casing or encoding, still fails the release. Desktop releases are no longer blocked by the audit; repeat the audit on every release artifact as before.
