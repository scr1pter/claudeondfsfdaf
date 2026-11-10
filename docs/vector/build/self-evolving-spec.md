# Self-evolving Vector: build contract

Branch `self-evolving` at `6eaf445a`, written 2026-10-25 and revised the same day after review (section 18). Paths are
relative to `self-evolving/`. Every `file:line` was read on this branch and describes code as it is
today; new code has no line number yet. Nothing in this contract is permission to run suites or typechecks while the
owner is using Vector on this Mac. Each work package runs its own focused tests, from its package directory, when the
owner says so (`AGENTS.md` "Testing", "Type Checking").

## 0. What gets built

| # | Feature | One-line contract |
|---|---------|-------------------|
| A | Learned skills | After a run turns a failing check green, Vector drafts a repository skill. The draft is stored in brain.db, outside the rows older builds read, and waits for the owner. It goes live on its own only in "auto" mode, and only after a second, matching, untainted sighting. Skills name only allowlisted read-only helpers and one allowlisted check. They earn credit only when their own check passes, are versioned, can be undone and erased, never reach guests, public shares or models that may train, and reach the team only when the owner shares one. |
| B | Self-tuned workflows | For each repository and size, Vector records which effort, subagent split and subagent model got checks passing, and at what cost. It may only drop Thorough's size-raised `high` effort back to the model's default, suggest working solo, or move `general` subagents to a strictly cheaper small model, and only when the data says this passes as often for at least 20% less. It never raises spend, never overrides a choice the user, agent or config made, never changes effort while a prompt cache is warm, never touches spend caps, shows why, and can be reset. |
| C | Offline prompt evolution | A script harness runs prompt variants of Vector's own agents against deterministic offline suites and, when the owner asks, an isolated live suite. It writes a report that lists every changed sentence. The owner promotes a winner by hand as a normal code change. |
| D | Owner gates and prompt guard | Owner-only commands refuse to run from an agent's shell. An edit to a file that feeds a system prompt asks every time, and prompt files outside the trusted workspace that changed since the owner last approved them are held at instance start until the owner approves them. This is an ask and a hold, not a guarantee that the agent cannot change its prompts. |

**Non-goals for this build.**
- The V2 runner (`packages/core/src/session/runner/llm.ts:269-277`) and the core SkillV2 catalog (`packages/core/src/skill.ts`) get neither learned skills nor workflow advice.
- Learned skills do not become slash commands; a skill the owner shares does, once the repository is trusted again, so `render` is made safe for that (5.7).
- `GET /skill` and `GET /api/skill`, which a guest can reach, do not list learned skills.
- Learned skills have no personal (all-repository) scope.
- The primary model is never switched automatically.
- Effort is never changed for Light or Standard work, and there is no per-provider effort ladder (6.2, section 18 item 12).
- No live model run happens in CI.

## 1. Invariants (each one has a test in section 15)

- **I1. Only you write rules.** No learned artifact is ever `kind: "rule"`. No learner writes `RULES.md`, `MEMORY.md`, `BRAIN.md`, `AGENTS.md` or any config file. `BrainSchema.LearnedKind` (`packages/core/src/brain/schema.ts:60`) is unchanged, so the memory tool (`packages/engine/src/tool/memory.ts:25-33`) and `POST /memory` (`groups/memory.ts:51-55`) cannot create a skill.
- **I2. The agent cannot approve for itself.** Every owner-only CLI command that changes brain state, learning settings or trust refuses when `ChildEnvironment.AGENT_MARKER` is set (`packages/core/src/child-environment.ts:13-17`), as `vector local` already does (`packages/engine/src/config/local-settings.ts:163-166, 219, 246`; `config/config.ts:911-914`). Owner HTTP routes stay owner-only through ServerAuth; the desktop sidecar runs with a password (`packages/desktop/src/main/sidecar.ts:99`) that agent children never receive (`child-environment.ts:85-86`). Section 2.
- **I3. Skill rows are invisible to every generic memory path.** Skill entries live under the repository id `skill:<repository>` (4.1). `Brain.find`, `visible` (`packages/core/src/brain/brain.ts:490-500`), recall, digest, list, capacity, consolidate and eraseSession of this and every older build therefore never see them. `Brain.propose`, `Brain.update` and the memory tool also refuse skill ids explicitly (2.5).
- **I4. Nothing unreviewed from outside content.** A skill draft is held for the owner with the same hold the memory tool computes (`tool/memory.ts:177-196`): a guest, an untrusted repository (`Place.held`, `brain.ts:150-151`), a taint (`SessionMemory.taint`, `packages/engine/src/session/memory.ts:631-671`), or a read or recalled document with an outside hold. That computation moves into `SessionMemory.writeHold` and both callers use it (5.1). Guest sessions learn nothing (`prompt.ts:2774`, `2925`). A tainted session's trace is never sent to a model.
- **I5. Status and listing gate.** Only `active` skills are listed. `load` succeeds only for a name in the session's current, re-filtered listing whose entry is still active (5.4).
- **I6. Owner approval by default.** Skill learning defaults to `review`. Only an explicit `auto` setting in the personal `brain_state` row, never repository config, lets a draft go live without a click, and only under the rules in 5.3: rules drafter, two matching sightings in different untainted sessions, the intersection goes live, no instruction-like failure text, and never replacing a skill the owner approved or edited.
- **I7. Commands in skills are allowlisted.** A skill's `checks` pass `BrainSkill.check` and its helper commands pass `BrainSkill.helper` (2.3). A skill Vector approved on its own asks the `learned_skill` permission before it loads (2.4). The skill output says its commands still go through the permission rules.
- **I8. Skills are data, not instructions, and stay out of shared transcripts.** A learned procedure reaches the model only as `skill` tool output, wrapped as data with a precedence disclaimer. The transcript stores a placeholder; each request fills the procedure in from brain.db only where personal memory may go, for an owner-audience session (5.4). It never reaches the digest, recall, the system prompt, a guest, a model that may train, an outward or Vectorscope session, a subagent, or the public archive. The system prompt carries only the one-line card.
- **I9. Cheaper-only advice.** Advice may only (a) replace a size-raised `high` effort with the model's default, (b) suggest working solo on Thorough work, or (c) move a non-pinned `general` subagent to the provider's strictly cheaper small model (`tool/task.ts:908-929`). It never raises effort, never adds subagents or the judge, never switches the primary model, and never changes Run Guard or desktop caps (`packages/core/src/spend-guard.ts:233-264`, `packages/desktop/src/main/spend-limits.ts`).
- **I10. Explicit choices win.** Advice applies only when: the agent is `build` (not the research lead, `prompt.ts:2347`); the size came from Vector's rules (`TaskSize.Result.source !== "user"`, no `explicit:*` or `capped` reason, `packages/core/src/task-size.ts:57-68, 746-767`); the user picked no variant; the agent config sets no variant; and none of agent options, `model.options` or provider options sets a reasoning or thinking key (`EFFORT_KEYS`, 6.3). `request.ts` merges `sized` after `input.model.options` (`packages/engine/src/session/llm/request.ts:111-114`), which is why the last condition is needed.
- **I11. Prompt-cache stability.** The learned listing is chosen once per session and stored in brain.db (`brain_skill_listing`), so it survives restarts and instance disposal. It changes only to remove skills (a guest joined, a model that may train, a forget). Effort never changes while the session's prompt cache is warm (6.3). The first system block never changes because of learning.
- **I12. Unknown is not zero.** A run with any step that is not `priced` stores `cost_usd = NULL`; `local`, `plan` and `free` steps add $0 to `spentUsd` (`spend-guard.ts:168-175`) and so count as unknown. Rows whose background subagents were still running are marked `partial` and never used for cost. Tokens include child sessions. The token fallback compares effort arms of the same model only.
- **I13. Local by default.** Everything lives in brain.db (`packages/core/src/brain/database.ts:84-101`). The only new network call is the optional skill drafter, which by default runs only with Vector Local on (5.2); set to `always`, it sends one run's commands, file names and a redacted error excerpt to the owner's chosen provider. Usage check-in values are unchanged (`packages/schema/src/usage-report.ts`).
- **I14. Older builds stay safe and erase stays complete.** Older builds share brain.db (`database.ts:80-94`) and migrations have no forward guard (`packages/core/src/database/migration.ts:43-80`). Skill rows are invisible to them (I3), and a marker detects an older build's erase and finishes it (4.5). In this build, erase by scope, by session and forget remove skill entries, versions, uses, listings and workflow rows; a session erase rolls back skill text that session taught; a revert withdraws the drafts and evidence of the reverted requests.
- **I15. Prompt sources are asked or held, never silently changed.** An edit, write, patch or shell redirect (plus the common write commands, 8.2) to a prompt source asks `prompt_source` every time. Prompt sources outside the trusted workspace that changed since the owner last approved them are not loaded until approved (8.3). Interpreters, the V2 bash tool and MCP filesystem servers are not asked; the hold catches what they change outside the workspace, and workspace trust (`packages/core/src/workspace-trust/workspace-trust.ts:80-139`) catches what they change inside it.
- **I16. No live prompt editing.** Prompt evolution exists only as `script/agent-eval/prompt-evolve/`. It injects variants into isolated child processes through `VECTOR_CONFIG_CONTENT`. No Vector code path writes a prompt source on its own.

## 2. Owner gates and command safety (the safety model)

### 2.1 Owner-only CLI commands

New `packages/engine/src/cli/owner-gate.ts` exports `CliOwnerGate.refuse(what: string)`. It fails with "Vector's agents cannot <what>. Use Settings in the app, or run it in a terminal outside Vector." when `process.env[ChildEnvironment.AGENT_MARKER] !== undefined`. As with `vector local off`, Vector's own terminal also carries the marker (`local-settings.ts:163`), which the message says.

It is called first in the handler of:
- `cli/cmd/memory.ts`: `add` (`:128`), `edit` (`:154-163`), `pin`, `unpin`, `approve`, `reject`, `undo` (`:166-198`, through `simple`), `forget` (`:207`), `tidy` (`:220`), `erase` (`:232`), `learning` when a state is given (`:254`), `import` (`:289`);
- `cli/cmd/memory-doc.ts`: `doc add` (`:53`), `doc forget` (`:302`), `doc reindex` (`:314`), `doc distill` (`:362`), `review resolve` (`:508`), `repo-docs` when a state is given (`:536`), and `model download|install|remove|pause|resume` (`:555-693`);
- every state-changing command in the new `memory-skill.ts` and `memory-workflow.ts` (section 11);
- `cli/cmd/trust.ts:29-48`: `trust approve`, and the new `trust prompts approve` (8.3).

Read-only commands (`list`, `search`, `show`, `export`, `doc show|search|read|extract`, `links`, `review`, `status`, `skills`, `skills show`, `workflow`) stay open to the agent. Each gated command has a test (15, WP3 and WP5).

### 2.2 HTTP

Every new `/memory/skills*`, `/memory/workflow*` and `/config/prompt-trust*` route is owner-only (ServerAuth, `groups/memory.ts:589`). Residual risk: a `vector serve` with no credential configured treats every local caller as the owner (`packages/engine/src/server/auth.ts:83-89`), the agent's shell included. That predates this build. The docs for learned skills say to set `VECTOR_SERVER_PASSWORD` when serving.

### 2.3 Commands a skill may name (`packages/core/src/brain/skill.ts`, pure)

The shell's `"*": "allow"` default (`packages/engine/src/agent/agent.ts:239-240`) and the unsandboxed shell (`packages/engine/src/tool/shell/sandbox.ts:32-35`) mean any command a procedure names would run unasked. `LocalCommand.local` (`packages/core/src/local-mode/command.ts:14-32, 40-43`) is a list of programs whose output is local. It is not a safety list, since it includes `rm`, `kill`, `chmod`, `source` and `git reset|clean|checkout`, so the old `DENY` regex is dropped.

- **Simple command.** `BrainSkill.simple(command)` is true only for one command with no `;`, `&`, `|`, `$`, backtick, `<`, `>`, `\`, newline or `!`. Leading `NAME=value` assignments are allowed when the value matches `[A-Za-z0-9_.:/-]*`. This also keeps `` !` ``, `$ARGUMENTS` and `$1` out of every generated command (item 9).
- **Helpers** (`BrainSkill.helper`): `simple`, and the program is one of `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `git diff`, `git status`, `git log`, `git show`. This is a subset of `readonlyVerificationBash` (`agent.ts:268-292`). It is refused on any flag in `readonlyBashDenies` (`agent.ts:296-307`: `--output`, `--no-index`, `--ext-diff`, `--extcmd`, ` -o`, `outfile`, `git difftool`) or on `--pre`, `--pre-glob` or `--hostname-bin`. It is also refused when an argument is absolute, contains `..` or `~`, or matches `SECRET_FILE` (as `tool/memory.ts:275`).
- **Checks** (`BrainSkill.check`): `simple`, and one of:
  - a package-manager script, `(bun|npm|pnpm|yarn|deno) [run] <script>`, whose first segment (split on `:`, `-`, `_`, `.`) is in `TARGETS = test | lint | typecheck | build | check | verify`;
  - a bare checker: `tsc`, `tsgo`, `vitest`, `jest`, `pytest`, `mypy`, `pyright`, `ruff`, `eslint`, `biome`, `oxlint`, `rspec` or `phpunit`, also through `bunx`, `npx`, `pnpm exec` or `yarn exec`;
  - a task runner, `make`, `mvn`, `gradle`, `./gradlew`, `xcodebuild`, `cargo`, `go`, `dotnet`, `swift` or `mix`, whose every non-flag goal is in `TARGETS` or in the runner's own check verbs: `clippy` and `nextest` for cargo, `vet` for go, and `build-for-testing` and `test-without-building` for xcodebuild.

  Every form is refused when any word or word segment is in `DENY_WORDS = deploy | publish | release | push | upload | install | migrate | db`. So `make deploy`, `mvn deploy`, `npm run release`, `bun run build && git push` and `make test-db` are never checks.
- `SessionMemory.CHECK` (`session/memory.ts:466-467`) is unchanged for memory lessons. Skills use only `BrainSkill.check`.

### 2.4 Load-time asks

- `agent.ts` defaults (`:239-265`) gain `learned_skill: "ask"`.
- `tool/skill.ts` keeps its `skill` ask (`:29-34`) for every skill. For a learned skill with `approved_by = "vector"` it also asks `permission: "learned_skill", patterns: [name], always: [name]`.
- A skill the owner approved does not ask `learned_skill`.
- The skill output says: "Every command in it still goes through your permission rules." Commands then ask or run according to the user's bash rules, as any command the agent chooses does.

### 2.5 What may not touch a skill

- `Brain.propose` refuses `supersedes` that names a skill id, and `Brain.update` refuses any skill row, with the new refusal `"skill-entry"` ("Change learned skills in Settings > Memory > Skills."). Today `tool/memory.ts:205-214` archives any `origin: "agent"` entry and `:284-296` proposes a superseding `lesson`. Namespacing already makes `find` miss skill ids, and these checks are defence in depth.
- `tool/memory.ts` refuses `forget` and `update` when the id is a skill id, before it calls the brain.
- The listing shows skills with `location: "learned"`, never `brain:<id>`, so the agent is not handed skill ids.
- `PATCH /memory/:id` with `text`, `vector memory edit` and `vector memory pin` (`brain.ts:1907-1950`) cannot reach skill rows; skills change only through `/memory/skills/*` and `vector memory skills *`.

### 2.6 Residual risks (stated, not solved here)

- A check runs repository-controlled code (`npm test` runs whatever `package.json` says). That is true of any check the agent runs today.
- Editing brain.db directly with `sqlite3` from the shell names a path outside the workspace and asks `external_directory` (`agent.ts:257-260`). An interpreter that computes the path at runtime is not caught; that predates this build.

## 3. Feedback signals consumed

| Signal | Source today | Used by |
|---|---|---|
| Check recovered (fail→pass, still passing) | `SessionMemory.recovered` `session/memory.ts:490-501` | A: trigger; B: `pass` |
| A skill's own check ran, passed or failed after its load | `runs()` `session/memory.ts:443-454` (**new** `SessionMemory.skillOutcomes`) | A: credit `pass`/`fail`/`ignored` |
| Judge PASS | `SessionMemory.judged` `session/memory.ts:504-512` | A: model drafter trigger only; B: `pass` |
| Judge FAIL/INCONCLUSIVE at last round; check failing at end | task part `metadata.judge`; `runs()` (**new** `SessionMemory.failed`) | A: `fail` for a loaded skill whose check ran; B: `fail` |
| Revert | `SessionRevert` `revert.ts:161-171` | A: harm, withdraw drafts and evidence; B: `revert` |
| Skill load | `skill` tool part (**new** `metadata[SessionMemory.SKILL]`) | A: `brain_skill_use`, counters |
| Cost by step kind, steps, stop | `SpendGuard.snapshot` `spend-guard.ts:73-89, 387, 768`; **new** `Run.kinds` | B |
| Tokens, root and children | assistant `tokens` `packages/schema/src/v1/session.ts:500-509` | B |
| Tier, offered tier, warm cache, reasons | `SessionTaskSize.size` `session/task-size.ts:71-155` (offered `:129-132`; **new** `warm`) | B: key, gating |
| Effort applied | `prompt.ts:2624-2628`; user variant `request.ts:94-98` | B |
| Subagent split and model | `task` part `metadata.model/agent` `tool/task.ts:1052-1071` | B |
| Taint, guests, audience | `SessionMemory.taint`; `guests.marked`; `audienceOf` `prompt.ts:123-128` | A, B gating |
| Decay | `BrainCredit.factor` `packages/core/src/brain/credit.ts:12, 47-55` | A, B |

## 4. Data model and migrations (brain.db)

### 4.1 Skill entries live in a namespace older builds never read

- A skill is a `brain_entry` row with `kind = "skill"`, `repository_id = "skill:" + place.repository` (`SkillStore.namespace`), `scope = "repository"`, `origin = "agent" | "import"`, and `paths` = files the procedure names (at most 20).
- Every query of this and older builds filters entries by `place.repository` or `PERSONAL = ""` (`brain.ts:453, 490-500, 1870-1884, 2206-2222, 2470-2503`), so skill rows are never recalled or attached, never count toward the 300 cap, never merge in tidying, and never meet an older build's session erase. Their events and tombstones use the same namespace.
- `body` is the card `${name}: ${description}`, at most 300 characters (`LIMIT.agent`, `brain.ts:57`). The procedure never goes in `body`.
- `BrainSchema.Kind` (`schema.ts:23`) adds `"skill"`; `LearnedKind` is unchanged. `Evidence.type` (`schema.ts:138`) adds `"run"` (`command` = the check, `quote` = the request id).
- `brain_entry.kind` has no CHECK constraint (`migration/20261018000000_brain.ts:8-38`), so the entry needs no DDL.

### 4.2 Migration `packages/core/src/brain/migration/20261210000000_learned_skills.ts` (new, hand-written like `20261202000000_facets.ts`)

```sql
CREATE TABLE `brain_skill` (
  `entry_id` text PRIMARY KEY NOT NULL REFERENCES `brain_entry`(`id`) ON DELETE cascade,
  `repository_id` text NOT NULL,      -- the real repository id (the entry's is 'skill:' || this)
  `skill_key` text NOT NULL,          -- slug; name = 'learned-' || skill_key
  `name` text NOT NULL,
  `description` text NOT NULL,        -- <= 200 chars, SKILL_TEXT charset (5.2)
  `procedure` text NOT NULL,          -- markdown steps, <= 4000 chars, redacted; never the failure excerpt
  `checks` text NOT NULL,             -- JSON string[] (<= 5), each BrainSkill.check
  `commands` text NOT NULL,           -- JSON string[] (<= 5), each BrainSkill.helper
  `failure` text,                     -- redacted excerpt of the failing output, <= 600; never shared
  `version` integer NOT NULL,
  `drafter` text NOT NULL,            -- 'rules' | 'model' | 'user' | 'import'
  `session_id` text,
  `request_id` text,
  `approved_by` text,                 -- 'user' | 'vector' | NULL
  `approved_at` integer,
  `shared_path` text,
  `shared_at` integer,
  `live` integer NOT NULL DEFAULT 0,  -- 1 iff the entry is active; kept in the same transaction as status
  `loads` integer NOT NULL DEFAULT 0, -- lifetime counters (brain_use is pruned at 30 days, brain.ts:2505)
  `passes` integer NOT NULL DEFAULT 0,
  `fails` integer NOT NULL DEFAULT 0,
  `reverts` integer NOT NULL DEFAULT 0,
  `ignored` integer NOT NULL DEFAULT 0
);
CREATE INDEX `brain_skill_key_idx` ON `brain_skill` (`repository_id`, `skill_key`);
CREATE UNIQUE INDEX `brain_skill_live_idx` ON `brain_skill` (`repository_id`, `skill_key`) WHERE `live` = 1;
CREATE TABLE `brain_skill_version` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `repository_id` text NOT NULL,
  `skill_key` text NOT NULL,
  `version` integer NOT NULL,
  `entry_id` text NOT NULL,           -- no FK: deleted explicitly on every path (4.5)
  `session_id` text,                  -- the session whose run produced this text; NULL for user edits, imports, rollbacks
  `name` text NOT NULL,
  `description` text NOT NULL,
  `procedure` text NOT NULL,
  `checks` text NOT NULL,
  `commands` text NOT NULL,
  `failure` text,
  `actor` text NOT NULL,              -- 'agent' | 'user' | 'vector' | 'import'
  `reason` text NOT NULL,             -- 'learned' | 'edited' | 'imported' | 'rollback'
  `created_at` integer NOT NULL
);
CREATE UNIQUE INDEX `brain_skill_version_key_idx` ON `brain_skill_version` (`repository_id`, `skill_key`, `version`);
CREATE INDEX `brain_skill_version_session_idx` ON `brain_skill_version` (`session_id`);
CREATE TABLE `brain_skill_use` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `repository_id` text NOT NULL,
  `entry_id` text NOT NULL,
  `version` integer NOT NULL,
  `session_id` text NOT NULL,
  `request_id` text NOT NULL,
  `at` integer NOT NULL,
  `outcome` text                      -- 'pass' | 'fail' | 'ignored' | 'revert' | NULL until credited
);
CREATE UNIQUE INDEX `brain_skill_use_request_idx` ON `brain_skill_use` (`request_id`, `entry_id`);
CREATE INDEX `brain_skill_use_session_idx` ON `brain_skill_use` (`session_id`);
CREATE TABLE `brain_skill_listing` (
  `session_id` text NOT NULL,
  `position` integer NOT NULL,
  `repository_id` text NOT NULL,
  `entry_id` text NOT NULL,
  `version` integer NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `private` integer NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`session_id`, `position`)
);
ALTER TABLE `brain_state` ADD `skill_learning` text;   -- personal row: 'review' | 'auto' | 'off'; NULL = 'review'
ALTER TABLE `brain_state` ADD `skill_drafter` text;    -- personal row: 'off' | 'local-only' | 'always'; NULL = 'local-only'
```

### 4.3 Migration `packages/core/src/brain/migration/20261211000000_workflow.ts` (new)

```sql
CREATE TABLE `brain_workflow_run` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `repository_id` text NOT NULL,
  `session_id` text NOT NULL,
  `request_id` text NOT NULL,         -- the run's last user message
  `at` integer NOT NULL,
  `tier` text NOT NULL,               -- the request's tier
  `effort_tier` text NOT NULL,        -- the tier that set effort: build.offered on caching providers, else tier (prompt.ts:2624-2628)
  `agent` text NOT NULL,              -- always 'build'
  `provider_id` text NOT NULL,
  `model_id` text NOT NULL,
  `effort` text NOT NULL,             -- effective: 'default' | 'high' | variant name | 'mixed'
  `effort_source` text NOT NULL,      -- 'size' | 'learned' | 'explore' | 'user' | 'agent' | 'config' | 'explicit' | 'mixed'
  `subagents` integer NOT NULL,       -- task launches, judge excluded
  `subagent_model` text,              -- 'parent' | 'small' | 'mixed' | NULL
  `subagent_models` text NOT NULL,    -- JSON Record<"provider/model", count>
  `judge_rounds` integer NOT NULL,
  `outcome` text NOT NULL,            -- 'pass' | 'fail' | 'revert' | 'none'
  `signal` text,                      -- 'recovered' | 'judged' | 'judge-fail' | 'check-fail'
  `cost_usd` real,                    -- NULL unless every step was 'priced' (I12)
  `cost_kinds` text NOT NULL,         -- JSON Partial<Record<CostKind, steps>>
  `steps` integer NOT NULL,
  `unpriced_steps` integer NOT NULL,
  `tokens_input` integer NOT NULL,    -- tokens: root session and every child session of the run
  `tokens_output` integer NOT NULL,
  `tokens_reasoning` integer NOT NULL,
  `tokens_cache_read` integer NOT NULL,
  `partial` integer NOT NULL DEFAULT 0, -- background subagents were still running at observation
  `runs` integer NOT NULL DEFAULT 1,  -- runs of this request added together
  `stop` text,
  `taint` text,
  `advice` text                       -- JSON BrainWorkflow.Advice applied, or NULL
);
CREATE UNIQUE INDEX `brain_workflow_run_request_idx` ON `brain_workflow_run` (`repository_id`, `request_id`);
CREATE INDEX `brain_workflow_run_tier_idx` ON `brain_workflow_run` (`repository_id`, `effort_tier`, `at`);
CREATE INDEX `brain_workflow_run_session_idx` ON `brain_workflow_run` (`session_id`);
ALTER TABLE `brain_state` ADD `workflow_learning` text;   -- personal row: 'apply' | 'observe' | 'off'; NULL = 'apply'
ALTER TABLE `brain_state` ADD `workflow_explore` integer; -- personal row: 1 = on; NULL/0 = off
```

Both migrations are imported in `database.ts:13-21` and appended, in this order, to `applyOnly` (`database.ts:50-60`). The exact migration-list assertion in `packages/core/test/brain/database.test.ts:78-91` gains both ids (WP1). Drizzle tables `BrainSkillTable`, `BrainSkillVersionTable`, `BrainSkillUseTable`, `BrainSkillListingTable` and `BrainWorkflowRunTable` are added to `sql.ts` in snake_case, and `BrainStateTable` (`sql.ts:131-152`) gains the four columns. `brain_use` is not used for skills, so its type (`sql.ts:155-172`) is unchanged. `helpful` and `harmful` keep holding decayed REALs (`sql.ts:27-30`).

`SpendGuard.Run` (`spend-guard.ts:73-89`) gains `kinds: Readonly<Partial<Record<CostKind, number>>>`. `afterStep` (`:168-175`) increments `kinds[step.costKind]` and `begin` sets `{}`. No limit reads it.

### 4.4 Shared SQL helpers `packages/core/src/brain/skill-store.ts` (new)

These are plain functions over a drizzle handle. `Brain` and `BrainSkill` both call them, which avoids a service cycle: `namespace`, `eraseScope(tx, repositories | undefined)`, `eraseSession(tx, repository, sessionID)`, `forgetKey(tx, repository, key)`, `dropOrphanVersions(tx, repository)`, `tidy(db, repository, now)`, `mark(tx, repository)` and `reconcile(db, repository | "all")`.

### 4.5 Retention, erase and older builds

| Data | Kept | Removed by |
|---|---|---|
| Skill entries (`skill:<repo>`) and `brain_skill` | with the entry; one live entry per key (`brain_skill_live_idx`) | forget (all entries of the key), reject, `Brain.erase` (repository, all), `Brain.eraseSession` (4.5.2), tidy |
| `brain_skill_version` | 180 days after its entry is superseded, at most 20 per key | every path that deletes an entry, and `dropOrphanVersions` in every tidy pass (versions of a key with no entry left) |
| `brain_skill_use` | 180 days | erase, eraseSession, forget, tidy |
| `brain_skill_listing` | 180 days after `created_at`; a resumed older session chooses again | erase, eraseSession (that session), forget (rows of the key) |
| Proposed/quarantined skills | 60 days (memories: 30, `brain.ts:2384-2390`) | tidy, with their versions |
| Active skills | cap 50 per repository; past it, lowest `lift`, then least used, is archived | tidy |
| `brain_workflow_run` | 365 days and at most 2,000 rows per repository, pruned on `record` | `BrainWorkflow.reset`, `Brain.erase`, `Brain.eraseSession` |
| Skill-key tombstone | 180 days, `repository_id = skill:<repo>`, `norm_hash = "skill:" + sha256(key)`, `terms` NULL | expiry (`brain.ts:2504`) |

**4.5.1 Older builds' erase.** In the same transaction as the first skill or workflow row it writes for a repository, this build inserts a marker tombstone: `repository_id = place.repository`, `norm_hash = "vector:learning-marker"`, `until = 253402300799000`, `terms` NULL. `reworded()` skips tombstones with NULL terms (`brain.ts:1838-1843`), and tidying keeps unexpired ones (`brain.ts:2504`). An older build's `erase(repository)` or `erase(all)` deletes the repository's tombstones (`brain.ts:2104-2107`), so the marker goes with it. `SkillStore.reconcile` runs when `BrainSkill` and `BrainWorkflow` are first used in a process, and in every tidy pass. For every repository id that has skill, version, use, listing or workflow rows but no marker, it deletes those rows. It logs counts only. An older build's `erase(all)` also deletes skill entries outright (`brain.ts:2076-2080, 2099`; FKs are on, `database.ts:47`), and reconcile removes what is left. Stated limit: an older build's session erase never reaches skills. Statement 7 (section 14) says so.

**4.5.2 Session erase.** `Brain.eraseSession` (`brain.ts:2206-2246`) keeps an entry another session also taught. For skills, `SkillStore.eraseSession`:
1. deletes the session's `run` evidence, use, listing and workflow rows, and its version rows;
2. for every key whose live entry's current text came from a deleted version, restores the newest remaining version as a new `rollback` version (`session_id` NULL);
3. deletes an entry with no version left, or with no evidence left and `drafter != "user"`, and writes the key tombstone.

**4.5.3 Forget** removes every entry of the key, superseded and archived ones included, with all versions, uses and listing rows, and writes the key tombstone.

## 5. Feature A: learned skills

### 5.1 Trigger (engine, after each top-level run)

`SessionSkillLearn.run` (new, `packages/engine/src/session/skill-learn.ts`) is forked into the background scope from the end-of-run block, right after `creditRun` (`prompt.ts:2715`), only when `!session.parentID && !session.internal && !Flag.VECTOR_PURE`. It drafts nothing unless all of these hold:

1. `guests.marked(sessionID)` is false, `learnSettings().learning` is true and `skills !== "off"`.
2. The run's last request (`taught`, `prompt.ts:2143-2144, 2236`) has tier `standard` or `thorough`, and its turn is `SessionMemory.finished` (`session/memory.ts:546-549`).
3. `SessionMemory.recovered(msgs, request.time.created)` holds for a check that passes `BrainSkill.check`, or `SessionMemory.judged(turn)` holds. A judged-only run gets a draft only from the model drafter.
4. Either no learned skill was loaded in the turn, or the run **diverged** from the loaded skill: the recovered check's target is not one of the skill's `checks`, or the Jaccard similarity of the run's helper commands and paths with the skill's is below 0.5. A diverged run's draft for the same key is a new version (5.3).
5. The turn has at least 3 completed tool calls and at least one edited file (`SessionMemory.edited`, `session/memory.ts:585-600`).
6. Caps: at most 1 draft per run, 3 per session and 20 pending per repository, enforced in `BrainSkill.propose`.

The hold and privacy come from `SessionMemory.writeHold({ guest, held: place.held, messages, sources })` (new, pure), which returns `{ hold?: BrainSchema.Hold; private: boolean }`. It is today's computation at `tool/memory.ts:189-196`, moved. Both callers first resolve `sources` with `knowledge.sources(place, SessionMemory.documents(messages))`, as `tool/memory.ts:180` does today, and `tool/memory.ts` is changed to call `writeHold`.

### 5.2 Trace and drafting

`SessionMemory.trace(messages, start, root, loaded?)` (new) reads only the run's own tool parts, and it reads the **raw** `part.state.input.command` (`session/memory.ts:448`), never `runs()`'s lowercased, unquoted form (`:424-426, 451`). `normal()` is used only to match runs to a check target.

```ts
export type Trace = {
  readonly sessionID: string
  readonly requestID: string
  readonly signal: "recovered" | "judged"
  readonly check?: { readonly command: string; readonly target: string; readonly failure: string } // raw command; target = SessionMemory.checkTarget; failure <= 600 chars
  readonly commands: readonly string[] // raw commands between first failure and the pass that pass BrainSkill.helper; deduped; <= 5
  readonly edited: readonly string[]   // repo-relative (BrainPaths.relative), <= 20
  readonly read: readonly string[]     // repo-relative, <= 20
  readonly closing: string             // agent closing text, <= 600 chars (SessionTaskSize.closingText)
  readonly loaded?: { readonly id: string; readonly key: string; readonly checks: readonly string[]; readonly commands: readonly string[]; readonly paths: readonly string[] }
  readonly at: number
}
```

`SessionMemory.checkTarget` is today's private `check()` (`session/memory.ts:457-462`), exported. A check command that fails `BrainSkill.check` gives no trace.

**Deterministic drafter** (`BrainSkill.draft`, pure; the default, works offline):
- `key` = kebab(the check target's tool words, e.g. `bun-typecheck`) + `-` + kebab(the longest common directory of `edited`, at most 2 segments), at most 56 characters. With no check, there is no deterministic draft.
- `name` = `learned-${key}`. It matches `^learned-[a-z0-9]+(-[a-z0-9]+)*$` and is at most 64 characters (`packages/core/src/plugin/skill/customize-vector.md:180`).
- `description` = `When ${checkTarget} fails in ${area}: steps that made it pass here before.` Characters outside `SKILL_TEXT = [A-Za-z0-9 .,:;()/_+=@%-]` are replaced by a space, and the result is cut at a word boundary to 200 characters with "..." (item 32).
- `procedure` is fixed markdown. "## When to use" names the check target and the date. "## Steps" lists: run the check (the raw command), files to read (at most 5), files changed (at most 8), helper commands (at most 5), re-run the check.
- `failure` is the redacted failing output tail, stored apart from `procedure`.
- `checks = [check.command]`, `commands = trace.commands`, `paths = edited ∪ read` (at most 20), `drafter = "rules"`.

**Model drafter** (optional, `drafter = "model"`). It runs only when all of these hold:
- `hold` is undefined;
- the new setting `skillDrafter` is `"always"`, or `"local-only"` (the default) with `Egress.policy().enabled` (as `prompt.ts:2836-2837`), and not `"off"`. It is separate from `modelLearner`, which the owner agreed to for corrections only;
- neither the primary nor the small model may train (`prompt.ts:2877-2879`);
- the run's spend snapshot is neither `stopped` nor `warned`. Desktop caps reach the engine as per-run budgets (`spend-limits.ts:9-12`), so this also covers them.

It reuses the `modelLearn` pattern (`prompt.ts:2865-2918`): the `title` agent, `prompt: BrainSkill.PROMPT`, the small model, `temperature: 0`, no tools, `TitleUsage` purpose `"memory"`. It has its own `drafters: Map<SessionID, Fiber>`, which the session's next prompt cancels next to `learners` (`prompt.ts:296, 2723-2734`). Its input is `BrainSkill.request(trace)`, with the trace wrapped as data. `BrainSkill.lock(reply, trace)` accepts only:
- steps whose commands are all in `trace.commands ∪ {check.command}`;
- path-like tokens in `edited ∪ read`;
- text within the limits in 5.3.

Otherwise the deterministic draft is used. Model drafts never auto-promote (5.3).

### 5.3 Write gate: `BrainSkill.propose(place, draft, meta)`

Skills are written only by `BrainSkill`, never by `Brain.propose`. The checks run in this order:

1. `learning === false` or `skills === "off"` (agent origin): refused `"learning-off"`.
2. Limits: name pattern; description 1-200 characters in `SKILL_TEXT`; procedure 1-4,000; at most 20 lines under `## Steps`; at most 5 checks, each `BrainSkill.check`; at most 5 commands, each `BrainSkill.helper`; failure at most 600; card at most 300. A breach is refused `"too-long"`, `"empty"` or `"unsafe-command"` (new refusal).
3. Secrets: `BrainScan.credential(description + procedure + failure)` is refused `"secret"`; `BrainScan.redact` is applied before storing (`brain.ts:1460-1466`).
4. Caps: refused `"limit"`.
5. Tombstones: the card hash or the skill-key tombstone, both in the namespace, are refused `"forgotten"`. `reworded()` is not applied to skills.
6. `hold` = `meta.hold` ?? (`BrainScan.hidden` → `"hidden-unicode"`) ?? (`BrainScan.instructionLike(description + procedure)` → `"instruction-like"`) (`packages/core/src/brain/scan.ts:368-374`).
7. `instructionLikeFailure = BrainScan.instructionLike(failure, true)`, the document variant (item 5). It never sets a hold on its own, but it blocks auto promotion and shows in the UI.
8. `rows = sameSkill(place, key)`: every entry of the key in the namespace.

Decision table. `verified` means `evidence.type === "run" && evidence.verified`. `owned` means some entry of the key has `approved_by = "user"` or `drafter = "user"`. `match(P, N)` means: equal check-target sets, Jaccard(commands) ≥ 0.8 and Jaccard(paths) ≥ 0.8, where two empty sets count as 1.

| Existing for key | New write | Result |
|---|---|---|
| none | hold set | insert `quarantined` with the hold; version 1 |
| none | import, or `drafter: "model"`, or mode `review` | insert `proposed`, event detail `skillPending: "review"` |
| none | mode `auto`, rules, verified | insert `proposed`, `skillPending: "sighting"` |
| pending, same session | any | `merged`, no change (no self-vouching) |
| pending | held write, existing not held | `merged`, no evidence added (`brain.ts:1576-1577` rule) |
| pending `sighting` P, other session | mode `auto`, both `drafter: "rules"`, verified, not held, `match(P, N)`, neither failure instruction-like, not `owned` | `promoted`: content = `BrainSkill.draft` of the **intersection** (checks, commands ∩, read ∩, edited ∩; failure from N), new version row, status `active`, `live = 1`, `approved_by = "vector"`, evidence added, confidence = max(old, 0.8) |
| pending, other session | otherwise | `merged`: evidence added ("worked in N sessions"); the pending content is **unchanged** |
| active A | `match(A, N)` | `merged`: evidence added, confidence raised |
| active A, `owned` | different (no `match`) | insert `proposed`, `skillPending: "review"`, superseding A only when the **owner** approves (item 6; `settle`'s actor rule, `brain.ts:1408-1430`) |
| active A, not owned | different | insert a superseding entry with `version = A.version + 1`; status by the rows above |

Each insert writes `brain_entry`, `brain_skill`, a `brain_skill_version` row (with `session_id`), a `brain_evidence` row and an `added` event. The event detail is `{ pending?: <superseded entry id>, skillPending: "review" | "sighting", skillKey, version }`. `pending` keeps its existing meaning, the id of the entry being replaced (`brain.ts:1756`), which `settle` (`:1408-1430`) and `replacedBy` (`:1788-1810`) read; the new state goes under `skillPending` (item 28). Each insert also writes the marker (4.5.1) and bumps the revision of `place.repository`. `confidence()` (`brain.ts:2750-2754`) gains `run`: verified 0.8, unverified 0.5.

### 5.4 Delivery to the agent

**Which sessions.** A listing exists only for a root session (`!parentID`), not internal (`session.internal` covers Vectorscope's `vectorscope.*` sessions, `prompt.ts:111-112`, and helpers), whose `audienceOf(session, agent.name)` is `"owner"` (`prompt.ts:123-128`), and whose agent is not `ResearchRun.LEAD`. It also needs the skill permission to be enabled (`session/system.ts:356`) and `!Flag.VECTOR_PURE`. `OUTWARD_AGENTS` (`prompt.ts:114`) alone would miss Vectorscope's reviewers.

**Choosing the listing (once per session).** `BrainSkill.listing(place, { query, personal })` runs on the session's first non-quick step (`prompt.ts:2546`). It ranks active, non-stale, non-fading skills by `BrainLexical` similarity between the first non-chat request's typed text and each skill's card and paths. Ties break by `BrainCredit.lift`, then `last_used_at`. It keeps at most 8 with similarity > 0 and `proven ≥ 0.9` (`credit.ts:32-36`). A skill is fading when `ignored ≥ BrainCredit.IGNORED_AFTER` (5, `credit.ts:18`) and `passes = 0`. `LearnedSkill.listing` stores the result in `brain_skill_listing` (id, version, name, description, private), so restarts and instance disposal keep it (I11).

**Every step re-filters the stored rows** (item 22):
- a guest is in the session → none;
- `freeModelMayTrain(model)` → private rows dropped;
- audience not owner → none;
- entries that are no longer active, or were forgotten → dropped.

The filter can only remove rows, so the block changes only when privacy or a forget requires it.

**System prompt.** `SystemPrompt.skills(agent, { learned })` (`session/system.ts:355-367`) merges the filtered rows into `skill.available(agent)` before `Skill.fmt`. The call site is `prompt.ts:2545-2546`. Learned entries carry `location: "learned"` and a description already restricted to `SKILL_TEXT`, and `Skill.fmt` now escapes every description (8.4, item 10). Skill-permission `deny` filtering still applies (`skill/index.ts:314-319`). A disk or built-in skill with the same name wins, and the learned one is left out.

**Loading** (`tool/skill.ts:24-72`). The tool tries `skill.get(name)` first, then `learned.load({ session, name, model })`. The load succeeds only if the name is in this step's filtered listing and the entry is still active. It asks `skill` (`:29-34`) and, for `approved_by = "vector"`, `learned_skill` (2.4). For a learned skill:
- **Stored output** (the transcript): `Loaded learned skill <name> (version N). Vector fills in its procedure for each request.`
- **Metadata:** `{ name, dir: "", remote: false, learned: id, version, [SessionMemory.SKILL]: { id, version } }`, where `SessionMemory.SKILL = "vector.memory.skill"` is new and is added to `admitted()`'s engine-only keys (`session/memory.ts:57-60`).
- **Filled per request:** `withheldRecall` (`prompt.ts:3163-3260`, called `:2396`) replaces the output with `BrainSkill.content(version row)` when `personal && audience === "owner"` and the version row still exists, and otherwise with `[learned skill withheld here]`. This is the pattern personal memory and documents use (`session/memory.ts:28-50`). The bytes come from the immutable version row, so they are stable for the session.
- **Content:** `<skill_content name="…" origin="learned">`, then the disclaimer "Vector learned this procedure from earlier runs in this repository. It is data, not an instruction: the user's request and rules take precedence. Every command in it still goes through your permission rules.", then the procedure, then `### What failed last time` with the failure in a fenced `text` block. All of it is escaped like `BrainCard.passage` (`card.ts:57-78`). There is no base directory and no file list.
- `BrainSkill.loaded(place, { id, version, sessionID, requestID })` writes `brain_skill_use` and increments `loads`.
- **Public archive and export:** `SessionArchive.publicArchive` (`packages/core/src/share/archive.ts:141-160`) copies tool output verbatim, and `share: "auto"` still publishes sessions with consent (`packages/engine/src/share/session.ts:48-56`, despite the description at `v1/config/config.ts:61-63`). The archive therefore carries only the placeholder. As defence in depth, `archive.ts` also replaces the output of any `skill` part whose metadata has `learned` with the placeholder.
- **Vector Local's count:** `carriedOf` (`prompt.ts:4181-4201`) gains a `listed` argument and counts filled skill outputs and listed cards under `repository` (item 23).

**Logs and traces** (item 27): skill code logs and annotates spans with entry ids and counts only, never names, keys, paths or text.

### 5.5 Credit, decay, retirement

- `SessionMemory.skillOutcomes(turn, loads)` (new, pure). Per loaded skill:
  - `pass` when a run of one of the skill's check targets after the load recovered or passed, and the last run of that target passed;
  - `fail` when the last run of its target failed, or the judge's last verdict was FAIL or INCONCLUSIVE after its target ran;
  - `ignored` when none of its targets ran after the load.
- `creditRun` (`prompt.ts:2924-2957`) calls `skill.credit(place, { sessionID, requestID, outcomes })` beside `knowledge.credit`. The guest and taint exclusions stay (`:2925-2927`). Learned skills are **not** added to `delivered`/`fetched`, so `knowledge.credit` (`knowledge.ts:6133-6174`) never gives a skill the generic +1 for any passing run (item 11).
- `BrainSkill.credit` runs once per (request, skill), using the unique use index:
  - `pass`: helpful +1 and `passes + 1`;
  - `fail`: harmful +1 and `fails + 1`;
  - `ignored`: `ignored + 1`. A skill that keeps being loaded without its check being run therefore fades out of the listing.
- `BrainSkill.reverted(place, { sessionID, requests })`, called from `SessionRevert` (`revert.ts:161-171`) inside the same non-guest guard:
  - uses in those requests that were credited `pass` get helpful −1, harmful +1, `reverts + 1` and outcome `revert`;
  - pending drafts whose `request_id` is in `requests` are deleted with their versions, and no tombstone is written, since the owner did not reject them;
  - `run` evidence quoting those requests is deleted;
  - an auto-promoted skill (`approved_by = "vector"`) left with verified evidence from fewer than 2 sessions goes back to `proposed` (`skillPending: "review"`).
- **Tidy** (`SkillStore.tidy`, called from consolidate, `brain.ts:2250+`):
  - a skill with `harmful ≥ 2 && harmful > helpful` (item 31) is archived;
  - one unused for 90 days with `loads < 2` is archived;
  - pending drafts older than 60 days are dropped, with their versions;
  - a skill whose `paths` are more than half missing under `place.root` is marked `stale` and unlisted, and the mark is removed once they exist again;
  - the cap of 50 is applied;
  - orphan versions are dropped, and `reconcile` runs (4.5.1).

  Decay is automatic (`brain.ts:2261-2289`). Skills are never merged lexically.

### 5.6 Review, edit, versions, undo, forget

These are all `BrainSkill.update(place, id, change, actor)`. `actor` is always `"user"` from the owner routes and CLI; Vector's own promotion is internal.

| Action | Effect |
|---|---|
| `approve` | `proposed`/`quarantined` → `active`, `live = 1`, `approved_by = "user"`, `approved_at`; the superseded target (event `pending`) is superseded in the same transaction |
| `edit { description?, procedure?, checks?, commands? }` | re-runs 5.3 steps 2, 3 and 6; content updated in place; `version + 1`; `drafter = "user"`; version row `edited` (`session_id` NULL); event `edited { previousVersion }`; a held draft stays held until approved |
| `rollback { version }` | copies version N into a new version (`rollback`) of the live entry |
| `restore` | implemented as a rollback (item 29): restoring a superseded or archived entry of a key that has a live entry copies its text as a new version of the live one; with no live entry it reactivates the entry. `brain_skill_live_idx` makes two live entries per key impossible |
| `reject` | deletes the entry, its versions (if no other entry of the key remains) and its evidence; key tombstone when no other entry of the key remains |
| `undo` | archives the live entry; reactivates the entry it replaced (`replacedBy`-style lookup on the event `pending`); key tombstone only if nothing was reactivated |
| `archive` | `live = 0`, status `archived` |
| forget | 4.5.3 |

`BrainSkill.get` returns `versions`, evidence and `uses: { loads, passes, fails, ignored, reverts }` from the counters (item 30). `Brain.erase` and `Brain.eraseSession` (`brain.ts:2074-2246`) call `SkillStore.eraseScope`/`eraseSession` inside their transactions. `Brain.stats` (`brain.ts:2520`) adds `skills: { active, review }` from the namespace.

### 5.7 Share to the repository (team)

`LearnedSkill.share(place, id, { force })` (engine) is reachable only from the owner-only route and the gated CLI, never from a tool. Steps:

1. `BrainSkill.shareable(place, id)` refuses unless the skill is `active`, `approved_by === "user"`, not `private`, not `stale` and not held. It renders `BrainSkill.render(entry)`:
   - the frontmatter has `name`, `description` and `metadata: { origin: "learned", version: "<n>" }`, with the version as a **string**, since `metadata` is a string-to-string map (`customize-vector.md:182`);
   - the body is the procedure only: **no failure excerpt**, no session ids, stats or evidence;
   - absolute paths under `place.root` are rewritten as repository-relative;
   - any remaining absolute home path (`/Users/`, `/home/`, `C:\Users\`) is refused `unsafe-text`;
   - any `` !` ``, `$ARGUMENTS` or `$<digit>` anywhere, fenced blocks included, is refused `unsafe-text` (item 9). Shared skills become slash commands (`command/index.ts:144-165`), whose snippets run (`prompt.ts:3504-3545, 4076-4080, 4132`).
2. The posting check `SessionPosting.check({ parts: [text], typed: false, sessionIDs })` (`packages/engine/src/session/posting.ts`; route `groups/memory.ts:987-997`) runs over the text. If it would take a sentence out, sharing is refused `personal`, and the sentences are listed so the owner can edit them first.
3. The file `<place.root>/.vector/skills/<name>/SKILL.md` is written only when `FSUtil.writableInside(place.root, target)` holds (`packages/core/src/fs-util.ts:327`, as `config/config.ts:2344-2350`). It is refused `exists` unless `force`.
4. `BrainSkill.shared(place, id, relativePath)` sets `shared_path`/`shared_at`, archives the entry and records `shared` (actor user).

The response is `{ path, trust: "changed", reload: "when-idle" }`. The write changes the workspace fingerprint (`workspace-trust.ts:80-139`). The app calls `POST /instance/dispose` (`groups/instance.ts:94-101`) only once no session of that directory is busy, and until then it shows "Vector will ask you to trust this repository's new settings when your running sessions finish." `.vector/skills` is never added to `managedData` (`workspace-trust.ts:21-24`). The CLI prints the file, asks, writes, and prints `git diff`/`git add` guidance and "run `vector trust approve` in a terminal outside Vector".

### 5.8 Export and import

- `export.ts`: `Item` (`:27-41`) gains `skill?: { name, description, procedure, checks, commands, version }`, with no failure excerpt. `KINDS`/`HEADINGS` (`:272-292`) add `skill: "Skills"`.
- Markdown renders each skill as `### name`, then the description, then a fenced `markdown` procedure. `fromMarkdown` (`:316-365`) parses fenced blocks under "Skills".
- `IMPORTED` (`:294`) accepts `skill`. Imports go through `BrainSkill.propose` with `origin: "import"` and wait for review. Imported checks and commands must pass 2.3 or the import is refused `unsafe-command`.

## 6. Feature B: self-tuned workflows (Tokenomics engine)

### 6.1 Observation (engine)

`SessionWorkflow.observe` (new, `packages/engine/src/session/workflow.ts`) is called in the end-of-run block next to `creditRun`. It runs for root, non-internal, non-guest runs whose agent is `build`, when the workflow setting is not `off` and `!Flag.VECTOR_PURE`. It reads `guard.snapshot(sessionID)` synchronously before the block returns, because `guard.end` runs in `Effect.ensuring` (`prompt.ts:2050-2053`), and only then forks the write. The fields:

- `tier`: the request's tier. `effortTier`: `build.offered` when `ProviderTransform.usesCacheBreakpoints(model)`, else `build.tier`, as `prompt.ts:2624-2628` uses.
- `effort` and `effortSource`, checked in this order:
  1. the user's variant (not `default`) → `user`;
  2. an agent variant, or agent options with an `EFFORT_KEYS` key → `agent`;
  3. model or provider options with an `EFFORT_KEYS` key → `config`;
  4. `source === "user"`, or an `explicit:*` or `capped` reason → `explicit`;
  5. the assistant message's `workflow.effort` → `learned` or `explore`;
  6. otherwise → `size`.
- `subagents`, `subagentModel` and `judgeRounds` come from task parts (`tool/task.ts:1052-1071`), the judge excluded.
- `outcome` and `signal`: `recovered` → `pass`; `judged` → `pass`; `SessionMemory.failed(turn)` → `fail`; otherwise `none`. A later revert sets `revert`.
- `costUsd = snapshot.spentUsd` only when every counted step was `priced` (`kinds` has no other key) and `unpricedSteps === 0`; otherwise NULL (I12). `costKinds = snapshot.kinds`.
- Tokens are summed over the run's assistant messages in the root session **and every session descended from it** that was created during the run.
- `partial = 1` when background task jobs of this run were still running at observation (the jobs `revert.ts:150-160` cancels). Partial rows never feed cost.
- `taint`: `SessionMemory.taint(msgs)`. `advice`: what was applied.

`BrainWorkflow.record` upserts on (repository, request). A request that ran more than once **adds**: cost (NULL if either is NULL), `cost_kinds`, steps, unpriced steps, tokens, subagents, judge rounds and `runs + 1`. The newer outcome wins, and an effort or source that differs becomes `mixed`. `SessionRevert` also calls `workflow.reverted(place, { sessionID, requests })`.

### 6.2 Statistics and advice (pure, core `BrainWorkflow`)

- **Weights.** `w = BrainCredit.factor(now - at)`.
- **Excluded rows** (item 15): `effort_source ∈ {user, agent, config, explicit, mixed}`, and `taint === "web"`.
- **Arm** = `(effortTier, effort, split: "solo" | "subagents", providerID, modelID, subagentModel)`.
- `signal` = Σw over rows with outcome ≠ `none`. `passRate` = Σw·[pass] / signal; `fail` and `revert` count as not passing. `lower` is the Wilson one-sided lower bound with z = 1.645 and n = signal. `checkedShare` = signal / Σw over all of the arm's rows.
- **Cost.** The weighted mean `cost_usd` over priced, non-partial rows, when both arms have priced weight ≥ 3. Only for **effort** decisions, and only between arms of the same model, may it fall back to the weighted mean of `input + output + reasoning + 0.1·cacheRead`. Split and subagent-model decisions need priced USD on both arms.
- **Candidates** (cheaper only, same `effortTier` and model):
  - effort `"default"`, only when the default effort is `TaskSize.effort(effortTier) === "high"` (Thorough). `default` sends no effort options (`ProviderTransform.effortOptions`, `packages/engine/src/provider/transform.ts:1343-1347`), while `high` sends `variants.high`. That is the only effort change whose options are known not to add reasoning. Lowering Standard to `low` would turn thinking **on** for Anthropic adaptive models (`transform.ts:655-667, 800-817`), so no such candidate exists (item 12);
  - `split: "solo"` when `effortTier === "thorough"`, `task` is offered, and the user named no subagent;
  - `subagentModel: "small"` when the provider's small model is strictly cheaper by the existing rule (`tool/task.ts:908-929`).
- **Rule.** Advise candidate C over default D iff:
  - `C.signal ≥ MIN_RUNS (6)` and `D.signal ≥ 6`;
  - `C.lower ≥ D.passRate − MARGIN (0.10)`;
  - `C.checkedShare ≥ D.checkedShare − MARGIN`;
  - `cost(C) ≤ CHEAPER (0.8) × cost(D)`.

  Effort, split and subagent model are decided independently.
- **Exploration** (opt-in, `workflow_explore`, default off). When no advice qualifies, a candidate known to be cheaper by construction and with `signal < 6` is applied with `source: "explore"` when `fnv1a(requestID) % 10 === 0`. Only the effort candidate (`default` for `high`) and the small subagent model (strictly cheaper by catalog price) qualify, not solo. The draw is **per request**, and nothing is cached per session or tier (item 35). Never on requests I10 excludes, and never while the cache is warm (6.3).
- **Reason.** `explain(advice)` gives one plain sentence from the weighted counts, for example: "Thorough work here passed 9 of 10 checked runs at default effort (avg $0.41) against 8 of 9 at high (avg $0.93)."

### 6.3 Where advice applies (engine)

- **Decision point.** After `build` is computed (`prompt.ts:2347`), and only when `agent.name === "build"` (item 18). `SessionWorkflow.eligible` checks:
  - I10, including `EFFORT_KEYS`: `reasoningEffort`, `reasoning_effort`, `reasoning`, `reasoningSummary`, `thinking`, `thinkingConfig`, `thinkingBudget`, `enable_thinking` and `effort`, searched at the top level and one level under any provider key of `stepAgent.options`, `model.options` and provider options;
  - `sizing.learn !== false`, mode `apply`, `!Flag.VECTOR_PURE`, not a guest, not internal.

  Then `advice = workflowSession.advice({ session, effortTier, tier, model, result, requestID, warm })`. An advice already carried on an earlier assistant message of the same request wins, so the decision never moves within a request.
- **Warm cache** (item 14). `SessionTaskSize` returns `warm` for each request: the provider caches, there is a previous non-chat request, and `start - end ≤ lifetime` (`session/task-size.ts:128-137`). While `warm`, the effort decision copies the previous request's (its carried `workflow.effort`, or none). Effort, and so thinking settings, therefore change only when the cache is cold, at the session's first request, or when the offered tier changes, which already rewrites the cache.
- **Effort.** Call site `prompt.ts:2624-2628`: `effort: quick ? "off" : build ? (advice?.effort ?? TaskSize.effort(effortTier)) : undefined`. `advice.effort` is only ever `"default"`. `LLMRequestPrep.prepare` (`request.ts:94-114`) is **unchanged**: a user variant still wins, and agent options and the user's variant still merge after `sized`. Because I10 excludes runs with effort keys in `model.options` or provider options, a learned `default` never collides with the user's configured reasoning settings (item 13).
- **Split.** `TaskSize.note(tier, { escalate, judge, solo? })` (`task-size.ts:110-122`) appends, for Thorough: " In this repository, Thorough work has passed as often without subagents for less: split only clearly independent, large parts." `sizeNotes` (`prompt.ts:3755-3790`) takes a `Map<userMessageID, Advice>` built from the `workflow` field of assistant messages already in history, so each request renders the same note on every later step. Tools are not withheld.
- **Subagent model.** `tool/task.ts:903-929` reads `workflowSession.current(parentSessionID)`. When it says `subagentModel === "small"` and `next.name === "general" && !next.model && !freeRoute`, the existing strictly-cheaper `small` computation is reused. Pinned models and explicit variants are untouched.
- **Transparency.** The assistant message (`prompt.ts:2420-2432`) gets `workflow: { effort?, split?, subagentModel?, source, reason }` (9.6). Its `variant` stays the user's pick, so the usage check-in's effort groups are unchanged (`session/session.ts:1321-1322, 1445-1456`).
- **Config.** `sizing.learn?: boolean` (`packages/core/src/v1/config/config.ts:193-204`). The existing untrusted clamp keeps only `judge: "off"` from a cloned repository's `sizing` (`packages/engine/src/config/config.ts:143-149`), so an untrusted repository cannot set `learn` either way, and `config.ts` is not changed for it.
- **Benchmarks.** `VECTOR_PURE=1` turns off Feature A drafting and listing and Feature B observation and advice. Both benchmark harnesses already set it (`script/agent-eval/compounding/harness.ts:331`, `script/agent-eval/footprint.ts:836`), so benchmarks stay deterministic the moment WP2 merges (item 42), with no harness edit in WP2.

### 6.4 The existing model recommender (item 17)

`packages/app/src/features/economics/economics-recommender.ts:91-96` recommends a model and variant per task category from outcomes the app keeps in electron-store or localStorage (`economics-repository.ts:1-3, 80-208`). It needs at least 3 recorded runs (`tokenomics.astro:20-23`).

- **Precedence.** The recommender only suggests. A model or variant the user picks, one taken from a recommendation included, is a user choice: it beats learned defaults (I10) and its runs are excluded from the advice statistics (6.2). Learned defaults apply only where the user left effort on Default. Neither reads the other's data.
- **Erase.** "Erase repository memory", "Erase everything" and "Reset workflow insights" (all tiers) in Settings > Memory also clear the project's recommender outcomes, through the new `clearOutcomes(projectId)` in `economics-repository.ts`. `vector memory erase` cannot reach the app store, and its help says so.
- **Docs.** `tokenomics.astro` says plainly that recommendations (a model to pick, at least 3 runs per kind of task) and learned defaults (effort, split and subagent model, at least 6 checked runs per setting in a repository and size) are separate, with different thresholds.

## 7. Feature C: offline prompt evolution

### 7.1 Harness `script/agent-eval/prompt-evolve/` (new; never shipped, never run in CI)

| File | Role |
|---|---|
| `README.md` | method, limits, isolation, the promotion steps, and that live results are never committed |
| `variants.ts` | `Variant = { id; description; agent; base /* repo path of the built-in prompt */; text?; file?; patches?: { find; replace }[] }`. `render(variant, { explore })` applies the patches (each must match exactly once, else it throws) and then the same explore rewrite as `SystemPrompt.provider` (`session/system.ts:32-37`), because `agent.prompt` replaces that whole block with its rewrite (`request.ts:64-67`) (item 41). Also `load(dir)` |
| `variants/identity.json` | the base text unchanged; zero deltas required on the deterministic suites |
| `contracts.ts` | per-agent required clauses (regexes). `SAFETY` lists every sentence of every built-in prompt that states a safety policy: process safety (`session/system.ts:343-349`), never reverting the user's changes, destructive git, secrets and credentials, asks and permissions, verification, memory as data, Vector Local. `coverage(text, agent)` returns the clauses present |
| `policy.ts` | wraps `compounding/policy.ts` `decide`. A missing clause drops that behaviour in the scripted model, so acceptance can fail. A pure function of the request |
| `traces.ts` | turns `vector export` JSON or `--dump` files into `Trace = { repo?; commit?; prompts; calls }`, redacted with `BrainScan.redact`. Each call keeps its recorded output. Traces are stored **outside the repository**, in `${XDG_STATE_HOME:-~/.local/state}/vector-prompt-evolve/traces/`, with the directory 0700 and files 0600 (item 38) |
| `replay.ts` | the replay policy (7.2) |
| `live.ts` | the isolated live arm (7.3) |
| `run.ts` | CLI: `bun script/agent-eval/prompt-evolve/run.ts --variants a,b [--suite scripted,footprint,replay] [--out dir] [--archive] [--live --yes --max-spend N --prices file --auth-env NAME[,NAME] [--allow-remote]]` |
| `report.ts` | `report.json` and `report.md` (7.4) |
| `*.test.ts` | `variants`, `contracts`, `policy`, `replay`, `live`, `report`, `run` |

Offline suites inject variants only through the child environment that `compounding/harness.ts` builds (`:314-340`). That is `VECTOR_CONFIG_CONTENT` with `agent.<agent>.prompt = render(variant, { explore })` and `permission.memory: "deny"`, with `VECTOR_PURE=1` already set, so learning is off. WP4 exports `environment` and `cli` from `harness.ts` and adds `ArmOptions.config`, merged at `:324-329`, and `ArmOptions.decide`. Footprint gets `--config-content <json>`, merged at `footprint.ts:834`.

Suites:
1. `scripted`: the compounding tasks with the fake Messages server (`compounding/model-server.ts:17-51`) and the clause-aware policy. Deterministic.
2. `footprint`: the four scenarios, with deterministic per-request tokens and cost under cache rules (`prompt-cache.ts`).
3. `replay`: recorded traces, footprint only (7.2). Deterministic.
4. `--live`: owner-gated (7.3).

### 7.2 Replay never touches the owner's repository (item 37)

- **Clone.** `git clone --no-hardlinks --quiet <trace.repo> <scratch>/repo`, then `git remote remove` for every remote, `core.hooksPath` set to an empty directory, and `git checkout --detach <commit>`. There is no `git worktree`, which would share refs, stashes and remotes with the real repository. The scratch directory is under `$TMPDIR` and removed afterwards.
- **Paths.** Recorded absolute paths under the trace's root are rewritten to the clone. A call whose path still resolves outside the clone is not run; its recorded output is replayed.
- **Commands.** Only calls that pass `BrainSkill.helper`, and read, glob and grep tool calls, run against the clone. Every other bash call is replaced by `cat <scratch>/outputs/<n>` of its recorded, redacted output, which keeps the next request's footprint, and edit and write calls apply to the clone.
- **Child environment.** The harness environment plus `VECTOR_SHELL_SANDBOX=1`, which uses the offline network rules (`sandbox.ts:206, 211-221`), and `VECTOR_LOCAL=1`.
- **Test.** The source repository's refs (`git for-each-ref`), stash list, remotes and worktree status are byte-identical before and after a replay of a trace that contains `git push`, `git stash`, `git branch -D` and an absolute-path edit.

### 7.3 Live arm isolation (item 36)

`live.ts` spawns `vector run` with an environment built from scratch, never `process.env` (`script/agent-eval/run.ts:475` inherits it today):
- a temporary `HOME` and `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME`, as `harness.ts:315-322` does;
- `VECTOR_PURE=1`, `VECTOR_AGENT_DB=:memory:`, `permission.memory: "deny"` in `VECTOR_CONFIG_CONTENT`, `VECTOR_DISABLE_AUTOUPDATE=1`, `VECTOR_DISABLE_USAGE=1`, `VECTOR_DISABLE_PROJECT_CONFIG=1`, and a scratch clone as in 7.2;
- only the provider credentials named by `--auth-env`, copied from the owner's environment by name. The harness reads no credential file.

`run.ts` (agent-eval) gains an optional `env` on `capture`, which, when given, is used instead of inheriting. `live.ts` uses it with the task definitions and the pure `score.ts`/`meter.ts`. `--live` requires `--yes`, `--max-spend` and `--prices`, refuses CI, and refuses non-loopback endpoints unless `--allow-remote`. It runs at least 5 repeats per task on a pinned model.

### 7.4 Scoring, report and promotion

- For each variant and suite the report gives pass rate, contract coverage, mean input, output and cache-read tokens, modelled USD and the delta against baseline.
- `report.md` lists **every removed or changed sentence** (a sentence-level diff of base against rendered), each tagged with the contract clause it touches or `uncovered`.
- **`candidate`** (offline): scripted pass rate ≥ baseline, coverage = 100% (every `SAFETY` sentence included), footprint and replay USD ≤ baseline, and no `uncovered` removal of a sentence in `SAFETY`.
- **`promotable`**: `candidate` **and** live non-inferiority, meaning the lower bound of the 95% bootstrap CI of Δpass (variant − baseline) is ≥ −δ, with δ = 0.05 (item 39). Offline suites alone can never make a variant promotable, because they can only reward deleting text no contract covers.
- The `identity` variant must give zero deltas on `scripted`, `footprint` and `replay`, or the report is `invalid`. In live runs, identity is a control arm: if its Δpass CI excludes 0, the report says "live noise too high" and marks nothing promotable.
- Output goes to `--out` (default `$TMPDIR/prompt-evolve-<stamp>`). `--archive` copies a report under `docs/benchmarks/prompt-evolve-<date>/` only when every suite in it is `scripted` or `footprint`. It refuses live results (`script/agent-eval/README.md:319-323`) and replay results, which derive from the owner's private traces (item 40).
- **Promotion.** `report.md` names `variant.base` and prints a unified diff. The owner applies it on a normal branch and PR. The harness never writes under `packages/`.

## 8. Feature D: prompt guard

### 8.1 `PROMPT_SOURCE` ask

`packages/schema/src/permission-policy.ts` adds `export const PROMPT_SOURCE = "prompt_source"`, documented as: "An edit to a file Vector reads into an agent's system prompt or permissions. It asks every time, whatever configuration allows or a client auto-accepts." `requiresApproval` (`:49-56`) includes it, so `canAutoApprove` and the TUI's `canAlwaysAllow` refuse it, and `vector run --auto` rejects it (`packages/engine/src/cli/cmd/run.ts:49-60`). That is why matching is narrow (8.2).

`session/tools.ts:141-160` adds: after the edit `ask` passes, patterns with `PromptSource.is` raise a second ask, `permission: PROMPT_SOURCE, always: []`, in every session. `MEMORY_SOURCE` handling is unchanged. When a tool call whose `PROMPT_SOURCE` ask was approved completes, `PromptTrust.accept(files)` re-hashes those files into the baseline (8.3), so the owner's own approved edits are not held later.

### 8.2 What counts as a prompt source (`packages/engine/src/session/prompt-source.ts`, new)

`PromptSource.is(file, sources)` checks the path and its realpath, as `SessionMemory.source` does (`session/memory.ts:678-683`). `sources` is computed per instance from what Vector actually loads for this directory (item 45):
- the config files `Config` loaded for this directory chain, plus the global ones (`vector.json`, `vector.jsonc`, `config.json`). A `vector.json` elsewhere under the worktree (a test fixture, another package) does not match, so headless CI tasks that edit fixtures are not blocked;
- under each loaded config directory (`config.directories()`): `{agent,agents,mode,modes}/**/*.md` (`config/agent.ts:13, 36`), `{command,commands}/**/*.md` (`config/command.ts:15`), `{skill,skills}/**/SKILL.md` and files beside it (`skill/index.ts:24, 209-212`), and `{plugin,plugins}/**`;
- skill roots outside the workspace: `~/.claude/skills/**/SKILL.md` and `~/.agents/skills/**/SKILL.md` (`skill/index.ts:21-23, 186-194`), and every `skills.paths` entry (`:214-224`);
- global instruction files: `<global config>/AGENTS.md` and `~/.claude/CLAUDE.md` (`session/instruction.ts:146-148`), and `instructions` entries that resolve outside the worktree.

A repository's own `AGENTS.md` is not a prompt source here: it is repository content the user often asks the agent to edit, and it shows in `git diff`.

**Shell writes** (`tool/shell.ts`). Only redirects reach the edit ask today (`:707-718, 1206-1212`). The scanner also adds best-effort write targets to `scan.writes`:
- the last path argument of `cp`, `mv`, `install` and `ln`;
- every path argument of `tee` and of `sed -i`/`--in-place`;
- the `of=` target of `dd`.

`git apply`, `patch`, interpreters (`node -e`, `python -c`, `bash -c`), the V2 bash tool and MCP filesystem servers are not detected. The docs say so, and 8.3 covers what they change.

### 8.3 Instance-start hold (`packages/engine/src/config/prompt-trust.ts`, new)

Modelled on `WorkspaceTrust.snapshot` (`workspace-trust.ts:80-139`):

- **Scope.** Prompt sources outside the trusted workspace: global config directories and their prompt files, skill roots outside the workspace, global instruction files, and the prompt-bearing keys of global config files. Those keys are `agent.*.prompt`, `mode.*.prompt`, `command`, `instructions`, `plugin` and `skills`, hashed as canonical JSON. A whole global config file is never held, since that would cut off providers. Sources inside the workspace are left to workspace trust, which already fingerprints `.vector`, the config files and `.agents/skills`/`.claude/skills` (`workspace-trust.ts:90-105`).
- **Baseline.** `<Global.Path.state>/prompt-trust.json`, mode 0600, holding path → sha256. The first start after upgrade records the current state and holds nothing.
- **Hold.** At each instance start, a source whose hash differs from the baseline, or that is new, is **not loaded**:
  - its skill, command, agent or instruction file is skipped;
  - a global config's prompt-bearing keys are dropped for that instance;
  - `config/config.ts`, `config/agent.ts`, `config/command.ts`, `skill/index.ts` and `session/instruction.ts` each consult `PromptTrust.allowed(file)` at their one load site.
- **Notice and approval.**
  - The TUI and CLI print a one-line notice to stderr ("2 prompt files outside this repository changed since you last approved them; run `vector trust prompts` in a terminal outside Vector").
  - The app shows a banner from `GET /config/prompt-trust`.
  - The owner approves with `vector trust prompts approve` (agent-gated, 2.1) or `POST /config/prompt-trust/approve`. Approval re-hashes into the baseline and disposes the instance.
  - Headless runs continue without the held files.

### 8.4 Description escaping (`skill/index.ts`)

`Skill.fmt` (`:325-350`) applies `escapeHtml` to `description` in the verbose block (`:336`) as it already does for `location` (`:337`), for every skill. Built-in descriptions contain none of `<>&"'`, so their bytes do not change. A disk skill whose description has them changes once.

### 8.5 What the guard is and is not

At runtime only config, agent and mode markdown, skills, commands, instruction files and plugins (`experimental.chat.system.transform`, `request.ts:84-88`) can change a system prompt; built-in prompts are bundled `.txt` imports (`session/system.ts:39-52`). The guard asks before Vector's edit, write and patch tools and the detected shell writes change those files. It holds changed ones outside the workspace until approved. It is not a guarantee that the agent cannot change its prompts, and no doc or UI copy may say so (item 51). `packages/app/src/i18n/en.ts` (next to `:1106`) adds `settings.permissions.tool.prompt_source.*` and `settings.permissions.tool.learned_skill.*`.

## 9. Interfaces (exact)

### 9.1 `packages/core/src/brain/schema.ts`

```ts
export const Kind = Schema.Literals(["rule","preference","decision","lesson","fact","failure","review","term","skill"])
// LearnedKind unchanged
export const SkillLearning = Schema.Literals(["review","auto","off"]).annotate({ identifier: "MemorySkillLearning" })
export const SkillDrafter = Schema.Literals(["off","local-only","always"]).annotate({ identifier: "MemorySkillDrafter" })
export const WorkflowLearning = Schema.Literals(["apply","observe","off"]).annotate({ identifier: "MemoryWorkflowLearning" })
export const Skill = Schema.Struct({
  key: Schema.String, name: Schema.String, description: Schema.String, procedure: Schema.String,
  checks: Schema.Array(Schema.String), commands: Schema.Array(Schema.String), failure: Schema.optional(Schema.String),
  version: Schema.Finite, drafter: Schema.Literals(["rules","model","user","import"]),
  approvedBy: Schema.optional(Schema.Literals(["user","vector"])), approvedAt: Schema.optional(Schema.Finite),
  sharedPath: Schema.optional(Schema.String), sharedAt: Schema.optional(Schema.Finite),
  helpful: Schema.Finite, harmful: Schema.Finite, proven: Schema.Finite,
  uses: Schema.Struct({ loads: Schema.Finite, passes: Schema.Finite, fails: Schema.Finite, ignored: Schema.Finite, reverts: Schema.Finite }),
  instructionLikeFailure: Schema.Boolean, fading: Schema.Boolean,
}).annotate({ identifier: "MemorySkill" })
export const SkillVersion = Schema.Struct({
  version: Schema.Finite, entryID: Schema.String, name: Schema.String, description: Schema.String,
  procedure: Schema.String, checks: Schema.Array(Schema.String), commands: Schema.Array(Schema.String),
  actor: Schema.Literals(["agent","user","vector","import"]),
  reason: Schema.Literals(["learned","edited","imported","rollback"]), createdAt: Schema.Finite,
}).annotate({ identifier: "MemorySkillVersion" })
// Entry gains: skill: Schema.optional(Skill)   (present iff kind === "skill"); Evidence.type gains "run"
```

### 9.2 `packages/core/src/brain/brain.ts`

```ts
export type Refusal = existing | "skill-entry"
export type LearnSettings = existing & { readonly skills: BrainSchema.SkillLearning; readonly skillDrafter: BrainSchema.SkillDrafter; readonly workflow: BrainSchema.WorkflowLearning; readonly workflowExplore: boolean }
export type Stats = existing & { readonly skills: { readonly active: number; readonly review: number } }
// propose: refuses "skill-entry" when supersedes names a skill id; update: refuses "skill-entry" for kind === "skill"
// erase / eraseSession / consolidate: call SkillStore inside their transactions (4.4, 4.5)
readonly setLearnSettings: (change: existing & { skills?; skillDrafter?; workflow?; workflowExplore? }) => Effect.Effect<LearnSettings>
```

### 9.3 `packages/core/src/brain/skill.ts` (new, `export * as BrainSkill from "./skill"`)

```ts
export const PREFIX = "learned-"
export const LIMIT = { name: 64, key: 56, description: 200, procedure: 4_000, steps: 20, checks: 5, commands: 5, paths: 20, listed: 8, failure: 600, skills: 50, pending: 20, perSession: 3, pendingDays: 60, versions: 20 } as const
export const TARGETS: readonly string[]; export const DENY_WORDS: readonly string[]; export const SKILL_TEXT: RegExp
export function simple(command: string): boolean
export function helper(command: string): boolean
export function check(command: string): boolean
export type Trace = { /* 5.2 */ }
export type Draft = { readonly key: string; readonly name: string; readonly description: string; readonly procedure: string; readonly checks: readonly string[]; readonly commands: readonly string[]; readonly failure?: string; readonly paths: readonly string[]; readonly drafter: "rules" | "model" }
export function key(trace: Trace): string | undefined
export function draft(trace: Trace): Draft | undefined
export function intersect(a: Draft, b: Draft, trace: Trace): Draft | undefined
export function match(a: Pick<Draft, "checks" | "commands" | "paths">, b: Pick<Draft, "checks" | "commands" | "paths">): boolean
export function diverged(trace: Trace): boolean
export const PROMPT: string
export function request(trace: Trace): string
export function lock(reply: string, trace: Trace): Draft | undefined
export function card(draft: Pick<Draft, "name" | "description">): string
export function render(entry: BrainSchema.Entry, root: string): { readonly text: string } | { readonly refused: "unsafe-text"; readonly message: string }
export function content(version: BrainSchema.SkillVersion & { readonly failure?: string }): string
export type Listed = { readonly id: string; readonly name: string; readonly description: string; readonly version: number; readonly private: boolean }
export type Outcome = { readonly id: string; readonly version: number; readonly outcome: "pass" | "fail" | "ignored" }
export interface Interface {
  readonly propose: (place: Brain.Place, draft: Draft, meta: { origin: "agent" | "import"; sessionID?: string; requestID?: string; hold?: BrainSchema.Hold; private?: boolean; evidence?: Brain.Evidence; supersedes?: string }) => Effect.Effect<Brain.WriteResult>
  readonly update: (place: Brain.Place, id: string, change: SkillChange) => Effect.Effect<Brain.WriteResult | undefined>
  readonly forget: (place: Brain.Place, id: string) => Effect.Effect<"forgotten" | "not-found">
  readonly get: (place: Brain.Place, id: string) => Effect.Effect<SkillDetail | undefined>
  readonly list: (place: Brain.Place, filter?: Brain.Filter) => Effect.Effect<readonly BrainSchema.Entry[]>
  readonly listing: (place: Brain.Place, input: { readonly query: string; readonly personal: boolean }) => Effect.Effect<readonly Listed[]>
  readonly version: (place: Brain.Place, id: string, version: number) => Effect.Effect<(BrainSchema.SkillVersion & { failure?: string }) | undefined>
  readonly loaded: (place: Brain.Place, input: { id: string; version: number; sessionID: string; requestID: string }) => Effect.Effect<void>
  readonly credit: (place: Brain.Place, input: { sessionID: string; requestID: string; outcomes: readonly Outcome[] }) => Effect.Effect<void>
  readonly reverted: (place: Brain.Place, input: { sessionID: string; requests: readonly string[] }) => Effect.Effect<number>
  readonly shareable: (place: Brain.Place, id: string) => Effect.Effect<{ readonly entry: BrainSchema.Entry; readonly text: string; readonly sessions: readonly string[] } | { readonly refused: "not-found" | "not-approved" | "private" | "held" | "stale" | "unsafe-text"; readonly message: string }>
  readonly shared: (place: Brain.Place, id: string, file: string) => Effect.Effect<"shared" | "not-found">
}
export type SkillChange = { readonly action?: "approve" | "reject" | "archive" | "restore" | "undo" | "rollback"; readonly version?: number; readonly description?: string; readonly procedure?: string; readonly checks?: readonly string[]; readonly commands?: readonly string[] }
export type SkillDetail = { readonly entry: BrainSchema.Entry; readonly evidence: readonly BrainSchema.Evidence[]; readonly versions: readonly BrainSchema.SkillVersion[] }
export class Service extends Context.Service<Service, Interface>()("@vector/BrainSkill") {}
export const layer; export const node = makeGlobalNode({ service: Service, layer, deps: [BrainDatabase.node, Brain.node] })
```

### 9.4 `packages/core/src/brain/workflow.ts` (new, `export * as BrainWorkflow from "./workflow"`)

```ts
export const MIN_RUNS = 6; export const MARGIN = 0.1; export const CHEAPER = 0.8; export const EXPLORE_EVERY = 10; export const PRICED_WEIGHT = 3
export const KEEP = { days: 365, rows: 2_000 } as const
export const EXCLUDED_SOURCES = ["user", "agent", "config", "explicit", "mixed"] as const
export type Outcome = "pass" | "fail" | "revert" | "none"
export type EffortSource = "size" | "learned" | "explore" | "user" | "agent" | "config" | "explicit" | "mixed"
export type Observation = { sessionID; requestID; at; tier: TaskSize.Tier; effortTier: TaskSize.Tier; agent: "build"; providerID; modelID;
  effort: string; effortSource: EffortSource; subagents: number; subagentModel?: "parent" | "small" | "mixed";
  subagentModels: Readonly<Record<string, number>>; judgeRounds: number; outcome: Outcome;
  signal?: "recovered" | "judged" | "judge-fail" | "check-fail"; costUsd?: number; costKinds: Readonly<Partial<Record<SpendGuard.CostKind, number>>>;
  steps: number; unpricedSteps: number; tokens: { input; output; reasoning; cacheRead }; partial: boolean;
  stop?: RunBudget.StopReason; taint?: BrainSchema.Hold; advice?: Advice }
export type Arm = { effortTier; effort: string; split: "solo" | "subagents"; providerID; modelID; subagentModel?: "parent" | "small" }
export type ArmStats = { arm: Arm; rows: number; weight: number; signal: number; passRate?: number; lower?: number; checkedShare: number; costUsd?: number; pricedWeight: number; tokens?: number; lastAt: number }
export type Advice = { effortTier; effort?: "default"; split?: "solo"; subagentModel?: "small"; source: "learned" | "explore"; reason: string; basis: { chosen: ArmStats; instead: ArmStats } }
export type Insights = { mode: BrainSchema.WorkflowLearning; explore: boolean; tiers: readonly { tier; arms: readonly ArmStats[]; advice?: Advice; wouldAdvise?: Advice; excluded: number }[] }
export function stats(rows: readonly Observation[], now: number): ArmStats[]                        // pure
export function advise(input: { stats: readonly ArmStats[]; effortTier; providerID; modelID; defaultEffort: TaskSize.Effort;
  subagentsOffered: boolean; namedSubagents: boolean; smallCheaper: boolean; explore: boolean; requestID: string }): Advice | undefined  // pure
export function explain(advice: Advice): string
export interface Interface {
  readonly record: (place: Brain.Place, observation: Observation) => Effect.Effect<void>   // adds on (repository, request); prunes KEEP; writes the marker
  readonly reverted: (place: Brain.Place, input: { sessionID: string; requests: readonly string[] }) => Effect.Effect<number>
  readonly advice: (place: Brain.Place, input: Omit<Parameters<typeof advise>[0], "stats" | "explore">) => Effect.Effect<Advice | undefined>  // undefined unless mode 'apply'
  readonly insights: (place: Brain.Place) => Effect.Effect<Insights>
  readonly reset: (place: Brain.Place, input?: { tier?: TaskSize.Tier }) => Effect.Effect<number>
}
export const node = makeGlobalNode({ service: Service, layer, deps: [BrainDatabase.node, Brain.node] })
```

### 9.5 `packages/core/src/spend-guard.ts`

`Run.kinds: Readonly<Partial<Record<CostKind, number>>>`, maintained by `afterStep`. Nothing else changes.

### 9.6 `packages/schema/src/v1/session.ts` (Assistant, `:488-515`)

```ts
workflow: Schema.optional(Schema.Struct({
  effort: Schema.optional(Schema.Literal("default")),
  split: Schema.optional(Schema.Literal("solo")),
  subagentModel: Schema.optional(Schema.Literal("small")),
  source: Schema.Literals(["learned", "explore"]),
  reason: Schema.String,
})),
```

### 9.7 `packages/core/src/task-size.ts`

`note(tier, { escalate, judge, solo? })` stays pure. `classify` is unchanged, because the app and desktop share it (`packages/app/src/utils/task-intelligence.ts`, `packages/desktop/src/main/context-budget.ts:150-161`).

### 9.8 Engine

```ts
// session/memory.ts
export const SKILL = "vector.memory.skill"
export function skill(part: SessionV1.Part): { id: string; version: number } | undefined
export function checkTarget(command: string): string
export function skills(turn: readonly SessionV1.WithParts[]): { id: string; version: number; checks: string[]; at: number }[]
export function skillOutcomes(turn: readonly SessionV1.WithParts[], loads: ReturnType<typeof skills>): BrainSkill.Outcome[]
export function failed(turn: readonly SessionV1.WithParts[]): "judge-fail" | "check-fail" | undefined
export function trace(messages: readonly SessionV1.WithParts[], start: number, root: string, loaded?: BrainSkill.Trace["loaded"]): BrainSkill.Trace | undefined
export function writeHold(input: { guest: boolean; held: boolean; messages: readonly SessionV1.WithParts[]; sources: readonly { hold?: BrainSchema.Hold; visibility: string }[]; missing: number }): { hold?: BrainSchema.Hold; private: boolean }
// skill/learned.ts
export interface Interface {
  readonly listing: (input: { session: Session.Info; agent: Agent.Info; model: Provider.Model; guest: boolean; query: string }) => Effect.Effect<readonly Skill.Info[]>   // stored per session, re-filtered per call
  readonly load: (input: { session: Session.Info; agent: Agent.Info; name: string; model: Provider.Model; guest: boolean; requestID: string }) => Effect.Effect<{ info: Skill.Info; id: string; version: number; approvedBy: "user" | "vector" } | undefined>
  readonly fill: (input: { id: string; version: number }) => Effect.Effect<string | undefined>
  readonly share: (place: Brain.Place, id: string, options?: { force?: boolean }) => Effect.Effect<{ type: "shared"; path: string; trust: "changed"; reload: "when-idle" } | { type: "refused"; reason: string; message: string }>
}
// session/skill-learn.ts
export interface Interface { readonly run: (session: Session.Info, taught: ReadonlyMap<MessageID, { message: SessionV1.WithParts; tier: TaskSize.Tier }>, snapshot: SpendGuard.Run | undefined) => Effect.Effect<Effect.Effect<void> | undefined> }
// session/workflow.ts
export const EFFORT_KEYS: readonly string[]
export interface Interface {
  readonly eligible: (input: { session: Session.Info; agent: Agent.Info; stepAgent: Agent.Info; user: SessionV1.User; model: Provider.Model; provider: Provider.Info; result: TaskSize.Result; guest: boolean }) => Effect.Effect<boolean>
  readonly advice: (input: { session: Session.Info; tier: TaskSize.Tier; effortTier: TaskSize.Tier; result: TaskSize.Result; model: Provider.Model; requestID: string; warm: boolean; offered: readonly string[]; namedSubagents: boolean }) => Effect.Effect<BrainWorkflow.Advice | undefined>
  readonly current: (sessionID: SessionID) => Effect.Effect<BrainWorkflow.Advice | undefined>
  readonly observe: (input: { session: Session.Info; taught: …; since: MessageID; run: SpendGuard.Run | undefined; background: number }) => Effect.Effect<void>
}
// session/task-size.ts: each sized request gains warm: boolean
// SystemPrompt.skills(agent, options?: { learned?: readonly Skill.Info[] })
// session/prompt-source.ts
export function sources(input: { config: Config.Interface; global: Global.Interface; directory: string; worktree: string }): Effect.Effect<PromptSource.Sources>
export function is(file: string, sources: PromptSource.Sources): boolean
// config/prompt-trust.ts
export interface Interface { readonly held: () => Effect.Effect<readonly string[]>; readonly allowed: (file: string) => boolean; readonly approve: () => Effect.Effect<number>; readonly accept: (files: readonly string[]) => Effect.Effect<void> }
// cli/owner-gate.ts
export function refuse(what: string): Effect.Effect<void, CliError>
```

`BrainSkill.node` and `BrainWorkflow.node` are registered next to `BrainKnowledge.node` in `packages/engine/src/effect/app-runtime.ts:98-100` and `httpapi/server.ts:249-251`.

## 10. HTTP API

Owner-only `/memory` group (`groups/memory.ts:589+`):

| Method | Path | identifier | Payload | Success |
|---|---|---|---|---|
| GET | `/memory/skills` | `memory.skills.list` | query `filter?: active\|review\|archived\|all` | `MemorySkillList { skills: MemoryEntry[] (with skill), settings: { skills, skillDrafter } }` |
| GET | `/memory/skills/:memoryID` | `memory.skills.get` | — | `MemorySkillDetail { entry, evidence, versions, uses }` |
| PATCH | `/memory/skills/:memoryID` | `memory.skills.update` | `MemorySkillUpdatePayload { description?, procedure?, checks?, commands?, action?: approve\|reject\|archive\|restore\|undo\|rollback, version? }` | `MemorySkillDetail` |
| DELETE | `/memory/skills/:memoryID` | `memory.skills.forget` | — | `{ forgotten: true }` |
| POST | `/memory/skills/:memoryID/share` | `memory.skills.share` | `{ force?: boolean }` | `MemorySkillShared { path, trust: "changed", reload: "when-idle" }`, or `MemoryApiError` with a reason |
| GET | `/memory/workflow` | `memory.workflow.get` | — | `MemoryWorkflowInsights` |
| DELETE | `/memory/workflow` | `memory.workflow.reset` | query `tier?` | `{ removed: number }` |

Owner-only config group (WP5): `GET /config/prompt-trust` (`config.promptTrust.get`: held files, paths only) and `POST /config/prompt-trust/approve` (`config.promptTrust.approve`).

Existing routes change in four ways:
- `MemorySettings`/`MemorySettingsPayload` (`groups/memory.ts:84-110`) gain `skills`, `skillDrafter`, `workflow` and `workflowExplore`.
- `MemoryStats` (`:22-30`) gains `skills: { active, review }`.
- `PATCH /memory/:id`, `DELETE /memory/:id` and the memory tool return not-found or `skill-entry` for skill ids; the learned chip calls the skills routes for skills.
- `DELETE /memory/sessions/:sessionID` and `POST /memory/erase` also remove skill and workflow rows (4.5).

## 11. CLI

New `packages/engine/src/cli/cmd/memory-skill.ts` and `memory-workflow.ts`, registered in `MemoryCommand` (`cli/cmd/memory.ts:24-50`). Gated commands (2.1) are marked `*`.

```
vector memory skills [--review | --archived | --all] [--json]
vector memory skills show <id|name>
vector memory skills approve|reject|undo|archive|restore|forget <id>      *
vector memory skills edit <id> [--description <text>] [--procedure-file <path>]   *
vector memory skills rollback <id> --version <n>                           *
vector memory skills share <id> [--force] [--yes]                         *
vector memory skills learning <review|auto|off>                           *
vector memory skills drafter <off|local-only|always>                      *
vector memory workflow [--tier light|standard|thorough] [--json]
vector memory workflow mode <apply|observe|off>                           *
vector memory workflow explore <on|off>                                   *
vector memory workflow reset [--tier <tier>] [--yes]                      *
vector trust prompts [approve]                                            * (approve)
```

`vector memory approve|reject|undo|forget <id>` no longer reach skills (2.5); their "not found" message for an id in the skill namespace points to `vector memory skills`. `vector run --size/--variant` are unchanged and always beat learned advice.

## 12. App UI (Settings → Memory)

- `memory-model.ts` (`:55-93`): `MemoryTab` adds `"skills" | "workflow"`; `MEMORY_TABS` inserts `{ skills: "Skills" }` after Memory and `{ workflow: "Workflow insights" }` after About you; `kindLabel` adds `skill: "Learned skill"`; `MEMORY_KINDS` is unchanged.
- `settings-registry.ts`: the memory item's keywords add `skills`, `learned skills`, `workflow`, `insights`, `effort`, `tokenomics`.
- **Skills tab** (`memory-skills.tsx`, pure `memory-skills-model.ts`):
  1. Learning mode: "Review first" (default) / "Apply automatically after a second matching success" / "Off". Drafter: "Off" / "Only with Vector Local" (default) / "Always (sends a run's commands, file names and a short error excerpt to your model provider)". One line of privacy copy.
  2. **Needs review**:
     - the card, and why ("Turned `bun typecheck` green in 2 sessions, last 3 days ago");
     - the hold label (`holdLabel`, `memory-model.ts:110-126`) and "The error text reads like instructions" when `instructionLikeFailure`;
     - the expiry (60 days);
     - the procedure, checks, commands and failure excerpt as plain-text `<pre>`, never markup;
     - Edit, Approve and Reject.
  3. **In use**:
     - version, a weight bar from `proven`, loads/passes/fails/ignored/reverts, last used, "fading" and "approved by Vector" badges;
     - Versions (each restore is a rollback), Undo latest version (within `UNDO_DAYS`, `memory-model.ts:227, 281-287`), Archive, Forget;
     - "Share to repository…": a confirm dialog with the path, the exact file preview (no error excerpt), and "This changes repository settings. You'll be asked to trust them again when your running sessions finish."
  4. **Archived and shared**: restore (rollback) or forget.
- **Workflow insights tab** (`memory-workflow.tsx`, `memory-workflow-model.ts`):
  - mode (Apply / Observe only / Off) and an explore toggle;
  - one card per tier: the current default against the learned default, the reason sentence, and an arms table (effort · split · model, runs, pass rate, checked share, average cost or "unknown");
  - reset per tier, and reset all, which also clears recommender outcomes (6.4);
  - fixed copy: "Your own picks always win. Learned defaults only drop Thorough's extra effort, skip subagents or use a cheaper subagent model; spend caps are unchanged."
- **Erase**: "Erase repository memory", "Erase everything" and the session erase in `memory.tsx` (`:726-739, 1252-1258, 1462`) also call `clearOutcomes` for the project (repository and everything scopes).
- **Chips**:
  - `learned.ts` `chipLabel` gets the skill wording ("Drafted a skill for your review: learned-…"), and `learned-chip.tsx` calls `memory.skills.update` for skills.
  - `workflow-chip.tsx` (new) is registered beside `registerLearnedChip()` (`pages/session/session-side-panel.tsx:97, 3816`). It reads `message.workflow` and shows "Learned default · Why", with a popover holding the reason, a link to Workflow insights and "Stop using learned defaults" (mode `observe`).
- **Prompt trust banner** (WP5): `prompt-trust-banner.tsx` shows held prompt files from `GET /config/prompt-trust`, with Approve.

## 13. Docs and website

The site deploys from main. Every new or changed paragraph about these features starts with `release112.since` from a new `release112Copy(published)` in `packages/web/src/data/vector-releases.ts`, modelled on `release111Copy` (`:52-64`): "Coming in desktop 1.99.112:" until `publishedDesktopVersion` (`:24`) reaches 1.99.112, then "From desktop 1.99.112:". `packages/web/test/release-112-docs.test.ts` (new) holds every page below to it, and `release-111-docs.test.ts` and `brain-docs.test.ts` keep passing.

| Page | Change |
|---|---|
| `packages/web/src/pages/docs/brain.astro` | "Learned skills" (trigger, review, auto rules, allowed commands, credit and retirement, versions, undo, privacy: not in shares or for guests, older builds, share) and "Workflow insights"; keep "Only you write rules; Vector never adds one on its own" (`:26`) and add "A learned skill is guidance the agent may load, never a rule." |
| `packages/web/src/pages/docs/skills-and-commands.astro` | where skills come from (disk, URLs, learned); trust; the `skill` and `learned_skill` permissions; sharing to `.vector/skills`; fix the `<name>.md` claim (`:14-20`), which holds only for the core catalog |
| `packages/web/src/pages/docs/tokenomics.astro` | rewrite "Economics that learn" (`:20-23`) so recommendations (3 runs, a suggestion) and learned defaults (6 checked runs, applied only on Default) are distinct; what is measured; cheaper-only; precedence; `sizing.learn`; `--pure`; reset and erase; unknown cost stays unknown |
| `packages/web/src/pages/docs/models.astro` | `:119`: "…then what the session last used. When you leave effort on Default, the request's size sets it, and from 1.99.112 a learned default may drop Thorough's extra effort (Settings > Memory > Workflow insights)." |
| `packages/web/src/pages/docs/terminal-agent.astro` | `:53`: "effort levels" becomes "the effort levels you picked"; learned defaults change no usage total |
| `packages/web/src/pages/docs/local.astro` | learning is local; the skill drafter's own setting (Vector Local by default) |
| `packages/web/src/pages/docs/permissions.astro` (WP5) | `prompt_source`: an ask on edit, write, patch, shell redirects and common shell write commands, every time; the hold for changed prompt files outside the repository; what is not covered (interpreters, the V2 bash tool, MCP filesystem servers); never "cannot change its prompts" (item 51). `learned_skill` |
| `packages/web/src/data/docs-nav.ts` | brain and tokenomics blurbs (`:74-77`) |
| `script/agent-eval/README.md`, `script/agent-eval/prompt-evolve/README.md` (WP4) | the prompt-evolution method, isolation and limits |

**Site claims that depend on code** (item 50). The landing page's "you can see, undo or erase what it learned" (`packages/web/src/components/Lander.astro:424-426`) and statements 1 and 7 below are true for skills only with 5.4 (placeholders), 4.5 (erase, older builds) and 5.2 (drafter setting). `docs/vector/owner-actions/release-199112.md` (new) lists WP1, WP2, WP3 and WP5 and their tests as blocking the 1.99.112 publish. `Lander.astro` is not edited.

## 14. Privacy and telemetry statements (copy used in UI, CLI help and docs)

1. "Learned skills and workflow insights are stored only in brain.db on this computer. Vector sends them nowhere, except that the optional skill drafter, when you set it to Always, sends one run's commands, file names and a short redacted error excerpt to your model provider. By default it runs only with Vector Local on."
2. "Workflow insights record numbers only: size, effort, subagent count, model id, outcome, steps, tokens and cost. They record no prompt or file text."
3. "A skill draft holds commands from a short allowed list, file names and a short redacted error excerpt from your own run. Secrets are refused."
4. "Sessions with an invited guest teach nothing, and guests never see learned skills. Sessions that read the web, used MCP tools, took a subagent's report or read an outside document only draft skills held for your review."
5. "A learned skill's steps stay out of public session shares and exports, and out of requests to models that may train on your prompts."
6. "A skill reaches your team only when you choose Share. Sharing writes one file in `.vector/skills/` that you commit yourself. It carries no error excerpt, session ids, stats or evidence, and Vector checks it against your personal memory first."
7. "Erasing memory, a session's memory or one skill in Vector 1.99.112 or later erases its skills, skill versions, skill uses and workflow records, and rolls back skill text that session taught. An erase of all or of a repository's memory from an older Vector build is finished the next time this version opens that memory; erasing one session from an older build does not reach skills."
8. "Usage check-ins are unchanged and never include skills or workflow data." A test asserts that the values, not just the keys, are unchanged for the CLI and the desktop.
9. Telemetry: none added. Logs and OTLP spans carry counts and entry ids only, never names, paths or text.

## 15. Test plan (focused; each WP runs only its own files)

**WP1, `packages/core`:**
- `test/brain/database.test.ts` (extend, `:78-91`): the migration list includes both new ids.
- `test/brain/migration-learned.test.ts` (new):
  - a fresh database and one at `20261202000000` with data both migrate;
  - entry delete cascades to `brain_skill`;
  - `brain_skill_live_idx` rejects a second live row for a key.
- `test/brain/skill-commands.test.ts` (new): the `simple`/`helper`/`check` matrix.
  - Refused: `make deploy`, `mvn deploy`, `npm run release`, `bun run build && git push`, `make test-db`, `rm -fr x`, `find . -delete`, `bash -c`, `node -e`, `git diff --output=x`, `rg --pre cat`, `cat /etc/passwd`, `cat .env`, `` !`x` ``, `$ARGUMENTS`, `$1`.
  - Accepted: `bun typecheck`, `bun run test:unit`, `cargo clippy`, `./gradlew check`, `xcodebuild test`, `CI=1 bun test`, `git diff src/x.ts`, `rg foo src`.
- `test/brain/skill.test.ts` (new):
  - `draft` is deterministic and keeps raw commands; the description is in the charset, cut to 200 and uses the check target;
  - `lock` rejects unseen commands and paths;
  - the `propose` decision table row by row: auto promotes only two `rules` sightings from different untainted sessions that `match`, with intersection content; a model draft never promotes; an instruction-like failure never promotes; a pending draft's content is unchanged by later sightings; an owned key's new version waits for the owner even in auto;
  - the event detail keeps `pending` = the superseded id and `skillPending` separately, and approve and undo still supersede and reactivate correctly (item 28);
  - restore of a superseded version is a rollback and leaves one live entry (item 29);
  - reject, tidy drop, forget and archived-excess paths leave no version rows; forget removes superseded entries of the key and adds the key tombstone;
  - `eraseSession` on a skill taught in two sessions rolls back to the other session's version; with one session, it deletes;
  - `erase` removes namespace entries, versions, uses, listings and workflow rows;
  - counters: credit pass, fail and ignored; fading after 5 ignored with no pass; archive needs `harmful ≥ 2` (one failure does not archive);
  - the listing ranks by relevance to the query; `render` writes `metadata.version` as a string, strips the failure excerpt, rewrites absolute paths and refuses unsafe text in fenced blocks; `shareable` refusals.
- `test/brain/skill-older-builds.test.ts` (new):
  - a namespace row is never returned by `Brain.list`, digest, recall, candidates, search, `capacity`, consolidate's 300-cap and merge passes, or `Brain.eraseSession`, which are the queries older builds share;
  - deleting the marker tombstone (an older build's repository erase) makes `reconcile` drop the repository's skill and workflow rows;
  - `reworded()` ignores the marker.
- `test/brain/brain.test.ts` (extend): `Brain.update` and `propose` refuse skill ids with `skill-entry`.
- `test/brain/workflow.test.ts` (new):
  - `stats`: decay, Wilson bound, `checkedShare`;
  - `advise`: nothing under `MIN_RUNS`; the only effort candidate is `default` for a size-raised `high`, and none for Standard; never adds subagents; margin, `checkedShare` and cost-ratio boundaries; NULL cost falls back to tokens for effort only; split and subagent-model decisions need priced USD; `web`, user, agent, config, explicit and mixed rows are excluded; a revert counts as a fail;
  - exploration is per request, deterministic, off by default, and limited to effort `default` and the small model;
  - `record` adds repeated runs and marks mixed effort; prunes at 2,000 rows and 365 days;
  - `reverted`, `reset` per tier, and `insights` in observe mode.
- `test/spend-guard.test.ts` (extend): `kinds` counts by kind; limits are unchanged.
- `test/share/archive-learned.test.ts` (new): the public archive of a session that loaded a learned skill carries the placeholder, never the procedure.
- `test/brain/export.test.ts` (extend): skill JSON and Markdown round trips without the failure excerpt; an import lands as proposed; an unsafe imported command is refused.
- `test/task-size.test.ts` (extend): `note(thorough, { solo: true })`; `classify` unchanged.

**WP2, `packages/engine`:**
- `test/session/skill-learn.test.ts` (new, `TestLLMServer`, `memory-sources.test.ts` harness):
  - fail → edit → pass drafts a proposed skill with the raw command;
  - a guest session drafts nothing;
  - a session that read an outside document drafts it held (item 7);
  - web, MCP or subagent taint drafts it quarantined, with no model call;
  - an untrusted repository drafts it held;
  - a `make deploy` recovery drafts nothing;
  - a run that loaded a skill and did the same thing drafts nothing, while a diverged run drafts a new version;
  - the drafter uses its own cancellation map and is skipped when `skillDrafter` is `off`, `local-only` without Vector Local, on a may-train model, or with a stopped or warned run;
  - `VECTOR_PURE=1` drafts nothing;
  - the caps hold.
- `test/session/workflow-learn.test.ts` (new):
  - each observation field, including `effortTier` = offered on a caching provider, child-session tokens, NULL cost for `local`, `plan` and `free` steps, and `partial` with a background task;
  - advice only for `build` and never for the research lead;
  - I10 stops it: user variant, explicit reason, agent variant or options, `model.options.thinking`, provider `reasoningEffort`, `sizing.learn:false`, observe mode, a guest, `VECTOR_PURE`;
  - `model.options` keep their reasoning keys in the prepared request when advice was skipped (item 13);
  - no effort change while the cache is warm; it changes after `lifetime`;
  - advice is stable across a request's steps; the `workflow` field is written and `variant` is unchanged;
  - caps are unchanged.
- `test/session/skill-credit.test.ts` (new):
  - a load whose check never ran is `ignored`, with no helpful added;
  - a load followed by its check passing is `pass`;
  - another check passing does not credit it;
  - revert withdraws drafts and evidence of the reverted requests and harms passes.
- `test/skill/learned.test.ts` (new):
  - the listing is stored in brain.db and identical after an instance dispose and restart (item 34);
  - Vectorscope (`vectorscope.*`), internal and child sessions get none;
  - a guest joining mid-session drops the listing and the next load fails;
  - a may-train model drops private rows;
  - a forgotten skill drops out;
  - a disk skill with the same name wins;
  - the listing location is `learned` and holds no id.
- `test/tool/skill.test.ts` (extend):
  - a learned load stores the placeholder, `metadata[SKILL]` and a use row;
  - the next request's message carries the filled procedure for the owner and the withheld line for a guest or a may-train model;
  - a Vector-approved skill asks `learned_skill`;
  - a name not in the listing is not loadable.
- `test/tool/memory-skill.test.ts` (new): the memory tool refuses `forget` and `update` on a skill id; `writeHold` matches the old hold for every case.
- `test/session/system.test.ts` (extend):
  - the skills block has the escaped card but not the procedure;
  - the first system block is unchanged when skills exist;
  - system blocks are identical with and without workflow advice.
- `test/session/local-carried.test.ts` (new): `carriedOf` counts listed cards and filled skill outputs.
- `test/session/llm-request.test.ts` (extend): with `effort: "default"`, `model.options` thinking keys survive and a user variant still wins.

**WP3:**
- `packages/engine/test/server/memory-skills.test.ts` (new):
  - owner-only (a guest gets 403, as `httpapi-authorization.test.ts`);
  - list, get with versions, update (edit, approve, rollback, restore, undo), forget;
  - share refuses `personal` on a posting-check hit, writes through `writableInside`, and returns `reload: "when-idle"`;
  - settings round-trip;
  - `PATCH /memory/:id` on a skill id is refused.
- `packages/engine/test/server/memory-workflow.test.ts` (new): get insights; reset per tier.
- `packages/engine/test/cli/memory-agent.test.ts` (new): with `VECTOR_AGENT_SESSION` set, every gated command in 2.1 refuses and changes nothing; without it, each works (item 1).
- `packages/engine/test/cli/memory-skill.test.ts` (new): `memory skills`, `skills share --yes`, `workflow --json`, `workflow reset`.
- `packages/engine/test/cli/usage-report-learning.test.ts` (new) and `packages/desktop/src/main/usage-checkin.test.ts` (extend): with skills, a learned-effort assistant message and workflow rows present, the check-in payload **values** equal those of the same history without them.
- `packages/app/src/components/settings-v2/memory-skills-model.test.ts`, `memory-workflow-model.test.ts`, `memory-model.test.ts`: labels, sections, expiry, the undo window, "unknown" cost, reason text, instruction-like and fading badges.
- `packages/app/src/features/economics/economics-repository.test.ts` (extend): `clearOutcomes`.
- `packages/app/src/features/memory/learned.test.ts` (extend) and `workflow.test.ts` (new): chip labels.
- `packages/app/src/components/settings-v2/settings-registry.test.ts` (extend): keywords.
- `packages/web/test/release-112-docs.test.ts` (new): every new paragraph uses `release112.since`; the helper flips at 1.99.112; tokenomics names 3 runs for recommendations and 6 for learned defaults; models.astro mentions the learned default. `brain-docs.test.ts` and `release-111-docs.test.ts` still pass.

**WP4, `script/agent-eval/prompt-evolve/*.test.ts`:**
- `render` patch exactness and the explore rewrite; identity is byte-equal to `SystemPrompt.provider(model, explore)` for both values of `explore`;
- every `SAFETY` sentence of every built-in prompt is covered by a clause;
- clause-aware policy purity;
- identity gives zero deltas on the deterministic suites;
- the rules for `candidate` and `promotable`: no promotion without live; the CI lower bound is compared with −δ;
- the report lists changed sentences;
- `--archive` refuses live and replay;
- `--dry-run` writes only under `--out`;
- traces are written outside the repository with 0700/0600;
- replay leaves the source repository's refs, stash, remotes and status unchanged (7.2);
- the `--live` environment holds no inherited key except the `--auth-env` names, an isolated HOME and XDG directories, `VECTOR_AGENT_DB=:memory:` and `VECTOR_PURE=1`;
- `--live` refusals (no `--yes`, CI, non-loopback without `--allow-remote`).

**WP5:**
- `packages/schema/test/permission-policy.test.ts` (new): `PROMPT_SOURCE` requires approval and cannot be auto-approved.
- `packages/tui/test/util/permission.test.ts` (extend): the same for the TUI helpers.
- `packages/engine/test/session/prompt-guard.test.ts` (new):
  - a `PromptSource.is` matrix: loaded configs only (a fixture `vector.json` is false), config-directory agents, modes, commands, skills and plugins, `~/.claude/skills` and `~/.agents/skills`, `skills.paths`, global `AGENTS.md` and `CLAUDE.md`, symlinked spellings, `src/foo.ts` false;
  - end to end with `TestLLMServer`, against the **global** config directory (`$XDG_CONFIG_HOME/vector/agents/build.md` and the global `vector.json` setting `agent.build.prompt`): the edit tool's and a `cp` command's writes each raise the `prompt_source` ask, and the test asserts the ask happened and was rejected, the files are unchanged, and the next system prompt is byte-identical (item 44);
  - a write through `node -e` (not asked) is held at the next instance start: the system prompt lacks the new text until `PromptTrust.approve`, and an edit approved through the ask is not held;
  - `vector run --auto` editing a fixture `vector.json` in the worktree is not blocked.
- `packages/engine/test/cli/trust.test.ts` (extend): `trust approve` and `trust prompts approve` refuse under the agent marker.
- `packages/engine/test/skill/fmt.test.ts` (new): descriptions are escaped; the built-in description bytes are unchanged.

## 16. Work packages (strict file ownership; no file appears in two packages)

**Order.** WP1 first. WP2 needs WP1. WP3 needs WP1 and WP2 (routes call `LearnedSkill.share`; SDK regeneration). WP5 needs WP3 (`cli/owner-gate.ts`). WP4 depends on nothing in this build and may merge at any point. Benchmarks stay deterministic through every merge because `VECTOR_PURE=1` turns learning off (6.3). Merge order: WP1 → WP2 → WP3 → WP5, with WP4 anywhere.

### WP1: Core brain data, learning logic and shared schemas
- `packages/core/src/brain/schema.ts`, `sql.ts`, `database.ts`, `brain.ts`, `export.ts`
- `packages/core/src/brain/migration/20261210000000_learned_skills.ts` (new), `20261211000000_workflow.ts` (new)
- `packages/core/src/brain/skill.ts` (new), `skill-store.ts` (new), `workflow.ts` (new)
- `packages/core/src/spend-guard.ts` (`Run.kinds` only)
- `packages/core/src/share/archive.ts` (learned-skill placeholder)
- `packages/core/src/task-size.ts`, `packages/core/src/v1/config/config.ts` (`sizing.learn`)
- `packages/schema/src/v1/session.ts` (`Assistant.workflow`)
- Tests: `packages/core/test/brain/database.test.ts`, `migration-learned.test.ts` (new), `skill-commands.test.ts` (new), `skill.test.ts` (new), `skill-older-builds.test.ts` (new), `brain.test.ts`, `workflow.test.ts` (new), `export.test.ts`; `packages/core/test/spend-guard.test.ts`; `packages/core/test/share/archive-learned.test.ts` (new); `packages/core/test/task-size.test.ts`

### WP2: Engine runtime (learning, credit, delivery, advice)
- `packages/engine/src/session/memory.ts`, `prompt.ts`, `revert.ts`, `system.ts`, `task-size.ts` (`warm`)
- `packages/engine/src/session/skill-learn.ts` (new), `workflow.ts` (new)
- `packages/engine/src/skill/learned.ts` (new)
- `packages/engine/src/tool/skill.ts`, `tool/memory.ts`, `tool/task.ts`
- `packages/engine/src/agent/agent.ts` (`learned_skill: "ask"` default)
- `packages/engine/src/effect/app-runtime.ts`, `packages/engine/src/server/routes/instance/httpapi/server.ts` (node registration only)
- Tests: `packages/engine/test/session/skill-learn.test.ts` (new), `workflow-learn.test.ts` (new), `skill-credit.test.ts` (new), `local-carried.test.ts` (new), `system.test.ts`, `llm-request.test.ts`; `packages/engine/test/skill/learned.test.ts` (new); `packages/engine/test/tool/skill.test.ts`, `memory-skill.test.ts` (new)

### WP3: Surfaces (HTTP, CLI, SDK, app UI, economics, docs)
- `packages/engine/src/server/routes/instance/httpapi/groups/memory.ts`, `handlers/memory.ts`
- `packages/engine/src/cli/owner-gate.ts` (new)
- `packages/engine/src/cli/cmd/memory.ts`, `memory-doc.ts`, `memory-skill.ts` (new), `memory-workflow.ts` (new)
- Generated SDK and client, regenerated only: `packages/sdk/js/openapi.json`, `packages/sdk/js/src/gen/**`, `packages/sdk/js/src/v2/gen/**` (`./packages/sdk/js/script/build.ts`); `packages/client/src/generated/**`, `packages/client/src/generated-effect/**` (`bun run generate` in `packages/client`, if affected)
- `packages/app/src/components/settings-v2/memory.tsx`, `memory-model.ts`, `memory-model.test.ts`, `memory-skills.tsx` (new), `memory-skills-model.ts` (new), `memory-skills-model.test.ts` (new), `memory-workflow.tsx` (new), `memory-workflow-model.ts` (new), `memory-workflow-model.test.ts` (new), `settings-memory.css`, `settings-registry.ts`, `settings-registry.test.ts`
- `packages/app/src/features/memory/learned.ts`, `learned.test.ts`, `learned-chip.tsx`, `workflow.ts` (new), `workflow.test.ts` (new), `workflow-chip.tsx` (new), `workflow-chip.css` (new)
- `packages/app/src/features/economics/economics-repository.ts`, `economics-repository.test.ts`
- `packages/app/src/pages/session/session-side-panel.tsx` (one import and one register call)
- `packages/web/src/pages/docs/brain.astro`, `skills-and-commands.astro`, `tokenomics.astro`, `local.astro`, `models.astro`, `terminal-agent.astro`
- `packages/web/src/data/docs-nav.ts`, `packages/web/src/data/vector-releases.ts`
- `docs/vector/owner-actions/release-199112.md` (new)
- Tests: `packages/engine/test/server/memory-skills.test.ts` (new), `memory-workflow.test.ts` (new); `packages/engine/test/cli/memory-agent.test.ts` (new), `memory-skill.test.ts` (new), `usage-report-learning.test.ts` (new); `packages/desktop/src/main/usage-checkin.test.ts`; `packages/web/test/release-112-docs.test.ts` (new), `brain-docs.test.ts`, `release-111-docs.test.ts` (run, edited only if wording they pin moves)

### WP4: Offline prompt evolution
- `script/agent-eval/prompt-evolve/**` (new: `README.md`, `run.ts`, `variants.ts`, `variants/identity.json`, `contracts.ts`, `policy.ts`, `traces.ts`, `replay.ts`, `live.ts`, `report.ts`, tests)
- `script/agent-eval/compounding/harness.ts` (export `environment` and `cli`; `ArmOptions.config`, `ArmOptions.decide`)
- `script/agent-eval/footprint.ts` (`--config-content`)
- `script/agent-eval/run.ts` (`capture` gains an explicit `env`)
- `script/agent-eval/README.md`
- No `.gitignore` change: traces live outside the repository.

### WP5: Owner trust and prompt guard
- `packages/schema/src/permission-policy.ts`
- `packages/engine/src/session/prompt-source.ts` (new), `packages/engine/src/config/prompt-trust.ts` (new)
- `packages/engine/src/session/tools.ts`, `tool/shell.ts`, `session/instruction.ts`
- `packages/engine/src/skill/index.ts` (hold filter; `fmt` escaping)
- `packages/engine/src/config/config.ts` (hold of global prompt-bearing keys; loaded-file list), `config/agent.ts`, `config/command.ts` (hold filter)
- `packages/engine/src/cli/cmd/trust.ts` (agent gate; `trust prompts`)
- `packages/engine/src/server/routes/instance/httpapi/groups/config.ts`, `handlers/config.ts` (`/config/prompt-trust`)
- `packages/app/src/i18n/en.ts`, `packages/app/src/components/prompt-trust-banner.tsx` (new) and its mount in `packages/app/src/pages/layout-new.tsx`
- `packages/web/src/pages/docs/permissions.astro`
- SDK regeneration for the config routes (same generated paths as WP3, regenerated again, never hand-edited)
- Tests: `packages/schema/test/permission-policy.test.ts` (new); `packages/tui/test/util/permission.test.ts`; `packages/engine/test/session/prompt-guard.test.ts` (new); `packages/engine/test/cli/trust.test.ts`; `packages/engine/test/skill/fmt.test.ts` (new)

The generated SDK files are regenerated by WP3 and again by WP5. They are build outputs, never hand-edited, so this is the one sanctioned overlap: WP5 regenerates after rebasing on WP3.

## 17. Risks and the decision taken for each

| Risk | Decision |
|---|---|
| The agent approves for itself from the shell | agent-marker gate on every owner command (2.1); HTTP owner-only, sidecar password not passed to children |
| A skill names a destructive or exfiltrating command | positive helper and check allowlists, simple commands only, deny words; `learned_skill` ask for Vector-approved skills; permissions still apply |
| Auto mode promotes planted or one-off text | rules drafter only, two matching untainted sightings, intersection, instruction-like failure blocks, owner-approved keys wait |
| Skill credit reinforces itself | credit only on the skill's own check; ignored loads fade; relevance-ranked listing; diverged runs may draft new versions |
| Procedures leak through transcripts and public shares | placeholder in the transcript, filled per request where personal memory may go; archive defence |
| Older builds see or keep skill rows | `skill:<repo>` namespace; marker tombstone and `reconcile`; documented limit for an older session erase |
| Effort "lowering" turns thinking on | the only effort move is `high` → `default`; no ladder |
| Learned effort overrides config or breaks the cache | I10 effort keys; no change while the cache is warm; keyed on the offered tier |
| Biased statistics | explicit-choice rows excluded; checked-share guard; partial rows out of cost; NULL for non-priced steps; child tokens |
| Two recommenders disagree | stated precedence; shared erase; docs separate the two |
| Prompt files changed outside asks | `prompt_source` ask with best-effort shell detection; instance-start hold outside the workspace; workspace trust inside |
| Guard blocks headless CI | matches only loaded configs and real prompt directories |
| Replay or live runs touch the owner's data | clone without remotes, sandboxed offline, recorded outputs for side effects; isolated HOME/XDG, auth by name only, brain off |
| Offline scoring rewards deleting safety text | `SAFETY` coverage, sentence-level report, live non-inferiority required |
| REAL values in integer columns | counters are new integer columns; `helpful`/`harmful` stay REAL and are never assumed integers |
| Two runtimes diverging | V1 only, stated as a non-goal; `TaskSize.classify` untouched |
| Upstream naming | docs and code name no upstream project |

## 18. Review changes

The revision addresses all 51 review points. Items accepted as written: 1, 3, 4, 6, 8, 10, 11, 13, 14, 15, 18, 20, 21, 22, 23, 25, 27, 28, 29, 30, 31, 32, 33, 34, 36, 38, 39, 40, 41, 43, 45, 46, 47, 48, 49, 50 and 51.

Where they land:
- Owner gates and command safety (items 1, 2, 3, 8): section 2.
- The write gate (items 5, 6, 28): 5.3.
- Delivery (items 9, 10, 20-23): 5.4 and 5.7.
- Credit (items 11, 30, 31): 5.5.
- Erase and older builds (items 25, 26): 4.5.
- Feature B (items 12-18, 35): section 6.
- The drafter (item 19): 5.2.
- The harness (items 36-41): section 7.
- The guard (items 43-45, 51): section 8.
- Docs (items 48-50): section 13.
- Tests and ownership (items 46-47): sections 15-16.

The points below were met in a different way from the one the review proposed, or partly set aside, and why:

- **Item 2, the ask.** A plain `skill` ask for every `learned-*` name would also ask on every load of a skill the owner approved. The build adds a separate `learned_skill` permission, asked only for skills `approved_by = "vector"`. It defaults to ask and is documented in `permissions.astro`.
- **Item 7.** The hold computation moves into `SessionMemory.writeHold` as a pure function. Resolving the read documents stays with the caller, because `knowledge.sources` is an Effect service call that `session/memory.ts`, a pure module, cannot make. Both callers share the code.
- **Item 9.** `render` **refuses** text containing `` !` ``, `$ARGUMENTS` or `$<digit>` anywhere, fenced blocks included, rather than rewriting it. Neutralised text would differ from the approved text the owner reviewed. Generated commands cannot contain those characters at all (2.3).
- **Item 12.** The review allowed per-provider ladders backed by verified order and priced data. This build takes the narrower branch: the only effort move is a size-raised `high` back to `default`, for every provider. A verified ladder needs provider data the repository does not have and is left out.
- **Item 16.** The review offered child-session tokens **or** no token fallback for split and subagent decisions. The build does both, because child tokens alone still compare runs with different subagent models.
- **Item 17.** The build does not merge the two data sources. The recommender lives in the app store and also serves desktop-only flows; learned defaults must be readable by the CLI. The build states the precedence, makes erase and reset clear both, and makes the docs explain the 3 against 6 thresholds.
- **Item 24, "do not dispose while busy".** The route never disposes. It returns `reload: "when-idle"`, and the app disposes once the directory has no busy session.
- **Item 26.** The review's namespace suggestion is adopted. An older build's **session** erase cannot be detected afterwards, so that gap is stated in statement 7 rather than claimed fixed. Repository and full erases from older builds are completed by the marker check.
- **Item 37, "network denied".** Replay runs only allowlisted read-only commands and replays recorded output for everything else, so no command with side effects runs. The child shell also uses the existing offline sandbox. An OS-level network block for the whole child process is not added; the sandbox covers the shell, and the model server is the local fake.
- **Item 42.** The review offered two options; the build takes the second, `VECTOR_PURE=1` turns learning off. Both harnesses already set it, so no harness edit has to land in WP2 and benchmarks stay deterministic from WP2's merge. The cost: a user's own `--pure` runs also skip learned skills and defaults. The docs say so, and it fits what `--pure` is for.
- **Item 44, the hold scope.** A changed global `vector.json` is not held as a whole file, which would cut off providers and auth. Only its prompt-bearing keys are held. Prompt sources inside the workspace are left to workspace trust, which already fingerprints them.
- **Item 43, project instruction files.** A repository's own `AGENTS.md` is not made a prompt source. It is repository content users routinely ask the agent to edit, and it is visible in `git diff`. The global instruction files the review named are covered.
- **Item 20, `share: "auto"`.** The config description says public sharing is ignored (`v1/config/config.ts:61-63`), but `packages/engine/src/share/session.ts:48-56` still auto-publishes with consent. The review's premise therefore holds, and the description is left for a separate fix outside this build.
