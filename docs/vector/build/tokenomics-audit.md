# Did the Oct 10-11 tokenomics work get done?

**How to read this.** All paths are relative to `main/`, the shipped code (commit 6eaf445a = desktop 1.99.111). Engine paths start with `packages/engine/src/` unless a longer path is given. Three sources are shortened:
- **Live archive**: `docs/benchmarks/vector-codex-2026-10/`. Real model calls, Oct 7-10.
- **Offline archive**: `docs/benchmarks/vector-efficiency-2026-10/`. Scripted replays, Oct 11-16.
- **eff-diagnosis.json**: `docs/vector/handoff-2026-10/eff-diagnosis.json`. Written Oct 10, committed Oct 24.

I only read files and git history. I ran nothing.

**Terms used below**
- **Token**: a small chunk of text, about 4 characters. AI providers bill by the token.
- **Prompt cache**: if the start of a request matches one the provider saw recently, those tokens are billed cheaply. On gpt-6.1-sol that is $0.10 per million instead of $2 per million.
- **Cold request**: a request where nothing is cached, so every token is billed at full price.
- **Prefix**: the fixed start of every request, meaning the instructions plus the tool descriptions.
- **Live run**: real model calls. The dollar figures are "API-equivalent", meaning what the run would cost at API prices. They are not bills (live archive `summary.json:155`).
- **Offline run**: a scripted replay against a fake model server on the Mac. It can count bytes and estimate tokens. It cannot show real caching, real AI behaviour or real speed.
- **WebSocket continuation**: keeping one connection open and sending only the new messages. The normal HTTP way re-sends the whole conversation on every turn.

## 1. Short answer

Yes, the work was done in code. Nearly every recommendation from the Oct 10-11 data was built, and all 57 commits cited for it are in shipped 1.99.111.

None of it has been proven with real model calls. Every "after" number is an offline replay, and `script/agent-eval/live-efficiency.md:3` says "No paid model calls were made during this integration."

The two biggest fixes mostly work only when you sign in with ChatGPT, and 1.99.111 turns that sign-in off (`packages/core/src/provider-policy.ts:20`). Those two fixes are a fixed instructions block that the provider can cache across sessions, and WebSocket continuation. People who use an API key get neither by default.

What's left:
- Three ideas were never built.
- Two later changes have partly undone earlier savings.
- The live gap against Codex has never been measured again.

## 2. What the data found

### Live runs (real model calls, Oct 7-10)

**Setup.** Vector d3ae064a against Codex CLI 0.162.0-alpha.2, both on gpt-6.1-sol at medium effort. Prices were $2 / $0.10 / $10 per million tokens (uncached input / cached input / output). Benchmarking was stopped at your request (live archive `README.md:3`).

**First round.** Both passed 9 of 9, but Codex won on every measure (`summary.json:7-69`, `:35`, `:64`):

| | Codex | Vector |
|---|---|---|
| Median time | 17.596 s | 36.43 s |
| Total cost | $0.2685372 | $0.4486732 |
| Memory | 243.625 MiB | 964.046875 MiB |

**Vector's cost compared with Codex, round by round** (eff-diagnosis.json:3 and `data/round4.metrics.json`):
- R0: +67%
- R1: +25.6% ($0.3502 vs $0.2788)
- R2: +16.4% ($0.6126 vs $0.5261)
- R3: 1.52x on the original tasks. That is worse than R2, and Vector's own R3 cost rose 29% for a reason nobody found.
- R4: between 0.7965x and 1.3972x per test cell. 5 of 9 cells were above Codex, and none passed the 15% gate.

The archive's verdict: "No decisive general speed or cost advantage over Codex has been established" (`summary.json:6`).

**The main cause is that Vector's first request was cold.**
- Vector's first request read 0 cached tokens in 20 of 27 runs, 4,864 in 6 runs and 8,576 in 1.
- Codex read 12,288 cached tokens on 27 of 27 runs.
- Source: `data/patched-vs-codex.metrics.json` and `data/next-efficiency.metrics.json`, at `runs.retained[...]`, fields `cacheReadTokens` / `cached_input_tokens`.
- In the 9 R1 runs, the first requests made up 61,263 of Vector's 118,182 uncached input tokens (52%). The file records this as "about $0.117 at $2/M" (eff-diagnosis.json:62). Note that 61,263 × $2/M works out to $0.1225. I kept the recorded figure, and the difference is unexplained.

**So the problem is uncached tokens, not total tokens.**
- In R1, Vector used 32.71% fewer tokens in total but cost 25.60% more (`patched-vs-codex.metrics.json`, `vectorRelativeToCodexPercent`).
- The share of input that came from the cache was 0.7342492860515841 for Vector and 0.8731994513754544 for Codex.
- The diagnosis estimates that if Vector reused its whole fixed prefix, it would be 14-29% cheaper than Codex ($0.241 vs $0.279; $0.376 vs $0.526). That is modelled from live data, not measured (eff-diagnosis.json:3).

**Smaller causes, all from live runs:**
- **Edit, then a separate request to check it:** +0.67 requests per run (4.89 vs 4.22; 4.83 vs 4.17). That is $0.0036-0.0041 and about 2.8-3.2 s per run (eff-diagnosis.json:20-21).
- **Wordier replies:** the final message was 86-89 tokens against Codex's 61-62. Text written before tool calls cost 0.9-1.4 s per run (eff-diagnosis.json:14).
- **Unneeded to-do lists:** a Vector-only test that removed unneeded to-do tracking passed 9 of 9 (`data/improvement-ab.metrics.json`):
  - provider steps: 64 → 44
  - tokens: 659,321 → 452,729
  - cost: $0.419522 → $0.3850436
  - median time: 38.494 → 23.86 s
- **Separate title request:** about $0.0014 per run. This is an estimate (eff-diagnosis.json:28).
- **Slow start:** +0.5-0.8 s median, with 5-13 s outliers in 5 of 27 runs (eff-diagnosis.json:35).
- **One stall:** a single step lost about 174 s (`data/next-efficiency.metrics.json`, `longTailObservation`, `wallMs` 201141).
- **Shorter system prompt:** it cut input tokens by 10.5% to 17.1% over 4 live rounds. The behaviour test never reached 18 of 18: the new prompt scored 15, 16, 17 and 15, and the old prompt scored 12, 16, 14 and 14 (`data/round4.metrics.json`, `behavior-evaluation-v{4,7,9,12}`).

### Offline studies (fake model server)

**Diagnosis (Oct 10).** Vector's request bytes stay stable from one request to the next, so they are not the problem. The gap comes from three things: the cold first request, re-sending the whole conversation over HTTP, and request routing (eff-diagnosis.json:58). On the Anthropic API, Vector was about 2.9x lighter than Claude Code on one task: 51,521 vs 151,464 tokens, $0.0557 vs $0.1533.

**After the fixes (Oct 11).** 216 test cells, 1,890 requests, and 144 of 144 checks passed (offline archive `manifest.json` `$.auditCounts`):
- One title request was removed from each headless task: 816 → 768 requests (`README.md:15`). "Headless" means `vector run` with no app window.
- Request size on a warm solo task (`summary.json` `$.cells[1,3,33,35]`):
  - Messages API: 207,361 → 193,909 B, modelled cost $0.023459 → $0.020625
  - Responses API: 204,151 → 190,197 B, modelled cost $0.012924 → $0.010985
- WebSocket long task: 53.0% fewer bytes sent (`README.md:87-90`).
- Peak memory went up, from 573 to 720 MiB (`README.md:32-35`).

**Follow-up (Oct 15).** Each main request carried 158-159 fewer estimated tokens (`README.md:174`).

**Subagent study (Oct 16).** The new subagent controls raised the modelled cost of a cold start by 8.2-10.1% (`docs/benchmarks/vector-subagents-2026-10/README.md:39`). That README also says "No result here supports a live cheaper/faster claim" (`:41`).

The offline archive itself says the live archive "remains unfavorable to Vector; this work does not supersede it" (`README.md:3`).

## 3. Done: in shipped 1.99.111

1. **Fixed instructions block that can be cached across sessions** (647de0ae, 020f2217).
   - Where: `session/llm/request.ts:64`, `:77`, `:125-128`.
   - Measured: offline model only, which predicted $0.2777 → $0.1890 (-31.9%) in the 647de0ae commit message. Never measured live.
   - It does nothing in 1.99.111. It only applies to ChatGPT sign-in, which is off, and to Anthropic-style models. On OpenAI with an API key the prompt stays one block (`request.ts:78`; `provider/transform.ts:456-467`).

2. **Per-session cache routing key, `prompt_cache_key`** (restored in e05a6c8d; the earlier removal never shipped).
   - Where: `provider/transform.ts:1172-1181`.
   - Measured: no. The on/off comparison never ran (offline `README.md:134`).

3. **WebSocket continuation** (bcf3ff6c).
   - Where: `plugin/openai/continuation.ts:20-44`; `plugin/index.ts:62-70`.
   - Measured offline: 564,523 → 265,248 B (-53.0%) on a long task, but modelled cost only $0.029921 → $0.028023 (`README.md:87`).
   - It is on by default only for sign-in. Release builds are the "prod" channel (`.github/workflows/vector-desktop-release.yml:480`), so API-key users stay on HTTP.

4. **Date fixed per session, so the prompt doesn't change at midnight** (646475b6).
   - Where: `session/system.ts:291`; `session/prompt.ts:2562`; `session/reminders.ts:20-42`.
   - Measured: no. The effect is small.

5. **Shorter descriptions for the bash, to-do and task tools** (6e2a7b4f, e1062861).
   - Where: `tool/shell/prompt.ts` (10,791 B, unchanged since); `tool/todowrite.txt`.
   - Measured offline: bash 1,288 → 940 and task 2,007 → 1,685 estimated tokens (`raw/baseline-http-1.json` vs `raw/integrated-http-1.json`). The task description later grew back (see section 5).

6. **Repeated wording removed from the grep, read, skill and webfetch descriptions** (4110a1b41, 2d8e04241).
   - Measured offline: 158-159 fewer tokens per request and 1.6-2.8% fewer bytes. Two Responses-API cells cost 1.0% and 2.1% more (`README.md:174`).

7. **Shorter GPT system prompt** (6e2a7b4f; `session/prompt/gpt.txt` went from 114 to 38 lines).
   - Measured live, on the candidate prompt: 10.5% to 17.1% less input.
   - The behaviour test never passed 18 of 18. The recorded 15/18 against the old 14/18 is still the latest result (`live-efficiency.md:134`; `README.md:136`).

8. **Repetitive edits done with a script instead of hand-written patches** (6e2a7b4f).
   - Where: `gpt.txt:14-15`; `tool/shell.txt:9`; `tool/apply_patch.txt:1`.
   - Measured live, but only for a patch made before this release. On the refactor task, median output was 813 tokens vs Codex's 510; before that patch it was 1,998 vs 521. The shipped wording was not measured.

9. **Shorter final replies, plus "low verbosity" for gpt-6 models** (24ab62ea, 6e2a7b4f).
   - Where: `gpt.txt:38`; `session/prompt/anthropic.txt:22`; `provider/transform.ts:1247-1257`.
   - Measured: no.

10. **An edit and its check can go in one response** (6ddf4849, 61cb661f).
    - Where: `session/llm/tool-order.ts:7-52`; `session/llm.ts:431`, `:461`; `session/system.ts:203`.
    - Measured: no. The offline replay cannot show this (`README.md:197`).

11. **Fewer to-do lists** (6e2a7b4f).
    - Where: `tool/todowrite.txt:3`.
    - Measured live in round 1, on old code. A later instruction now pushes the other way (see section 5).

12. **Session titles no longer slow the first answer** (56d9169e, 0077219f). A temporary title is set right away. The model title waits until the answer starts, and headless `vector run` skips it.
    - Where: `session/prompt.ts:474-475`; `cli/cmd/run.ts:646-654`.
    - Measured offline: 816 → 768 requests.
    - The desktop app still sends one title request per new session (`packages/app/src/components/prompt-input/submit.ts:912-915`).
    - The published CLI is still 1.99.99 (`packages/desktop/package.json:6`; `docs/vector/owner-actions/release-199111.md:5`), which is older than the headless fix. So no user gets this saving yet.

13. **Prompt sent exactly as typed, without added quote marks** (d11c951f).
    - Where: `cli/cmd/run.ts:409`, `:424-431`.
    - Checked offline on the wire (`README.md:156`). The token effect is negligible.

14. **Faster startup.** It opens the connection early, finishes as soon as the stream ends, defers file snapshots and loads the model catalog only when needed (6aab9aab, 3f60de0a, 8fac0341, be77706c, 54e64107).
    - Where: `provider/provider.ts:404-411`, `:2837-2846`, `:1858-1877`; `provider/response-terminal.ts:17-68`; `session/processor.ts:137-170`.
    - Measured offline: first request 4.00 → 1.58 s and whole task 7.44 → 3.02 s (`README.md:33`). The archive refuses to call this a speed result (`:115`).
    - The early connection does nothing in the desktop app, which runs the engine under Node (`packages/desktop/src/main/server.ts:101`). With sign-in it warms the wrong server.

15. **Lower memory** (the speed-memory work, merged in 55970e42; guarded by `packages/engine/test/server/startup-imports.test.ts`).
    - Measured offline before the merge: 521 and 517 MiB, 31-33% below the Oct 11 build (`README.md:47-53`).
    - The merged build and the desktop app were never measured.

16. **Faster search when shrinking the conversation history (compaction)** (6e2a7b4f).
    - Where: `session/compaction.ts:111-145`.
    - Measured offline: 54.242584 → 0.536833 ms on a 504-message history. This saves computer time only, not tokens.

17. **Spending totals now include helpers, titles and subagents** (1536ca1b, d15d5115, 4214f1c1).
    - Where: `packages/core/src/session/projector.ts:153-174`, `:529-546`.
    - This fixes counting. It was never compared with what the provider reports.

18. **Budget limit for multi-agent code review** (6e2a7b4f).
    - Where: `session/admission.ts:14-31`; `review/run.ts:202-211`.
    - Measured offline: a $0.40 cap stops at $0.412 (`test/review/run.test.ts:529-604`).
    - It is a soft cap, and the desktop Vectorscope review doesn't use it.

19. **The Codium plan gateway estimates tokens instead of treating bytes as tokens** (5781cfd9, 42d73121, 0b5f8136).
    - Where: `api/_lib/model-plan-chat.ts:206-219`; `api/_lib/model-plan-config.ts:46-48`.
    - Checked by unit tests only.

20. **Less background traffic from the app.**
    - Where: `packages/app/src/context/server-session.ts:763-768`.
    - Measured offline: a 10-step session went from 83 requests / 6.52 MB to 10 requests / 39,002 bytes (`README.md:140`).

## 4. Not done or only partly done, ranked by likely savings

1. **The first request is still cold for default users.** This is the biggest one: the 14-29% estimate in section 2 comes from here.
   - Missing:
     - The cacheable-prefix fix only applies to ChatGPT sign-in, which is off.
     - There is no warm-up request (`generate:false`).
     - There is no 24-hour cache retention (`prompt_cache_retention "24h"`).
     - Neither of the last two appears in `packages/engine/src` or `packages/llm/src`, at 6eaf445a or at 90acb30c.
   - Where it would go:
     - Retention would be one extra option next to the cache key at `provider/transform.ts:1176-1181`. That is a small change.
     - A warm-up would sit next to the first-step early connection at `session/prompt.ts:2220-2221`. That is small to medium, and the warm-up request costs money itself.
     - Turning sign-in back on is a business decision. It needs an OpenAI registration that belongs to Vector, and then the website switch (`packages/web/public/policy/providers.json`) flipped. The code returns early at `provider-policy.ts:48` before it reads the environment variable.
   - Check first: the offline model says an API-key user's second session already caches 7,936 of 8,348 tokens on its first request (`README.md:74-75`). That is simulated, though.

2. **A to-do-list instruction that undoes fix 11.** At stake is round 1's live gain: about 31% fewer tokens and 8.2% lower cost. The fix is one sentence at `packages/core/src/task-size.ts:117`. Details in section 5.

3. **The task tool's description grew, and one rule is repeated.** At stake is about 1,064 estimated tokens on Thorough requests (Vector's largest task size), and +8.2-10.1% modelled cold cost.
   - The fix is to state the background/status/no-poll rule once instead of four times:
     - `tool/task.txt:8` and `:11`
     - `tool/task.ts:50-55`
     - `tool/task-manage.ts:56`
     - `session/system.ts:136`
   - That is a small text edit, but `README.md:191` says any further trim needs the live behaviour test first.

4. **Full re-sends for API-key users, and tool descriptions repeated in every WebSocket message.**
   - Turning on WebSocket for API keys is a small change at `plugin/index.ts:69`, with some risk.
   - Sending the tool list once instead of in every message (Codex's `additional_tools` approach) would go in `plugin/openai/continuation.ts:20-28`. That is a medium change.
   - Offline numbers: each Vector message is 20,683-21,706 B against Codex's 2,206-3,414 B. A whole session is 257,347 B against 85,178 B (`followup-2026-10-15/summary.json`).
   - The gain is mostly upload size and speed. Modelled cost barely moves (`README.md:90`), and the live data already put cache-miss cost at "Net about $0" (eff-diagnosis.json causes[6]).

5. **The desktop app still sends a title request.** That is about $0.0014 per run, estimated. The fix is small: give the session its temporary title when it is created (`packages/app/src/components/prompt-input/submit.ts:912-915`).

6. **Narration before tool calls.** `gpt.txt:37` still asks for a sentence before the first step and before each edit. The data tied this to 0.9-1.4 s per run. The fix is a small wording change, but it needs a live test.

7. **Startup time and stalls.** These cost time, not tokens.
   - The early connection does nothing in the desktop app. With sign-in it connects to api.openai.com instead of chatgpt.com (`provider/provider.ts:404-411`; `plugin/openai/codex.ts:554-556`).
   - Cloud streams have no stall timeout. `provider/provider.ts:2526-2532` sets one only for hosted model servers, and WebSockets wait 5 minutes (`plugin/openai/ws-pool.ts:38`).
   - Recorded cost: +0.5-0.8 s per run, a median of 394 ms to connect, and one 172.7 s loss. Each fix is a medium change.

8. **Memory.** The best offline figure is 517-521 MiB, against Codex at 152-157 and Claude Code at 326-336 MiB on the same offline test (`README.md:32-34`, `:47-53`; measured on different dates). A "fastpath" variant that measured 895 → 699 MiB was never found in the code. This would be a large profiling job.

9. **Default effort.** Vector uses medium, Codex uses low. The README leaves this to you (`README.md:193`).
   - The data doesn't show low is cheaper: gpt-6.1-sol cost $0.1206244 on low and $0.1186228 on medium (3 runs each).
   - Low was faster: 83.65 vs 97.274 s (`round4.metrics.json`, `discovery-v4-awake`).
   - It is a one-line change at `provider/transform.ts:1231-1233`, with a quality risk.

10. **Cheaper model for general subagents.** This exists only in the unreleased 90acb30c (`session/workflow.ts:23-27`). It needs 6 runs on each side, and the exploration that produces those runs is off by default (90acb30c `packages/core/src/brain/brain.ts:1331`). So it will rarely kick in. Not measured.

11. **Keeping reasoning across turns (`reasoning.context`).** This is opt-in only (`packages/engine/src/effect/runtime-flags.ts:52-57`). The undecided case is GPT-6.1 Sol, and there is no result for it (`live-efficiency.md:90`).

**Open, but not about saving money:**
- Code review budgets are not hard caps.
- Title and memory spending have no line of their own in the usage view.
- There is no API-equivalent cost figure for ChatGPT-plan runs.
- The app's first screen got 74.83% slower in one run each, and that was never measured again.
- Round 3's +29% cost rise is still unexplained.

## 5. Regressed after it was fixed

1. **ChatGPT sign-in was turned off on Oct 23** (ae56fcb8; website switch 98e6cc2f). This disabled fixes 1 and 3. Desktop 1.99.108 to 1.99.110 (Oct 17-23) had them on by default, but nobody recorded a live measurement in that week.

2. **The task tool description grew back past where it started.**
   - `task.txt` went from 2,590 to 3,458 B in af6f7cb2 (Oct 16). Offline that is 1,685 → 2,203 estimated tokens, above the 2,007 before the trim.
   - Together with the new task_manage tool (+458 tokens) and system text (+88 tokens), the prefix grew by about 1,064 tokens (`docs/benchmarks/vector-subagents-2026-10/README.md:39`).
   - This is softened since d9fb8d6d and bdb1a45a: default Standard ("Work") requests no longer get these tools (`packages/core/src/task-size.ts:96-104`; `session/prompt.ts:2509`).

3. **A to-do-list instruction was added.** Since Oct 17-18 (21483bfc, 54d7cd3f, bdb1a45a), every Standard request is told to "keep a short to-do list for multi-step work" (`packages/core/src/task-size.ts:117`, added at `session/prompt.ts:2419`). That contradicts `tool/todowrite.txt:3`, which says multiple files or tool calls alone don't justify a list. This is a risk, not a measured regression. The unreleased 90acb30c keeps the instruction.

4. **Sessions share less cache with each other.** Two changes make the start of a request differ between sessions. Neither effect has been measured.
   - The tool list and the subagent rules now depend on task size (d9fb8d6d; `session/system.ts:331`; `session/prompt.ts:2551-2557`).
   - The memory tool's description changes when the repository has brain documents (068304c6; `session/prompt.ts:2597-2598`).

5. **New prompt content since Oct 16.**
   - Added:
     - the memory tool: 283-370 estimated tokens, depending on which source you trust
     - the escalate tool: 823 B
     - the research tool: 1,242 B
     - webfetch's description: 558 → 929 B
     - `anthropic.txt`: +158 B
   - On default requests, some of this is offset:
     - the task tools are withheld
     - 342 tokens of memory rules were removed
     - the subagent rules shrink
   - The net effect has never been measured, because no footprint run exists for 6eaf445a.

6. **Codium gateway.** On Oct 11, 6f29242b added a 100,000-byte limit for Haiku that brought the bytes-as-tokens problem back. 42d73121 fixed it on Oct 15.

7. **Memory.** The Oct 11 build raised offline peak memory from 573 to 720 MiB (`README.md:32-35`). The speed-memory work later brought it back down.

8. **Effort changes can force full re-sends.** This comes from reading the code and is not measured. Effort now follows each request's size (`session/prompt.ts:2622-2628`). Effort cannot be sent as a WebSocket update (`plugin/openai/continuation.ts:20-22`), so a size change forces the whole conversation to be re-sent.

## 6. Still unproven, and the cheapest way to prove it

**What is unproven**
- No change from Oct 10-11 has a live before/after (`live-efficiency.md:3`). No later benchmark folder holds a live Vector-vs-Codex run.
- None of the planned live checks has a result:
  - the cache-key on/off test
  - the sign-in first-request cache check
  - `reasoning.context`
  - the behaviour test on the shipped prompt

  Sources: offline `README.md:134`; `live-efficiency.md:90`, `:134`; `README.md:136`.
- There isn't even an offline footprint of the shipped build. The offline numbers stop at commits from Oct 16.
- The unreleased 90acb30c adds learned cheaper defaults and a learned-skills listing with no measurement. It leaves the request, provider and prompt files unchanged: `git diff --stat` on those paths is empty.

**Cheapest proof, from cheapest up**
1. **Free:** rerun `script/agent-eval/footprint.ts` offline on 6eaf445a, for a Standard request and a Thorough request on both APIs. That shows the current prefix size and whether the task-description and to-do changes cancelled the savings. Run it with the Vector app closed, because heavy local runs have crashed it on this Mac before.
2. **Smallest live test:** on a release build with an API key, run two short sessions back to back in the same repository. Then read the cached-token count on the second session's first request.
   - About 7,936 (the offline prediction, `README.md:74-75`) means first-request caching already works for API users.
   - About 0 (the old live result in 20 of 27 runs) means item 1 in section 4 is the top fix.
   - Use a release build. Runs from source use the WebSocket for API keys, which release users don't get (`plugin/index.ts:69`).
3. **About $1 per round** (`live-efficiency.md:5`): run the guide's matched Vector-vs-Codex round.
   - Use its HTTP option (`VECTOR_DISABLE_WEBSOCKETS=1`, `live-efficiency.md:53`), because that matches what release API-key users get.
   - Record each session's first-request cache count (`:84`).
   - The guide's ChatGPT sign-in step (`:25`) no longer works; use an API key instead.

   This is the only test that answers "did the gap with Codex close?"
4. **Before any further prompt trims:** rerun the behaviour test on the shipped prompt, as `README.md:191` requires.