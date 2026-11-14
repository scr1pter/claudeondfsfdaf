# Offline request-footprint evidence

The four manual jobs in
[run 40795116370](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40795116370)
passed on source and harness revision
`09cf9fa01c5be66de901e657bc7cf1d095fdaa6e`. Each ran two independent
`solo-fix` fixture sessions with the judge explicitly off. All eight sessions
exited successfully, consumed every scripted step, reported no script errors,
and passed the fixture's three invoice tests. Each session sent five parent
requests and zero subagent, side, or cache-warmup requests.

This runs Vector's source CLI under Bun 1.3.14 on Linux CI, not the packaged
desktop or published CLI. The harness uses isolated synthetic homes, clean child
environments, synthetic keys, and loopback fake providers. No live model calls
or other coding CLIs are used. The fake providers replay the same tool script;
they do not assess model decisions or answer quality.

| API | Size | Requests per session | Request UTF-8 bytes per session | Estimated input tokens per session |
| --- | --- | ---: | ---: | ---: |
| Messages | Standard | 5 | 208,159 | 51,720 |
| Messages | Thorough | 5 | 271,359 | 67,450 |
| Responses | Standard | 5 | 200,685 | 49,838 |
| Responses | Thorough | 5 | 260,475 | 64,783 |

The displayed values were identical in both sessions of each job. Bytes are
recorded request-body sizes; input tokens are the harness's characters/4
estimates, not provider tokenizer counts. Messages uses the fake
`claude-sonnet-4-5` model; Responses uses fake `gpt-6.1-sol`. Compare request
footprints within an API, not provider prices across APIs.

The modes include their existing reasoning policies as well as different
instructions and advertised tools. Selected controls from all 40 request bodies
are preserved in `request-controls.json`:

| API | Standard controls | Thorough controls |
| --- | --- | --- |
| Messages | No `thinking` field; `max_tokens: 32000` | `thinking.type: enabled`, `budget_tokens: 16000`; `max_tokens: 48000` |
| Responses | `reasoning.effort: medium`, `summary: auto` | `reasoning.effort: high`, `summary: auto` |

No reasoning default was changed for this capture. This comparison cannot
isolate the effect of a single prompt edit or establish that one effort level
is cheaper on real work.

The four JSON files preserve each complete emitted report, including both
sessions, request estimates, tool-definition sizes, validity checks, and source
metadata. Their capture wrappers identify the exact successful job and artifact
digest. Downloaded archive SHA-256 digests matched GitHub's recorded digests;
their embedded reports matched the job-log reports. `request-controls.json`
contains selected body fields and individual payload-file hashes, not full
request payloads. Full synthetic payloads remain in the linked run's artifacts.

| Report | Successful job |
| --- | --- |
| `messages-standard.json` | [123189691615](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40795116370/job/123189691615) |
| `messages-thorough.json` | [123189691452](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40795116370/job/123189691452) |
| `responses-standard.json` | [123189691599](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40795116370/job/123189691599) |
| `responses-thorough.json` | [123189691457](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40795116370/job/123189691457) |

Cache-read, cache-write, dollar, and uncached-dollar fields in the raw reports
are simulations at frozen rates. They do not measure live cache routing, TTL,
charged tokens, or cost savings. Runtime timings and sampled RSS describe this
source fixture, not desktop performance or a release memory baseline. These
results certify the four completed footprint jobs, not every general CI job.

The workflow's `offline_footprint` input defaults off. Its matrix runs the source
command below once for each runtime (`vector`, `vector-openai`) and size
(`standard`, `thorough`), preserving reports in job logs and artifacts:

```sh
bun script/agent-eval/footprint.ts --engine-root "$GITHUB_WORKSPACE" \
  --runtime "$FOOTPRINT_RUNTIME" --scenario solo-fix --sessions 2 \
  --task-size "$FOOTPRINT_TASK_SIZE" --judge off --openai-model gpt-6.1-sol \
  --out "$FOOTPRINT_DIR/report.json" --dump "$FOOTPRINT_DIR/requests"
```

This capture supplies the audit's free request-footprint evidence. Live cache
and quality checks, transport rollout, and release memory profiling retain their
separate evidence gates.
