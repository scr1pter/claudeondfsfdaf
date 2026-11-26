# Published check evidence stays readable (PR #106 takeover)

Branch `cx-publish-check-evidence`, finishing Codex's draft PR #106 (`publish-check-evidence`). The draft had been idle for more than a day, so this v2 run took it over on 2026-11-26 to finish it before the Saturday deadline. No feature flag changes, no public claims.

## 2026-11-26, v3 check evidence rendered as literal tags and broken fences

**Bug.** BT08a item 1 in `vector-at-mention-deviations.md`. The v3 agent phase (`github.agent.ts`) writes the evidence body into the bundle's `summary.json`. The separate publisher treats that body as untrusted model text: `sanitizeModelText` (`github.publish.ts`) turns `<`, `>` and `&` into entities and every backtick into `'`. The evidence used `<details>`, `<summary>`, `<code>` and a backtick fence for each check, so the published PR body showed the tags as text, the fence broke, and the check output ran together as an ordinary paragraph.

**Fix (Codex, kept as is).** `buildEvidenceBody` takes `checkFormat: "indented"`, which only the v3 agent phase passes. Each check is an indented code block: a `<icon> <command> (<status>)` line with the command's whitespace collapsed, then every output line indented by four spaces. The sanitizer never removes leading spaces or line breaks, so the block survives it, and no output line can leave the block to become markup. The direct CLI (`github.run-helpers.ts`) posts with trusted code and keeps the `<details>` format.

**Lead ruling.** Inside a code block GitHub does not decode entities, so after the sanitizer a `<`, `>` or `&` in a command or its output shows as `&lt;`, `&gt;` or `&amp;`, a backtick as `'`, and a mention as `` `@name` ``. Bun's own `suite > test` lines show `&gt;`. The other options were to trust the bundle's evidence markup in the publisher, or to have the publisher build the evidence from structured bundle fields. Both change the V21 rule that bundle text is untrusted, and the second also changes the bundle schema. The safest option that closes the item is Codex's format with the sanitizer left as it is: the structure is readable, and the content is exact apart from that reversible escaping. Recorded as a known limit in the deviations item.

**This run.** Merged main (`b57b8d53a`) into the branch; no conflicts. Added engine `test/cli/github.evidence.test.ts`, "indented checks stay one code block after the publisher's untrusted-text sanitizer". It runs the body through the real `sanitizeModelText` with hostile output (`</details>`, a fence, an `<img>` tag, a mention, `&&`, a `#` heading line) and checks that every non-blank line of the Checks section is indented, line by line. It runs on every platform; the journey that publishes through the fake GitHub is Linux-only.

**Tests.** With the branch's sources: `github.evidence.test.ts` 26 pass; `github.agent-codium.test.ts` passes the V27 restore case ("a follow-up in the same issue continues the newest of its own saved conversations"). `github.agents-journey.test.ts` runs 1 case on macOS and skips its 7 Linux-only cases, including the follow-up journey that checks the published body; CI's "engine (linux, shard k/8)" jobs run them (Bun's `--shard` picks the shard, `test.yml`). Engine typecheck passes.

**Red before.** With `github.evidence.ts` and `github.agent.ts` set back to main's versions, both indented cases in `github.evidence.test.ts` fail (24 pass, 2 fail) and the V27 restore case fails.

**Mutation check.** With the four-space prefix removed from the output lines, both indented cases fail (24 pass, 2 fail). Restored, 26 pass.

**Not caused by this branch.** On this Mac, 10 "Brain context (B08, BT07a)" cases in `github.agent-codium.test.ts` fail. A request to `https://github.com` reaches the test's network guard. They fail the same way with main's sources, and the engine Linux shards passed on the PR's earlier head. The failed jobs on that head (Windows engine shards and the computer-helper jobs) were all cancelled, not failed.
