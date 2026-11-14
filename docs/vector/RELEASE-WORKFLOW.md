# Vector release workflow

Vector's canonical source repository is `scr1pter/claudeondfsfdaf`. The `main`
branch is connected to the production `vectordev-ai` project on Vercel.

## Publish source and website changes

1. Review the working tree and make sure local secrets, generated installers,
   and build output are not staged.
2. Run the relevant tests and the production web build.
3. Commit the reviewed source changes locally.
4. Obtain the owner's approval of the reviewed commit, then merge and push `main` to GitHub.
5. GitHub Actions verifies the web build, while Vercel automatically builds
   and deploys the same commit.
6. Confirm both checks succeeded before treating the release as complete.

Desktop installers use the separate release workflow in
`.github/workflows/vector-desktop-release.yml`; ordinary website pushes do not
rebuild every desktop installer.

## Publish matching release artifacts

Choose and approve the desktop and CLI release versions before preparing artifacts.
Set the desktop version in `packages/desktop/package.json` and record the exact
compatible standalone CLI version in its `vectorRequiredCliVersion`. Pass the CLI
version as `VECTOR_CLI_VERSION` to the CLI publisher. These versions may differ;
the desktop release verifies the recorded CLI manifest and all six Linux targets.

The plugin SDK `@vectordevai/plugin` is published with the CLI at the CLI's
version. The CLI publisher passes its selected version as `VECTOR_PLUGIN_VERSION`
to both compilation and plugin staging, so each CLI build installs the plugin SDK
published with it. The desktop engine instead embeds `vectorRequiredCliVersion` as
its plugin SDK version (`packages/engine/script/build-node.ts`; `VECTOR_PLUGIN_VERSION`
or `VECTOR_REQUIRED_CLI_VERSION` override it), and the desktop release requires
`@vectordevai/plugin` at that version, not at the desktop version. A desktop-only
release, such as desktop 1.99.100 with the CLI and plugin at 1.99.99, therefore
needs no npm publication. Plugin staging run on its own also defaults to
`vectorRequiredCliVersion`. Internal workspace manifest versions do not set the
public plugin artifact version.

1. Obtain the first-publication approval, build and verify the plugin package and
   its clean-consumer checks. Review public package licensing before publication.
2. Publish `@vectordevai/plugin`, then all CLI platform packages, then the
   `@vectordevai/cli` umbrella at that exact version. The CLI publisher performs
   this order and stops on plugin failure. Run it from an interactive terminal so
   npm can request two-factor authentication. A retry keeps the same version and
   skips packages already published.
3. Publish the reviewed catalog and standalone CLI archives with
   `.github/workflows/vector-cli-release.yml`. Prepare, immutable staging and
   channel activation are separate phases; reuse the reviewed version, commit,
   catalog digest and timestamp on retries. Verify every archive before activating
   its channel. See [standalone CLI releases](owner-actions/standalone-cli-release.md).
4. Verify packages can be installed from the registry and the required standalone
   CLI release is complete. Only then create the desktop release tag and run the
   desktop workflow. Its prepare job rejects absent or mismatched dependencies:
   the plugin and every CLI package must exist at `vectorRequiredCliVersion`. When
   that version is already published, a desktop-only release skips steps 1 to 3.
5. Confirm all platform installers, manifests and update channels before marking
   the release available. Follow the current `release-policy.json` and protected workflow
   gates for unsigned releases; do not infer publication authority from an earlier
   release's exception. The current unsigned preview path is download-only.

Container preparation uses the same verified musl archives and commit. Publishing
additionally requires the owner-controlled namespace and explicit enablement; see
[container registry](owner-actions/container-registry.md). The first public SDK
release has its own approval and clean-consumer check; see
[SDK publication](owner-actions/npm-sdk.md).

Update public release notes only with capabilities actually available in that
deployment. Keep candidate notes explicitly unversioned and unreleased until a
version is approved and its full matrix is verified. A website deployment alone
does not activate disabled account services or publish desktop/CLI artifacts.

After publication, install the verified macOS artifact over the previous app,
launch it, confirm its version and update channel, and check that existing local
sessions and settings remain available. Do not replace the user's app with a
development binary or claim Windows/Linux runtime validation from a Mac build.

The prototype workspace `@vectordevai/cli-dev` and its platform outputs are private;
they are never npm release artifacts.

## Vector Hands: unreleased desktop preparation

A Hands release must use the exact tested native helpers from the same release run. The reusable
native workflow validates its explicit prod/beta/dev channel; stable releases select
prod and beta releases select beta. Channel-specific source/identity verification
prevents relabeling a production helper. Artifact names carry the release tag and,
for nonproduction channels, its channel suffix, without a retry attempt number.
Restores bind the current repository, run, source commit, artifact id and digest;
incomplete or expired immutable artifact sets fail.

Before macOS signing, verify the reproducible production ad-hoc helper against its
measured lock. Beta/dev use independent channel source/identity evidence and require
the measured version/toolchain. Sign the copied helper with its own empty entitlements
and hardened runtime, exclude its subtree from Electron signing, and verify all final
bytes after fuse changes. The outer signature seals the source/final-byte receipt.
Developer ID changes the helper cdhash, so final certificate/team/provenance checks
replace comparison of that changed cdhash to the ad-hoc measurement.

On Windows, restore or create final signed helper copies before compiling Main's
architecture hashes. Never sign them again during the copy into an installer. Verify
the actual PE manifest, exact publisher Subject, final helper hashes and compiled pins
inside the actual packaged app.asar. A separate native Windows ARM64 job must execute
version/packaged checks on the same packaged proof bytes before publication. Linux
packages must have no resources/computer helper.

For review before publication, the release workflow supports an artifacts-only unsigned
dry run on the same repository's hands branch, with explicit dry_run and allow_unsigned
and the stable channel. It receives no production signing/feed credentials and cannot
publish a release, activate a channel, change tags or deploy the website. The version
and reviewed release metadata must still agree. Do not create a release tag merely to
run this preview.

See [Hands artifact details](build/hands-release-artifacts.md),
[engineering notes](VECTOR-HANDS.md), and the
[Hands owner checklist](owner-actions/hands-release.md) for source measurement,
CI evidence, real OS grant/hardware checks, Reset and final copy/legal approval.
Keep public availability on the previously published version until the actual release
passes those gates.
