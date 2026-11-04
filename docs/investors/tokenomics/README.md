# Vector tokenomics investor brief

Status: **preliminary scaffold**. Do not distribute the generated PDF as the final
investor report until the new benchmark round is closed and its contents reviewed.
This status belongs in this working README, not on the designed PDF pages.

The brief presents high-level product functions and measured benchmark outcomes.
It contains no proprietary source, algorithms, internal thresholds or architecture
schemas. The complete three-task comparison remains visible next to the headline.
Known material scope limits remain readable. Historical outcomes are retained in
the separate technical data file rather than pooled into a favorable headline.

## Build and review

Use the bundled Python runtime with `reportlab` and `pypdf`:

```text
python build_brief.py --data report-data.json --out <private-output-directory>/vector-tokenomics-brief.pdf
pdftoppm -r 120 -png <private-output-directory>/vector-tokenomics-brief.pdf <private-output-directory>/page
```

`requirements.txt` pins the authoring-library versions used for the preliminary
build. The report does not fetch any source, model, account data or remote asset.

The default font directory is the Windows standard font directory. `--font-dir`
can identify another directory containing `arial.ttf`, `arialbd.ttf` and
`ariali.ttf`. A missing licensed font fails instead of silently changing layout.

Render and inspect **every** page after a meaningful edit. The build validates
arithmetic, evidence scope and supported claims before rendering, then extracts
text from the written PDF to check page count and required evidence labels.

`report-data.json` is the investor-facing content and metric input.
`historical-audit.json` retains other experiment cohorts and their qualifications.
`build_brief.py` is reproducible document source, not application code.

## Optional completed follow-up

`additional_complete_study` is initially null. A later fully settled matched study
can add a fifth page with this object:

```json
{
  "status": "complete",
  "label": "Study name",
  "model": "exact matched model",
  "reasoning": "matched reasoning",
  "team_size_each": 7,
  "settlement_complete": true,
  "all_charges_retained": true,
  "quality_gate_met": false,
  "vector": {"cost_usd": "0.0000000", "requests": 1, "checks_passed": 1, "checks_total": 1},
  "codex": {"cost_usd": "0.0000000", "requests": 1, "checks_passed": 1, "checks_total": 1},
  "scope": "Readable scope and any material qualification.",
  "source_id": "E6"
}
```

This is a schema example, not benchmark evidence. Pending, partial or unsettled
episodes are rejected. A completed study that misses the quality gate is reported
neutrally; it cannot produce a quality-preserving savings claim. If new results
need more nuanced treatment, revise content and re-render instead of compressing
material information into an unreadable footnote.
