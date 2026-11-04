# Desktop 1.99.112: preparation and publication checklist

Prepared on 28 October 2026 from `main` at `b3669a6b`. The owner authorized this
desktop release in the handoff. Desktop 1.99.112 was published from `main` at
`dfc98974` by release run #96, which completed on 30 October 2026 (UTC); see
[Publication result](#publication-result).

## Source and changes

The preparation bumps only the desktop version to 1.99.112, adds that version to
the unsigned release allowlist, and supplies the shared website/desktop changelog
entry. The required CLI remains 1.99.99. `publishedDesktopVersion` stayed at
1.99.111 until the new downloads and update feeds had been verified, and was
advanced to 1.99.112 in the publication change recorded below.

The candidate contains the approved release-112 merge: agent terminal/browser
controls, Deep research cleanup when memory is erased, explicit research keep
requests, Vector Local error reporting and retry, one Keychain read per macOS
launch, first-launch documentation, website account/privacy fixes, and test
reliability fixes. No Codium billing, new multi-agent phase, Hands or cloud GitHub
session implementation is included.

## Evidence checked

- `main` contains merge `b3669a6b` and the approved legal commit `4e7ce1ef`.
- General test runs [40768433585](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40768433585)
  and [40769076055](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40769076055)
  were still running when preparation started. Do not dispatch a duplicate merely
  because these notes previously asked to start CI.
- The 1.99.111 release workflow [40236084221](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40236084221)
  passed, including staging, account-gate checks, pointer publication and production
  download verification. Its GitHub release being a draft does not establish the
  status of Vector's separate downloads and updater storage.
- `production-release` still requires the owner's GitHub review. Its required
  review must be completed in GitHub; do not remove or bypass the protection.
- The current credential cannot list Actions variables (HTTP 403), so this session
  has not independently established the configured catalog fork revision.

## Before dispatch

1. Run the focused release metadata, changelog and web-copy checks. Run the
   pre-push typecheck without bypassing the hook. Push the reviewed preparation
   branch; keep its exact SHA in the release evidence.
2. Require green full general CI for the integrated source, including Linux and
   Windows engine shards. General CI does not include all desktop release tests;
   those also run in the release workflow under Node 24.
3. Land this preparation from a clean main checkout only, with no unrelated work
   or force push. Recheck the actual main SHA immediately before dispatch.
4. Confirm the reviewed catalog fork revision and that its prepared bytes equal
   `packages/web/public/models/api.json`. A mismatching mirror must be corrected
   through the reviewed fork process, never by weakening the release check.
5. Dispatch **Vector desktop release** (`vector-desktop-release.yml`) from `main`
   at that exact commit, with `tag=v1.99.112`, `allow_unsigned=true` and
   `prerelease=false`. Do not push a tag to publish. The owner approves the
   `production-release` environment in GitHub.

Do not change account settings, buy signing credentials, publish npm packages or
ship a later desktop version as part of this authorization.

## Publication verification

Record the workflow URL, attempt, source SHA and immutable catalog digest. Require
all platform builds, native checks, immutable artifact verification, production
account gate and publication checks to pass. If artifacts are named for the run
attempt, rerunning only publish cannot retrieve an earlier attempt's artifacts;
use the documented complete retry path.

Verify all six download targets and the four stable feeds (`latest.yml`,
`latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`) describe 1.99.112.
Only then update `publishedDesktopVersion`, remove this entry's `availability`,
advance the shipped-version copy fixtures, and regenerate the changelog. Preserve
the distinction between desktop publication and the separately published CLI.

## Publication result

Desktop 1.99.112 is published. The evidence below was read from GitHub's run, job
and log records. This sandbox cannot reach vectordev.ai or the release blob store,
so the download, account-gate and feed results are what the release workflow
verified in CI, not local fetches. No GitHub release entry is used as evidence:
since run #95 the workflow publishes only to Vector's own download store. Who
approved the `production-release` environment was not observed and is not
recorded here.

- Workflow: [Vector desktop release, run #96](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40781089625)
  (`40781089625`), attempt 1, `workflow_dispatch` from `main` at
  `dfc98974329f17c6814a923ac12ebe38b6673f38`, conclusion success. Inputs:
  `tag=v1.99.112`, `allow_unsigned=true`, `prerelease=false`.
- All 25 jobs of attempt 1 succeeded: release metadata validation, the release
  credential preflight, the immutable release catalog, the typecheck and test jobs
  (including desktop), the desktop and website smoke builds, the Linux, macOS and
  Windows desktop app builds, and the publish job.
- Publish job `123153528239`, "Publish release and update feeds", ran from
  2026-10-30T01:53:02Z to 01:58:55Z. Every step succeeded: download of the exact
  release catalog, immutable platform artifact digests, the verified macOS,
  Windows and Linux artifact downloads, asset validation and checksums, the model
  catalog published beside the installers, staging, the smoke test of the staged
  release, the stable downgrade guard, the production account gate, the commit of
  the download and update pointers, and "Verify committed release pointers and
  production downloads".
- That last step logged: "Verified committed stable desktop manifest"; "Verified
  committed" `releases/vector-updates/latest-mac.yml`, `latest.yml`,
  `latest-linux.yml` and `latest-linux-arm64.yml`; "Verified production account
  gate" for `mac-arm64`, `mac-x64`, `windows-x64`, `windows-arm64`, `linux-x64` and
  `linux-arm64`; and "Verified production API redirect for checksums". The step
  passes only when each committed pointer is byte-identical to the immutable
  staged `vector-v1.99.112` object and every staged and committed feed advertises
  `version: 1.99.112`.
- Catalog: the existing catalog was kept, as the owner chose. Catalog job
  `123143384093`, "Prepare one immutable release catalog", in the same run logged
  that it loaded the release catalog from the catalog fork at
  `52edfd113616e57761c70fd5d01ac578d645211c` with source and embedded SHA-256
  `a96b465110dd2fcc38e0dcca1a4115e12ea43ddaafdb0ebf587e15026767bf14`. The publish
  job only downloaded that catalog and ran with the same
  `VECTOR_RELEASE_CATALOG_SHA256`.
- General CI: [test run #313](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40781041233)
  (`40781041233`), a push on `main` at the same
  `dfc98974329f17c6814a923ac12ebe38b6673f38`, concluded success. All 15 jobs of
  attempt 1 succeeded, including the four Linux and six Windows engine shards,
  which run `local-fit.test.ts` with no platform skip, managed-policy case
  included. This is the fresh full Linux/Windows CI on the integrated candidate
  that the timer-fixture repair below required, and it supersedes runs
  40768433585 and 40769076055 listed under Evidence checked.

Site changes made after this verification, from a clean `main` at `dfc98974`:

- `publishedDesktopVersion` is 1.99.112, and the 1.99.112 entry no longer has an
  `availability` line. Its title and summary, the What's new text that shipped,
  are unchanged.
- The docs changelog lists 1.99.112's notes word for word, and the `release112`
  labels read "From desktop 1.99.112:".
- The shipped-version fixtures move on: `shipped` in
  `packages/web/test/release-copy.test.ts` and `lastShipped` in
  `test/no-project-wording.test.ts` are 1.99.112.
- Tests made stricter, beyond the 1.99.111 precedent: the release-copy stale
  patterns now also flag 1.99.111 and 1.99.112 called prepared or not published,
  as the 1.99.108 publication did; a new release-copy test requires the docs
  changelog to list the current download's notes word for word; and
  `docs-research-keep.test.ts` requires the 1.99.112 label to read as shipped.
- `bun scripts/build-changelog.ts` regenerated `public/changelog.json`
  (115 releases, newest v1.99.112) with no byte change, because the feed never
  carried `availability`.

Local checks on this change, run one file at a time after the last edit:
`packages/web/test/release-copy.test.ts` 11 passed, 1 skipped (the existing
dark-workspace condition), 0 failed; `packages/web/test/docs-research-keep.test.ts`
2 passed; `test/no-project-wording.test.ts` 2 passed; web `bun typecheck`
(`astro check`) 0 errors and 0 warnings. With 1.99.112 removed from the docs
changelog list and the `availability` line restored, three release-copy tests
failed as expected, and both files were then put back. The full typecheck runs in
the pre-push hook, and general CI runs `release-copy.test.ts` again. The site
deploys from `main`, so vectordev.ai shows 1.99.112 as published only after this
change lands there.

Not part of this publication: the npm CLI and the CLI that desktop requires stay
at 1.99.99, nothing was published to npm, and no 1.99.113 work is included. The
installers are unsigned. macOS and Windows installation and owner acceptance
still need real machines. The follow-ups below remain open, because 1.99.112
shipped the kept catalog.

## Remaining follow-ups

Restore the reviewed Codium OpenRouter entries through the catalog fork and
re-enable the skipped canonical catalog assertion once the committed mirror
contains them. Keep Deep research labelled Preview until its behavior/fit gates
pass. macOS/Windows installation and owner acceptance still require the relevant
machines; this cloud workspace is not evidence of those checks.

## General-CI timer fixture repair

Both general runs above failed in Windows engine shard 3 at the local-provider
stall test in `packages/engine/test/provider/local-fit.test.ts`. The failure waited
for the first streamed text chunk until the outer test timeout; a later coroutine
then tried to advance fake timers after cleanup had restored real timers. Related
following-test hangs are contamination evidence, not evidence that production
provider deadlines need to change.

That fixture combined large process-wide fake-clock jumps with real TCP traffic
and a child-process readiness watchdog. The test already skipped Linux because
those OS completion events could stop arriving after a clock jump. The repair
uses controlled in-memory fetch responses through the actual provider and SDK,
with bounded microtask readiness and explicit request cleanup before restoring
real timers. It removes the platform skip while retaining the exact 600,000 ms
header and 120,000 ms chunk boundaries, typed timeout errors, and the cloud path's
lack of those local defaults. Production provider code and deadlines are unchanged.

Local validation: engine `bun typecheck` passes. The full local-fit file reports
16 passed and 1 failed; the restored Linux stall case passes in approximately
490 ms. The remaining managed-private-server case fails the same way when run
alone on the unchanged `self-evolving` control tree, with the stall case filtered
out. Redirecting the temporary directory did not resolve that existing local
fixture failure. It is recorded separately rather than weakened or attributed to
the timer repair. Local socket tests require this workspace's network permission.

Require fresh full Linux/Windows CI on the integrated candidate, including the
managed-policy case. These local results do not establish Windows CI or desktop
publication.
