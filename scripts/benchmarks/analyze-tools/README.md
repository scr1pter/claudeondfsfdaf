# Safe CLI activity projection

```sh
python analyze.py <private-agent-stdout.jsonl> > <new-summary.json>
python -m unittest test_analyze.py
```

The summary contains counts and observed byte totals, without raw commands, page or tool text, paths, IDs or hashes. It recognizes Vector completion records and Codex completed command/file-change items. Vector `bash` and Codex commands use the same `shell` category. Nonzero command exits count as error outcomes in both runtimes; expected negative checks can legitimately exit nonzero and are not automatically waste or product defects.

CLI formats expose different fields. An absent patch/input/output field has no observation, rather than a measured zero size. Observed bytes are not model tokens, billing or a quality score. Use the independently recorded provider usage for financial comparisons. Duplicate completion updates are deduplicated; malformed records remain counted separately. Keep raw logs private and inspect a sanitized projection before publishing it.
