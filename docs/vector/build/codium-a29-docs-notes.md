# A29: Codium docs and the no-top-ups guard

A29 follows A28 (`d13d91e3`) and implements contract §7.3. It changes documentation, one account-page sentence and their tests. No API, schema, protocol or generated client changed, so no generator ran. No service, account, deployment or provider was called.

## What changed

- **`/docs/codium`** (`packages/web/src/pages/docs/codium.astro`, new), a Features page right after Models. Sections, each always rendered: `#plans`, `#models`, `#usage`, `#used-up`, `#github`, `#hosted`, `#coming`, `#payments`, `#free`. Plan names, prices, taglines, usage lines and limits come from `CodiumCopy.tierView` and `ENTITLEMENTS` through `packages/web/src/lib/codium-docs.ts` (new). The prerender lists no perk; the page script reads `/api/model-plans/config` and shows exactly the perks the server lists (plan features, the computed tagline, and `#hosted`, which reads "None yet." until a hosted perk is listed). A failed or malformed answer lists nothing, and a back-forward restore clears the page before it reads again. `#github` summarises GitHub agents on Codium ("in your own repo, on your own Actions minutes"), links to `/docs/vectorscope#github` and shows no trigger syntax. `#hosted` never mentions GitHub or Actions. `#coming` renders `CodiumCopy.COMING`. No amount, credit, token count or top-up offer appears; the only dollar figures are the four prices.
- **Navigation:** `docs-nav.ts` adds the page; `docsMoved` maps `plans` and `pricing` to it, and `vercel.json` redirects `/docs/plans` and `/docs/pricing`.
- **Other docs pages:** credits and top-up wording removed from `desktop-app.astro`, `troubleshooting.astro` (deletion row, and the new FAQ "My Codium month is used up" in `docs-content.ts`), `external-agents.astro`, `terminal-agent.astro`, `tokenomics.astro`, `first-launch.astro` and the Run Guard row in `docs-content.ts`. Codium steps are not counted in dollars, and step limits still apply.
- **Account page:** the deletion warning says what is left of this month can no longer be used, instead of "the credits left, this month's or purchased".
- **Repository docs:** `docs/vector/MODEL-PLANS.md` rewritten for the built system (tiers and caps, no top-ups, the plan cache and states, renewals, upgrades with carry, downgrades, failed payments, disputes, early-fraud warnings, switches, the listing rule and `CODIUM_LISTED_PERKS`, error codes, what is retried including Max and Ultra's single gateway retry, Codium Auto and "inside Codium, once you chose it, Vector may pick another model of your tier", the catalog's acceptance state, configuration). `owner-actions/codium-payments.md` rewritten (setup with the `sk_` setup key and the `rk_` runtime key, the test-mode run with monthly plans only, known limits). `owner-actions/codium-owner-guards.md` (new): the owner page, runtime switches, funding, Vercel spend, owner actions and the alert emails. `owner-actions/openrouter.md` gains a section separating the free-models account from the Codium account.
- **`test/no-topups.test.ts`** (new) runs the done criterion's `git grep` and holds every match to a reason (see the deviations file, "A29 docs and the no-top-ups guard").

## Owner decisions respected

Velocity keeps the owner-approved planned-size wording from `CodiumCopy.COMING`, always Coming, with no date. Vector Labs is not shown; the docs follow `COMING`, so the open decision on a Labs row needs no docs edit. The Oct 30 lineup decision is open, so `/docs/codium` names no model and links to /codium; `MODEL-PLANS.md` keeps the already documented five-model runtime catalog and describes the staged tier catalog only by reference. The investors page is untouched.

## Tests

Run one file at a time with `--timeout 30000`, root tests from `test/`, web tests from `packages/web`:

| File                                                                                   | Result                     |
| -------------------------------------------------------------------------------------- | -------------------------- |
| `packages/web/test/codium-docs.test.ts` (new)                                          | 12 pass                    |
| `test/no-topups.test.ts` (new)                                                         | 3 pass                     |
| `packages/web/test/docs-settings.test.ts`                                              | 4 pass                     |
| `packages/web/test/external-agents-rules.test.ts`                                      | 3 pass                     |
| `packages/web/test/account-delete-body.test.ts`                                        | 3 pass                     |
| `packages/web/test/docs-config-reference.test.ts` (every docs link lands on a heading) | 4 pass                     |
| `packages/web/test/docs-config-paths.test.ts`                                          | 2 pass                     |
| `packages/web/test/first-launch-docs.test.ts`                                          | 4 pass                     |
| `packages/web/test/brain-docs.test.ts`                                                 | 12 pass, 1 skip (existing) |
| `packages/web/test/release-111-docs.test.ts`                                           | 11 pass                    |
| `packages/web/test/release-copy.test.ts`                                               | 10 pass, 1 skip (existing) |
| `packages/web/test/free-models-copy.test.ts`                                           | 4 pass                     |
| `packages/web/test/vector-cloud-naming.test.ts`                                        | 2 pass                     |
| `packages/web/test/repository-traces.test.ts`                                          | 5 pass                     |
| `test/no-project-wording.test.ts`                                                      | 2 pass                     |
| `test/codium-plan-names.test.ts`                                                       | 6 pass                     |

`codium-docs.test.ts` covers the always-rendered anchors (each heading at the top level of the template), the prerender's empty listing, numbers from `ENTITLEMENTS`, every subset of the hosted perks and their requirements, the no-amount scan over the template and every listing's strings, `#github`'s link and copy rules, `#hosted` without GitHub or Actions, Coming copy, the copy guards, the navigation and redirects, the runtime refresh against fake answers (live, refused, malformed, offline), and the other docs pages' credits and top-up wording.

The web typecheck (`astro check` in `packages/web`) passes: 201 files, 0 errors, 0 warnings, 184 hints. No API or schema file changed, so the root API typecheck was not needed.

Not checked here: the rendered page in a browser (no dev server runs on this Mac), and the Codium CI lane, which runs both new test files (every `test/` file and every path naming Codium). The page's script is covered through its data function and a source check; its DOM wiring had source review only.
