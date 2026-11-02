# Contracts candidate: original Delivery Outbox sources

This publication preserves both completed original application archives and
separate current authored support supplements. No source bytes were normalized,
renamed, formatted or edited.

| Submission | Original app archive | Published app files | Separate support supplements | Exclusions |
| --- | ---: | ---: | ---: | ---: |
| [Vector first](vector-first/source) | 16 | 16 | 1 | 0 |
| [Codex first](codex-first/source) | 17 | 17 | 3 | 0 |

Every application path, including hidden runtime version pins, matches its
contemporaneous runner snapshot. All protected task/dependency files and authored
tests remain included. `-text` attributes preserve original whitespace and line
endings; source whitespace is not claimed clean. No blanket hidden-directory or
generated-directory filter was used.

## External authored support code

The [manifest](manifest.json) inventories support code separately beneath each
`supplemental-authored/support-data/` directory. It does not turn Vector's archive
into 17 files or Codex's archive into 20 files. These files lived outside the app
in the declared mutable data directory and were not protected by the immutable
application manifest.

Vector's supplement is `browser-check.mjs` (7,826 bytes). The separate manual audit
reports its current hash matches logged AddFile creation content, with no later
logged script patch. Codex's supplements are `browser-verify.mjs`,
`browser-races.mjs` and `browser-restart.mjs`. Their current hashes match the
reviewed copies, but simple creation-text extraction did not reproduce current
bytes and nested shell escaping was not decoded. That does not establish an
unlogged mutation. None of the four files authenticates historical executed
bytes or establishes successful browser checks. Their exact current bytes,
hashes, lengths and different provenance limits are retained.

## Original flags and separate manual dispositions

Both original runs remain `coordinator_review_required`, with automatic browser
audit `review_required`. Each independent functional gate passed 18 API and
8 browser checks, with app source and instrument unchanged. Each separate manual
disposition is `bounded_manual_review_no_clear_bypass_observed`. Those bounded
static/transcript reviews supplement unresolved external script paths without
rewriting original flags, source, settlement or charges. They do not establish
a hard execution fence or complete adherence.

The runtime task digest is
`a20b22b9e3f8c7d4768b5db5d19fb09e8f3b33efff64ccf49b7b895ee74d2ce7`,
distinct from source-only freeze digest
`1cf4a6d349f4b458a249266b82cb150139779ec7e45aa629bca275625562be17`.
The public instrument commit is `770dbe484ab2479f8ff41edc9b22a9f98c2a911f`.
Vector used product revision `a35c03d6a9bb16f16ec0187ad69c6c6420d10f19`;
Codex used its separately pinned CLI. Only the previously missing Codex arm was
continued under the immutable pre-Vector plan and unchanged pins. Neither arm
was rerun, repaired or refunded.

## Static verification and image scope

Run `python verify.py` from this directory. After repository-owner staging,
`python verify.py --git-index` also compares all 33 app files and four separate
supplements with their actual staged Git blobs and staged attributes. Preparation
does not claim staged or committed byte verification. The default check verifies
hashes, archive inventories, supplement separation, original flag/manual-review
lineage, pattern scans and effective `-text`; it starts no app or application
test and makes no provider call. Pattern scanning is bounded evidence.

For each runtime, both independent quality images are 390px end states: queued
and delivered. No independent desktop image was supplied. The authored desktop
PNG in manual-audit material is separate and is not substituted for those images.
The [pair report](../../results/contracts-outbox.md) records fixed source review
and cost evidence; the [three-task summary](../../results/contracts-stage-summary.md)
records the bounded stage decision. Gold/instrument publication is separate.
