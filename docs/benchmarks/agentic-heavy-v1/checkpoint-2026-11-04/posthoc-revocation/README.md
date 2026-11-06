# Posthoc held-body revocation diagnostic

A blinded source review raised an authorization timing concern. This separate diagnostic tests **both unchanged synthetic sources** with one matching HTTP schedule and controls. It is excluded from the original 76-row gate, formal repair feedback, paid costs and locked static review scores. It is not a new pre-registered holdout or a general comparison of the runtimes.

| Case | Vector delivered app | Codex interrupted app |
| --- | --- | --- |
| Held create, no revocation | 201; persisted | 201; persisted |
| Fresh create after completed revocation | 404; no write | 404; no write |
| Previously held create completed after revocation | 404; no write | **201; persisted** |

For the race case, the client sends headers and 60 of 61 body bytes, waits one second, completes an owner membership deletion (204), and completes a fresh rejected request (404) before sending the held request's final byte. It then verifies persistence as the owner. This establishes a stale-authority write in the Codex-generated interrupted app for this schedule. It does not establish that Codex generally generates insecure applications. Vector's denial is a useful observed control, not proof against every timing or endpoint.

No application dispatch or internal authorization checkpoint was instrumented. Event order records client delivery chronology; coarse timestamps alone are not treated as internal scheduling evidence. There was one race schedule per app, not repeated reliability or load testing. No application source, original gate or score was changed.

[Aggregate facts](facts.json) retain the chronology, positive/fresh-denial controls, unchanged original/copy source hashes and owned-process/port cleanup. [The executed test](held_body_revocation.py) is reusable with Python and Bun; its SHA256 is `b4f187697d14cf81b7d97fa9a1efea3d485560dd5adac3fc02ef9c4e008191b0`. It uses fresh synthetic accounts and private data folders; no browser, model, provider, company account or external service is involved. It needs no dependency installation or frontend build for these native Bun API routes.

From a checkout, supply absolute paths:

```text
python held_body_revocation.py --bun <bun-executable> --vector-source <checkpoint>/submissions/vector-delivery/source --codex-source <checkpoint>/submissions/codex-interrupted/source --out <new-private-directory>
```

The published files contain the test and safe facts only. Runtime cookies remain in memory. Executed source/app manifests are preserved byte-for-byte, including historical line endings. The generated app still needs further review before any production use.
