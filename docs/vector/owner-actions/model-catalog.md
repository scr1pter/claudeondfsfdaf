# Owner action: Vector model catalog and provider artwork

## Codium restoration merged (4 November 2026)

On 4 November the owner asked for the four restored Codium models to reach main. The Codium lineup is GPT-6.1 Sol,
GPT-6 Luna, Claude Haiku 5.5, DeepSeek V4.1 Flash 1017, Gemini 4 Argon and Kimi K3.1 Pro. Before this merge,
vectordev.ai/models and the immutable 1.99.111 and 1.99.112 release catalogs were byte-identical
(SHA-256 `a96b465110dd2fcc38e0dcca1a4115e12ea43ddaafdb0ebf587e15026767bf14`). They held Luna and Sol but not the other
four. The committed mirror is now the restored export below (`784309673addec67…`). Installed apps refresh from
vectordev.ai/models, so they get the four models once the web deploy serves it. The immutable 1.99.111 and 1.99.112
catalogs stay as published.

One release step remains. The next desktop or CLI release checks that vectordev.ai/models matches the catalog it
prepares from the fork pin, so set `VECTOR_CATALOG_FORK_REVISION=06e1cdd7b981c006291b938ad94f4dd6e40f61bd` before
preparing it. On 4 November the variable still held `52edfd113616e57761c70fd5d01ac578d645211c`, the 2 October pin
three commits behind. Keep the fork's `codium-112` branch, whose head is that revision, because the fork's default
branch `dev` does not contain it.

## Prepared Codium restoration (28 October 2026)

The `catalog-112` application branch restores the four OpenRouter entries missing
from the earlier reviewed fork export: DeepSeek V4.1 Flash 1017, Claude Haiku 5.5,
Kimi K3.1 Pro and Gemini 4 Argon. GPT-6 Luna and its price tiers were already
present. This restores the exact model facts and costs from the application's
reviewed 23 October snapshot at `bb2971e0bc10a43cc9b50f47950e48d4286cf92a`;
it does not claim a new live provider or ZDR audit.

Fork branch `codium-112` in `scr1pter/vector-model-catalog` now contains complete
lab records and override-only OpenRouter records. The merged source metadata
matches all four reviewed application records exactly. The fork's mandatory
validation passed, and two local web builds under Bun 1.3.14 produced identical
raw export bytes after frozen installation with lifecycle scripts disabled.
Semantic comparison found only the four additions; every existing provider and
model value is unchanged. No sync, inference, billing or deployment ran.

- Fork source revision: `d6c7d3eee3fd72ac8301574a9c9df12acb6d2e50`.
- Reviewed source/export revision: `06e1cdd7b981c006291b938ad94f4dd6e40f61bd`.
- Committed export: `vector/api.json`, SHA-256
  `850dd7f9ea8b55752d421c7582c9e137a55a9fbe936f66711f3039cbb3446c99`;
  5,313,020 bytes, 226 providers and 8,387 models.
- Prepared application mirror: 5,185,951 bytes, 219 supported providers and 8,188
  models, SHA-256
  `784309673addec6790370607fa73cdeb6d7cede19a2406b7c39d20de2183aaf3`.
- Import used `freshCatalog` against the clean, exact committed fork revision,
  preserving the existing provider and bundled-SDK allowlists. Semantic
  comparison again found only the four restored models.
- `bun test --timeout 30000 test/model-plan-catalog.test.ts` from `packages/web`
  passed all 26 tests and 100 assertions, including the restored canonical mirror
  regression test. Machine-readable provenance is in
  `docs/vector/build/catalog-112.provenance.json`.

**Release coordination remains required.** Do not merge or deploy this mirror
change independently of the release catalog decision. The previous fork pin and
current public mirror may still identify the older snapshot; a release prepared
from that pin will fail against a newly deployed mirror. Conversely, a release
using the restored export will fail while the public mirror still has old bytes.
Reading repository Actions variables returned `403 Resource not accessible by
integration` during preparation, so their current values have not been verified
or changed.

Before using the restoration in a release, the owner must review and retain the
fork commit on GitHub, check the actual release inputs, and coordinate these
steps:

1. If fork-based preparation is configured, set the nonsecret Actions variables
   `VECTOR_CATALOG_FORK_REPOSITORY=scr1pter/vector-model-catalog` and
   `VECTOR_CATALOG_FORK_REVISION=06e1cdd7b981c006291b938ad94f4dd6e40f61bd`.
   Do not change only one variable or use a moving branch as the revision. If
   both are intentionally unset, retain the documented desktop-only committed
   snapshot path and verify its application commit and digest instead.
2. Merge/deploy the application mirror only through the owner's approved release
   process, then verify both public aliases return the exact prepared bytes.
3. Use that same prepared digest for the reviewed candidate's binaries and
   immutable per-version catalog. Preserve old immutable catalogs; do not
   overwrite a published version or relax the mirror equality gate.

The preparation and test results below establish offline provenance only. They
do not establish a deployed mirror, changed release configuration, a published
installer or current upstream availability.

## Current state (2 October 2026)

The owner approved creation of the public [Vector catalog fork](https://github.com/scr1pter/vector-model-catalog). The reviewed release input is pinned to `690fd27d61c7a8acc5fd93aeda4f128d67d149fd`, including its committed `vector/api.json` and validated artwork. The complete MIT license remains in the fork and Vector's notices.

- Original data revision: `b4f2643a258f7c7a5eaa92367ac11d45414760c1`. Frozen dependencies were installed with lifecycle scripts disabled; the local web generator produced identical bytes twice. Local catalog validation passed. No sync, inference or deployment script generated this export.
- Raw export: 226 providers, 8,383 models, SHA-256 `fd4557276f60170ad7757d8ff13f26fe7131234688dd275044ad29bb3fa78799`. Its documented default omits 12 specialized decision records; the original generator also skips 33 broken aliases. No model data was invented to replace them.
- Vector's canonical release catalog: 219 supported providers, 8,184 models, 5,183,301 bytes, SHA-256 `a96b465110dd2fcc38e0dcca1a4115e12ea43ddaafdb0ebf587e15026767bf14`. Preparation reads only committed Git data from the pinned owner fork and applies the existing provider/SDK allowlists.
- Artwork: 206 supplied SVGs imported after validation. Four embedded-raster logos were converted into static paths preserving their visible source pixels; one editor comment was removed. The gate was not relaxed. Existing icons cover seven of the 14 absent fork logos. The remaining neutral fallbacks are `alibaba-token-plan-cn`, `cline-pass`, `crof`, `gmicloud`, `sakana`, `sarvam` and `vector`.
- The tracked static mirror `packages/web/public/models/api.json` contains these exact canonical bytes. Both public aliases must be verified after deploying this source. Immutable catalog publication and application artifacts remain separate release steps; preparing this input does not publish installers.

The existing standalone CLI workflow now has a `catalog` phase. It checks the reviewed application source, fork revision, origin and expected digest before using the existing protected Blob secret, publishes only the immutable per-version catalog, and verifies the returned bytes. It does not build archives, advance a channel or change the shared mirror. Dispatch it from the exact reviewed candidate commit using the same catalog digest that subsequent builds use.

The desktop workflow also supports an explicit committed-snapshot fallback when **both** Actions fork variables are unset and the immutable per-version mirror returns 404. It reads `packages/web/public/models/api.json` from the exact application `HEAD` Git blob, verifies that the bytes already form a prepared catalog, and records that application commit, path and digest alongside the artifact. Modified or untracked working-copy data is never used. A partial fork configuration fails; configured fork preparation remains pinned to its reviewed commit. Existing artifacts and immutable mirrors retain precedence. The same digest, bundled-SDK, provider-icon and public-mirror checks apply, and no external data-service fallback is added. The CLI's fresh catalog publication still requires the reviewed fork.

## Earlier interim mirror

The separate local desktop 1.99.91 build used a stale bundled catalog that stopped at gpt-5.5, and `https://vectordev.ai/models/api.json` returned 404, so signed-in ChatGPT users could not see gpt-6-astra, gpt-6-sol, gpt-6.1-sol or the gpt-5.6 family. Before the reviewed fork existed, an interim snapshot restored runtime discovery:

- Source: the Models.dev project's published `api.json`, downloaded on 2 October 2026 (MIT, attributed in `THIRD_PARTY_NOTICES.md`); source sha256 `9de50f94219793121deb6d1b6f6fc290433a82b70b7974459853d35d198ed61f`.
- Prepared with `catalogBody(text, true)` from `packages/engine/script/release-catalog.ts`, the same allowlist and bundled-SDK filtering a fork export gets: 219 providers, 8,184 models; prepared sha256 `b3477f4feb7bb439731ad20bad15772394c8a7dec65f527e8488648e5931ae8a`.
- Served as the static file `packages/web/public/models/api.json`. `vercel.json` rewrites `/models` to it, and `script/prune-vector-site.mjs` keeps the `models` folder. The Blob rewrites were removed because nothing was ever published there; restore them when `upload-model-catalog.ts --update-mirror` takes over, or that upload will be shadowed by this file.
- That separate local build used the snapshot as `VECTOR_RELEASE_CATALOG_PATH` with its sha256. The 1.99.99 cross-platform release still requires the owner-controlled fork and reviewed export below; the interim mirror does not establish that provenance.
- At runtime, catalog modes the bundled SDKs cannot send are not offered as models (`ModelCatalog.modeSupported`): the "pro" reasoning modes, the "ultrafast" tier, and priority or flex tiers the SDK drops for a model family it does not know (GPT-6 Fast). The served file keeps every mode so a build with a newer SDK can offer them.

Installed apps fetch the mirror at launch and every 60 minutes, so a refreshed file reaches them without a reinstall. Future updates must use the pinned fork process below, replace the static file with the same prepared bytes used for releases, and record the new digests here.

The interim mirror was verified in production on 2 October 2026 from source `c901d471f4fc32091bd98882b0a25af1316090c0`: both `/models` and `/models/api.json` returned HTTP 200 and the same canonical, committed snapshot with 219 providers. This verifies the runtime mirror only. It does not establish an owner-fork revision or publish an immutable 1.99.99 release catalog.

The fork, reviewed export and artwork are now prepared. Immutable release-catalog publication and matching application builds still need verification. Provider-specific artwork is preferred; missing artwork uses a neutral server icon drawn for Vector, never another provider's logo. No account, key or purchase was needed to create the fork. Fresh fork preparation fails if its configured checkout is missing; the desktop-only committed-snapshot case above does not relax that rule. The tools never fall back to the original live data service.

## Create and review the data repository

1. Maintain the existing public [Vector-controlled fork](https://github.com/scr1pter/vector-model-catalog) of the MIT-licensed [Models.dev data repository](https://github.com/anomalyco/models.dev). Its public visibility lets release workflows read data without an additional cross-repository credential.
2. Keep its complete MIT `LICENSE`. Vector's `THIRD_PARTY_NOTICES.md` also contains the original data/artwork attribution. Provider trademarks remain their owners' marks; review their usage guidelines before adding or changing artwork.
3. Review the fork's data and build scripts before running them. Generate the catalog from that fork's TOML files using its documented local build. At the reviewed layout, `bun install --frozen-lockfile --ignore-scripts` followed by `bun run --no-env-file build` in `packages/web` emits `dist/_api.json`. Confirm that output exists and the fork's build uses its local data; do not substitute a download from the original live service. Run its local `bun run --no-env-file validate` before committing an export.
4. Copy that generated JSON into `vector/api.json` inside the fork and commit it together with the data changes. The Vector release tooling deliberately reads this committed data export instead of executing the fork's code. Retain available provider artwork as `providers/<provider-id>/logo.svg`. Missing artwork may use Vector's neutral provider icon while retaining the provider's own display name. Do not replace missing providers with a misleading borrowed provider logo.
5. Record the fork's `OWNER/REPOSITORY` and full 40-character commit SHA. Confirm the repository is controlled by Vector. These are nonsecret provenance settings, not credentials. New providers still require a Vector code review and release because the provider and bundled-SDK allowlists remain enforced.

## Import the reviewed data and artwork

Clone the owner's fork normally, check out the recorded commit, and leave its tracked files clean. Set these values explicitly in your shell using the actual owner-selected repository and SHA:

```sh
export VECTOR_CATALOG_FORK_PATH="$(cd ../vector-model-catalog && pwd)"
export VECTOR_CATALOG_FORK_REPOSITORY="OWNER/vector-model-catalog"
export VECTOR_CATALOG_FORK_REVISION="FULL_40_CHARACTER_COMMIT_SHA"
export VECTOR_CATALOG_FILE="$PWD/tmp/release-catalog.json"
bun packages/engine/script/generate.ts --fresh-catalog
bun packages/ui/script/provider-catalog-icons.ts --import
```

The placeholder values must be replaced. Preparation verifies the checkout's origin and exact HEAD, rejects modified tracked files, and reads only regular committed blobs. It records the source export digest, fork repository/commit and prepared catalog digest alongside the output. SVG import rejects active or external content and validates all supplied artwork before writing any icons. Only an absent committed artwork file is optional: symlinks, malformed SVG, invalid text and other read errors still fail. Existing committed provider artwork remains available when the fork has no replacement.

Inspect and commit the imported SVGs and regenerated sprite/type inventory in the Vector application repository. Release CI checks that existing provider names and sprite symbols agree, requires the committed neutral fallback, and reports which providers use it. The neutral icon is an original Vector-drawn server glyph, not a provider mark. To regenerate the sprite from the existing committed artwork without importing or accessing a fork, run `bun packages/ui/script/provider-catalog-icons.ts --generate`. Icon fallback changes presentation only; the fork provenance, pinned catalog digest, supported-provider list and bundled-SDK checks remain mandatory.

For CLI and desktop builds, pass the same reviewed prepared file and digest:

```sh
export VECTOR_RELEASE_CATALOG_PATH="$VECTOR_CATALOG_FILE"
export VECTOR_RELEASE_CATALOG_SHA256="$(bun -e 'console.log(new Bun.CryptoHasher("sha256").update(await Bun.file(process.env.VECTOR_RELEASE_CATALOG_PATH).text()).digest("hex"))')"
```

These build inputs are separate from runtime `VECTOR_MODELS_PATH` and `VECTOR_MODELS_URL`. A release retry reuses its exact prepared artifact or immutable per-version mirror; it never silently regenerates it from a moving branch. For fork preparation, set repository Actions variables `VECTOR_CATALOG_FORK_REPOSITORY` and `VECTOR_CATALOG_FORK_REVISION` to the same reviewed values before the next new release. The workflow checks that exact commit out under its ignored temporary directory. Leaving both variables unset selects the desktop-only committed-snapshot fallback described above when no immutable mirror exists; setting only one fails.

## Publish and verify the mirror

The owner supplies `BLOB_READ_WRITE_TOKEN` in the approved server/release environment. Do not paste it into a command argument, Git, the app, a screenshot or a log. Set `VECTOR_RELEASE_VERSION` to the approved release version and `VECTOR_CATALOG_FILE` to the exact prepared file already used by the binaries.

```sh
bun packages/cloud/src/upload-model-catalog.ts --update-mirror
bun packages/engine/script/verify-catalog-mirror.ts
```

This first verifies or creates the immutable `releases/vector-v<version>/api.json`, then explicitly updates `models/api.json` with the same bytes. Re-running the uploader without `--update-mirror` only verifies/publishes the immutable release; an old release retry cannot silently roll the shared mirror back. Use `--update-mirror` only when that snapshot is the intended current catalog.

Today `/models/api.json` is the committed static file and `/models` is rewritten to it (see Current state above); the Blob rewrites this section was written for are removed. Until they are restored, the release workflow's `verify-catalog-mirror.ts` step will compare its uploaded catalog with the static file, so a CI release must ship the same bytes as `packages/web/public/models/api.json` or restore the Blob rewrites first. When restored, the rewrites need the corresponding website deployment before the public check can pass. The check requires HTTP 200, `application/json`, the same canonical catalog bytes at both URLs, supported provider identities and bundled SDKs. The release workflow runs it after mirror publication. No first publication or successful live response is claimed until this command passes against production.

Runtime defaults to `https://vectordev.ai/models`; the bundled snapshot remains available when a refresh fails. `VECTOR_DISABLE_MODELS_FETCH=1` disables refresh. `VECTOR_MODELS_PATH` selects a local file and makes no mirror requests. Operators may deliberately set `VECTOR_MODELS_URL` to an HTTP or HTTPS directory (or its `api.json` URL); Vector warns that this source is operator-maintained and records whether transport is encrypted. Embedded credentials, query strings, fragments and redirects are refused. Catalog shape and bundled-SDK checks apply equally to owned and custom mirrors. Custom mirrors cannot add executable adapters.

## Acceptance record

The fork URL, commit, imported artwork, fallback list and source/prepared digests are recorded above for release 1.99.99. Completion still requires the immutable Blob URL, production `/models` check output and matching CLI/desktop build provenance. Missing provider artwork alone does not block release. A runtime mirror update does not advance published application versions or replace immutable-catalog verification.
