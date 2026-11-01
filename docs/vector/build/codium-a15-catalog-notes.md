# A15 staged catalog and provider evidence

This is the A15 implementation/evidence record based on P2 at `d04a2808`. Independent static review is closed with no remaining confirmed A15 blocker. Local tests and typechecks passed; canonical push and CI are pending. No provider request, account setting, deployment, model inference or sales change was performed. Source implementation is separate from provider acceptance.

**30 Oct (C-SOL):** Terra, Astra and Astra Long are out (`codium-tiers-v3-changes.md` §8). The staged catalog now holds 15 candidates, `CODIUM_CATALOG_UPDATED` is `2026-10-30`, and the default audit target is the October 30 manifest. The Terra and Astra items below, including the outstanding acceptance list, are historical; current state is in [codium-csol-models-notes.md](codium-csol-models-notes.md).

## Local validation

The serial batches passed 138 unique test cases across six files:

| File                              | Passing cases |
| --------------------------------- | ------------: |
| `model-plan-entitlements.test.ts` |            66 |
| `model-plan-catalog.test.ts`      |            40 |
| `model-plans.test.ts`             |            19 |
| `model-plan-context.test.ts`      |             6 |
| `model-plan-models-api.test.ts`   |             4 |
| `model-plan-status-api.test.ts`   |             3 |

The audit file retains one pre-existing skipped release-mirror test; that skip is not provider acceptance. The API typecheck passed. Web Astro passed with 0 errors, 0 warnings and 105 hints across 188 files. Its initial pass found a readonly expected tuple in the new entitlement test; copying that tuple into the matcher fixed the test typing without changing runtime code. The affected 66 cases and Astro then passed again.

Tests ran individually with a 30-second timeout through `vector-serial` and isolated temporary XDG directories. All processes exited before releasing the shared Bun slot. The active five-model definitions and captured October 23 bytes were independently compared with the base revision and remain unchanged; the manifest's date and digest match those bytes.

## Active and staged catalogs

`CODIUM_MODELS` and the default `configuredPlanModels()` retain the existing five-model runtime catalog. `CODIUM_RUNTIME_CATALOG_UPDATED` remains `2026-10-23`, including the existing public configuration date. This change does not activate new models or replace the release catalog mirror/pins.

`CODIUM_TIER_MODELS` holds 18 owner-contract candidates. Explicit `configuredPlanModels({tiered:true})` selects them for the staged schema/helpers and offline audit. `CODIUM_CATALOG_UPDATED=2026-10-27` identifies the contract target, not a provider capture. Plus includes DeepSeek, Haiku, Luna and optional/manual Terra; Pro adds Sol, Kimi and Argon; Max adds Sonnet and Astra; Ultra adds Opus and Astra Long. The remaining candidates are the contract's long-context, fast and Sol effort variants. This records the owner handoff's model choices without claiming newly verified routes.

The staged configuration supports `upstream`, `minPlan`, `previewUntil`, `providerOnly`, per-tier contexts, the Astra in-flight group, `manualOnly`, lab and weight. Variant IDs resolve to an explicit upstream model. Context/access and request-credit helpers use these fields; admission/routing integration and listing remain in their later work packages. Terra, Astra, long-context entries and fast lanes stay manual-only in the staged definitions. Roles/judges/review pairs follow §4.12 and do not make these candidates active.

The deterministic public weight is an equal-input/output-token price blend, relative to DeepSeek's public routing ceilings:

`weight = (inputPrice + outputPrice) / (0.3 + 1.2)`

DeepSeek therefore has weight 1, including its long variant. Every other weight uses that candidate's configured public input/output ceilings. This is a price ratio, not a performance score, observed workload mix or private allowance calculation. It reveals no included credit amount.

## Captured evidence and its limits

The sole committed raw Codium provider capture is [the October 23 fixture](../../../packages/web/test/fixtures/codium-endpoints-2026-10-23.json), added at `cf06809ddd70d2a47e805e34245040d03359b1b9`. Its 14,414 bytes have SHA-256 `3c37e89169bc4ccb0a4792f5bbb65ce97340731fcf1dcf6018ee95d7805889e0`; the original file remains unchanged. Its `sources` identifies OpenRouter's public `/models` and `/endpoints/zdr` metadata.

| Captured model           | Exact captured ZDR endpoint tag |
| ------------------------ | ------------------------------- |
| DeepSeek V4.1 Flash 1017 | `nebius/fp8`                    |
| Claude Haiku 5.5         | `amazon-bedrock`                |
| GPT-6 Luna               | `azure`                         |
| Kimi K3.1 Pro            | `moonshotai/mxfp4`              |
| Gemini 4 Argon           | `google-vertex/global`          |

The raw `models[]` records contain model context, parameter support and model-level `reasoning.supported_efforts`. The `endpoints[]` records contain exact `model_id`/`tag`, endpoint limits, pricing and price overrides, parameter support and tool-choice capabilities. These are historical observations. They do not establish current availability or a provider's acceptance of every request field.

The new [October 27 target manifest](../../../packages/web/test/fixtures/codium-endpoints-2026-10-27.json) references those unchanged October 23 bytes. It explicitly retains `capturedAt=2026-10-23`, the digest, an empty `providerEfforts` list and the missing-evidence list. It does not invent new raw endpoint records or label planned values as captured data.

The catalog fork export `06e1cdd7b981c006291b938ad94f4dd6e40f61bd`, `vector/api.json`, contains general OpenRouter metadata for Sol, Astra, Sonnet and Opus under `openrouter.models[modelId]`. Their generic context/cost/effort fields do not include ZDR endpoint tags or regional route prices. GPT-6.1 Terra is absent. The fork's provenance expressly describes restored older metadata, not a fresh ZDR audit; it cannot replace the missing provider capture.

## Offline audit

From `packages/web`, `bun scripts/model-plan-catalog.ts` reads the committed target manifest and audits the staged candidates. `--snapshot <path>` accepts either a captured raw snapshot or a manifest. No command branch fetches public metadata or probes a model. The manifest must name a sibling JSON file; its raw digest and actual capture date are checked before audit. Output separates capture and target dates and preserves the unresolved evidence list.

The audit matches `upstream ?? id`, requires both model and endpoint context to cover the largest base/per-tier window, and checks endpoint output/quantization/options/cache pricing. An explicit prompt cap is the actual-token exclusion bound for pricing overrides; the estimated context window cannot narrow it. Without an explicit cap, the largest base/per-tier context determines which overrides remain reachable. `providerOnly` intersects exact tags from the captured ZDR endpoint set; a provider name or tag prefix cannot qualify another route.

For `xhigh` or `max`, a generic `reasoning` parameter or model-level effort list does not prove support on the selected endpoint. Qualification requires a separate reviewed evidence entry with exact upstream model, exact tag, permitted efforts, a source and a valid nonfuture capture date. Those entries are audit evidence, not invented OpenRouter API fields. None is supplied by this manifest.

The default staged audit **remains blocked**, as asserted by the passing offline command test, because the available capture lacks the five new base models and two fast-lane routes, as well as exact provider effort evidence. The existing five-model October 23 regression passes as a separate baseline. The release-mirror test/pins are not changed to make a staged candidate pass.

## Outstanding acceptance

- Capture public raw model and exact ZDR endpoint evidence for Terra, Sol, Sonnet, Astra and Opus, including regional prompt/completion/cache prices and limits.
- Capture the exact `moonshotai/highspeed` and `google-vertex/global/priority` routes and their price/parameter evidence.
- Establish exact-provider Sol `xhigh`/`max` support separately; complete the contract's approved provider acceptance for `provider.only` tags with ZDR and fallback disabled.
- Recheck Astra's routes during release week. Generic fork metadata and narrative planning assertions do not close this gate.
- Validate 768K requests against the gateway's 4.5 MB body limit and 600-second deployment deadline in the approved environment; apply the contract's 512K fallback if acceptance fails.
- During A17 admission acceptance, validate advertised windows against the existing four-byte token estimate and actual prompt bounds. The unchanged no-explicit-cap path is an estimate, not proof of a provider tokenizer's exact input length.
- Complete the later admission/routing, client, listing and launch work packages before enabling the staged candidates or sales.

These are evidence and launch gates, not authorization to call a provider or deploy during A15 implementation. Tests use captured metadata or explicit synthetic fixtures; the local results above do not certify real provider acceptance.
