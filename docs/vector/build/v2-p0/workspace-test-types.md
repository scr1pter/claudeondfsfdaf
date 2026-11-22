# WS-test-typecheck

## 2026-11-22

The workspace workflow ran five root gateway, account-deletion and site-publication test files, but its typecheck covered only `api/**`. The new `packages/cloud-workspaces/tsconfig.gateway-tests.json` explicitly includes those same five files and adds their existing Bun test types. Its workflow step runs separately from the unchanged hosted API project. It adds no dependency, workflow permission, trigger, deadline or runtime behavior.

The first check found two real errors in `test/site-publication.test.ts`: the publication table inferred arbitrary string arrays, so destructuring could yield `undefined`. The table now satisfies `[string, string][]`; fixture values and assertions are unchanged.

Local evidence on base `c515de62465db817ff309f4237023f9704fe7983`, with Bun 1.3.14 and matching frozen-lock dependencies:

- The new project initially failed with two TS2345 errors in the publication fixture, then passed after the tuple fix.
- A temporary invalid `Bun.build` target in the actual gateway Node test passed the unchanged API project but failed the new project with TS2322. Restoring the original test made the new project pass. The restored file was byte-identical.
- Commands ran from `packages/cloud-workspaces`: `bun typecheck --project ../../tsconfig.json` and `bun typecheck --project tsconfig.gateway-tests.json`.
- The five existing runtime files passed individually: gateway API 28, actual Node import/worker refusal 2, deletion API 8, account deletion 47, and publication 3. The existing real-Valkey case was skipped because no test Redis URL was configured.
- The local managed environment lost the successful Node child's stdout despite exit 0. Reusing the existing scratch pipe harness restored real POSIX stdout/stderr forwarding to the same unmodified Node 24.19.0 executable, and both unchanged Node tests passed. This local harness is not part of the candidate.

This project covers the five test files already selected by the workspace workflow. Other root test suites keep their existing coverage; this does not enable cloud workspaces or change any feature flag.
