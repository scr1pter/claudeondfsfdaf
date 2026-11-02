# Provider bills and review admission

Two accounting fixes preserve the requested model, reasoning and verification.
They improve charge reporting and budget enforcement; they do not establish lower
provider bills or coding-quality superiority.

V2 now honors finite, nonnegative OpenRouter charges, including explicit zero.
It reads both the native compatible protocol's `openai.cost` metadata and the
legacy adapter's `openrouter.usage.cost` shape, using the existing destination
classifier to restrict this interpretation to OpenRouter routes. Unrelated and
lookalike destinations retain catalog pricing. Copilot handling is unchanged.

The corrected before-test reproduced catalog $0.003 instead of reported $0 and
$0.0123 over actual local HTTP through the compatible protocol and production
settlement calculator. Invalid/missing metadata controls already passed. The
protocol already retained the wire field; no parser or public schema change was
needed.

Review admission now selects rates from the actual invocation model's full cost
table at the estimated context size. Previously it retained base rates after
crossing a pricing tier. Before the fix, the 272,000-token boundary control
passed, but the 272,001 and 300,000 cases each admitted one unaffordable finalizer.
After the fix, all three controls pass; actual settlement and generation settings
remain unchanged.

## Validation

From source base `a35c03d`, using Bun 1.3.14 and local synthetic providers only:

| Package | Command | Result |
| --- | --- | --- |
| core | `bun test test/session-runner-billed-cost.test.ts test/session-runner-model.test.ts --timeout 30000` | 33 passed, 117 assertions |
| engine | `bun test test/review/run.test.ts test/review/model.test.ts --timeout 30000` | 48 passed, 255 assertions |
| core and engine | `bun run typecheck` from each package | exit 0 |

Early Review fixture failures lacked Auth/ModelCatalog services or used a hit
wrapper matcher on a request body. A zero catalog fixture was also incorrectly
classified as an explicitly free route. Those setup failures are excluded from
product-defect evidence; the corrected before/after cases establish the findings.
No paid API calls were required.

The separate background-notification experiment has passing focused controls but
six unresolved startup/readiness failures in its broader TaskTool run. That
experiment is excluded from these two fixes and remains unmerged pending
baseline comparison. These results do not establish invoice reconciliation,
full-workflow quality or billion-token inference performance.
