# Desktop phase production benchmark comparison

Baseline [41269906020](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41269906020) (`407c79ae`) → desktop phase and review [41920625342](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41920625342) (`2aa64b48`). Both runs passed all 12 measurements on the first attempt. Raw manifests and metrics are retained byte for byte; `desktop-comparison.json` records artifact IDs and verified archive/file SHA-256 hashes.

Both runners report AMD EPYC 7763, 4 CPUs, the same memory, Node 24.15.0, Bun 1.3.14, Playwright 1.59.1 and the same workload (3 repeats, 80 history turns, 40 deltas, 4× CPU throttle). No environment field differs. Separate hosted runs still vary; these timing observations do not establish causation or a new performance threshold.

| Measurement (median of 3, ms) | Before | After | Change |
| --- | ---: | ---: | ---: |
| Task: first paint | 138.6 | 150.1 | +11.5 |
| Task: stable paint | 148.4 | 160.9 | +12.5 |
| New session: first paint | 160.5 | 165.8 | +5.3 |
| New session: stable paint | 240.7 | 249.5 | +8.8 |
| Child session: first paint | 98.4 | 108.3 | +9.9 |
| Child session: stable paint | 179.3 | 139.4 | -39.9 |
| Streaming: initial content | 570.1 | 395.2 | -174.8 |
| Streaming: completion | 10537.4 | 10506.8 | -30.6 |

Both runs had zero navigation blank/unknown samples and zero streaming blank samples. Each streaming measurement delivered all 40 deltas with 0 pending; no row or markdown was replaced, and no long task was recorded. The after-run recorded one rAF gap above 50 ms (50.034 ms); the baseline recorded none. Each production scan checked 844 JavaScript files and found no desktop test fixture markers.

Task and new-session navigation medians rose modestly; child stable paint and streaming initial content fell. All acceptance measurements passed. The mixed timing changes remain observations within these two hosted runs.
