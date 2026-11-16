# Current layout production benchmark comparison

Before the current-layout repair [41920625342](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41920625342) (`2aa64b48`) → after [41933580381](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/41933580381) (`09b2a571`). Both runs passed all 12 measurements on the first attempt. The new archive SHA-256 matches the GitHub artifact digest; raw manifests and metrics remain byte-exact. `layout-comparison.json` records provenance and archive/file hashes. The earlier four desktop raw JSON files are unchanged.

The CPU changed from AMD EPYC 7763 to AMD EPYC 9V74; reported memory changed from 16,760,344,576 to 16,760,340,480 bytes. Both used 4 CPUs, Node 24.15.0, Bun 1.3.14, Playwright 1.59.1 and the same production workload: one worker, three repeats, 80 history turns, 40 deltas and 4× CPU throttle. These hardware differences and ordinary hosted-run variance prevent causal attribution to the layout repair or a new performance threshold.

| Measurement (median of 3, ms) |  Before |   After | Change |
| ----------------------------- | ------: | ------: | -----: |
| Task: first paint             |   150.1 |   132.8 |  -17.3 |
| Task: stable paint            |   160.9 |   149.0 |  -11.9 |
| New session: first paint      |   165.8 |   155.5 |  -10.3 |
| New session: stable paint     |   249.5 |   243.0 |   -6.5 |
| Child session: first paint    |   108.3 |    95.1 |  -13.2 |
| Child session: stable paint   |   139.4 |   179.2 |  +39.8 |
| Streaming: initial content    |   395.2 |   576.7 | +181.5 |
| Streaming: completion         | 10506.8 | 10605.8 |  +99.0 |

Both runs recorded zero navigation blank/unknown samples and zero streaming blank samples. Every streaming measurement delivered all 40 deltas with 0 pending; neither run replaced a row or markdown element or recorded a long task. The earlier run had one rAF gap above 50 ms (50.034 ms); the new run had none, with a maximum gap of 33.4 ms. Each production scan checked 844 JavaScript files and found no desktop test fixture markers.

Navigation timings were mixed, and streaming medians were higher in the new run. All acceptance measurements passed. The changed hardware prevents assigning those differences to the code change.
