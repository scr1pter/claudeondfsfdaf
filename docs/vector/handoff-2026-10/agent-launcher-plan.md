# Plan: the "Host locally" agent launcher

**Inputs.** The research JSON stopped partway through the goose entry. Everything about goose after its install line, and everything about Copilot CLI, pi, Factory Droid, Amp, Antigravity CLI, Kimi Code CLI and Junie CLI, comes from quick web checks I made for this plan. Most of those were search snippets, so those facts are marked **(low)**. The OpenRouter ranking I used is the CLI Agents list at openrouter.ai/apps/category/coding/cli-agent. It counts tokens sent through OpenRouter, so agents people mostly use with their own subscription are under-counted there. Vector's own upstream engine is left out.

**Status markers used below.** "Unknown" means Vector can't tell whether the agent is signed in, and the UI shows that rather than "signed out" (this matches `signedIn?: undefined` in the existing code).

## 1. Agents to ship (16, in order)

**Tiers.** In the **full-chat** tier, Vector runs the agent's command line without its terminal screen, reads the agent's event output, and shows the run in its own chat view. **Terminal-only** agents run inside Vector's built-in terminal in the isolated workspace, with no event reading.

**Logo plan.** "Official" means the vendor's own unchanged file, labelled with the plain-text name, with nothing that implies a partnership. "Letters" means a neutral two-letter badge, used until the vendor gives written permission.

### 1. Claude Code (Anthropic) — full-chat
- **Command:** `claude`
- **Install:**
  - `curl -fsSL https://claude.ai/install.sh | bash` (macOS, Linux, WSL)
  - `irm https://claude.ai/install.ps1 | iex` (Windows)
  - `brew install --cask claude-code`
  - `winget install Anthropic.ClaudeCode`
  - Drop the current npm install, which the Claude Code README marks as deprecated.
- **Sign-in:** `claude auth login`.
- **Status check:** `claude auth status` prints JSON and exits 1 when logged out.
- **Headless:** `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages --permission-mode acceptEdits [--model <m>] [--resume <id>]`
- **Parser:** already shipped. Use the `capabilities` field in the init event to check which features this version supports.
- **Models:** a fixed list of the documented names (default, sonnet, opus, haiku, opusplan, sonnet[1m], opus[1m]) plus a free-text box.
- **Logo:** letters. Anthropic needs written permission (marketing@anthropic.com).
- **Risks:**
  - Anthropic forbids third parties from offering claude.ai login or routing plan credentials. Vector must only run the unchanged command and must never read `~/.claude` or the keychain.
  - Wording should be "run your installed Claude Code", not "use your Claude plan in Vector". Legal should review before launch.
  - Anthropic plans to make `--bare` the default for `-p`. Bare mode ignores subscription sign-in, so this integration breaks for subscription users when that ships.
  - Since v2.1.302, `-p` runs start in Manual mode, so shell commands are denied unless Vector adds a prompt tool (`--permission-prompt-tool`) for approvals.

### 2. Codex CLI (OpenAI) — full-chat
- **Command:** `codex`
- **Install:**
  - `curl -fsSL https://chatgpt.com/codex/install.sh | sh`
  - Windows: `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`
  - `npm install -g @openai/codex`
  - `brew install --cask codex`
- **Sign-in:** `codex login`, or `codex login --device-auth` for a device code.
- **Status check:** `codex login status`.
- **Headless:** shipped. `codex exec --json --sandbox workspace-write --skip-git-repo-check -C <cwd> [-m <m>] "<prompt>"`. Resume with `codex exec resume --json … <id> "<prompt>"`.
- **Parser:** shipped. Events are thread, turn and item JSONL.
- **Models:** live list from `codex debug models`, which is experimental. If that fails, offer "Recommended (default)" plus free text. Never hard-code the list: GPT-5.5 left ChatGPT sign-in on 14 Oct 2026.
- **Logo:** letters. OpenAI requires co-branding approval.
- **Risks:**
  - `~/.codex/auth.json` can hold credentials in plain text. Vector must never read it.
  - `codex app-server` is marked "not supported for production workloads".
  - Flags change often (`--full-auto` was removed).

### 3. Cursor Agent (Anysphere) — full-chat
- **Command:** `agent`, with `cursor-agent` as the old alias. Check both.
  - `agent` is a generic name, so confirm with `agent --version` that it really is Cursor's before trusting it.
- **Install:**
  - `curl https://cursor.com/install -fsS | bash`
  - Windows: `irm 'https://cursor.com/install?win32=true' | iex`
- **Sign-in:** `agent login`.
- **Status check:** `agent status --format json`.
- **Headless:** `agent -p --trust --force --output-format stream-json [--model <m>] [--resume <id>] "<prompt>"`
- **Parser:** shipped. Event types are system/init, assistant, tool_call and result.
- **Models:** live list from `agent models`. This needs sign-in and a network connection, so cache it.
- **Logo:** official file from cursor.com/brand, labelled "Cursor".
- **Risks:**
  - Cursor's acceptable-use policy mentions "automated means" (seen only on a forum, secondary source). Cursor staff call the CLI "the official and safe path".
  - Without `--force`, nothing is written to disk.
  - The CLI ships updates almost daily.

### 4. GitHub Copilot CLI (GitHub) — full-chat (low)
- **Command:** `copilot`
- **Install:**
  - `npm install -g @github/copilot` (Node 22+)
  - `winget install GitHub.Copilot`
  - Homebrew: GitHub's own pages disagree between `brew install copilot-cli` and `--cask copilot-cli`.
- **Sign-in:** `/login` inside `copilot`, which is interactive, so it runs in the built-in terminal.
- **Status check:** none documented, so status shows as unknown.
- **Headless:** `copilot -p "<prompt>" --output-format json [--model <m>] --allow-tool write --allow-tool 'shell(git:*)'`. Full approval is `--allow-all-tools`, for the isolated workspace only.
- **Parser:** the JSON output is one object per line, but the event format is undocumented. Parse defensively from recorded samples.
- **Models:** fixed list from GitHub's supported-models page plus free text.
- **Logo:** letters until GitHub's logo policy for Copilot is checked (low).
- **Risks:**
  - Users who get Copilot through an organisation need that organisation to enable the Copilot CLI policy.
  - Runs count against premium-request limits.
  - The flags for resuming a run (`--resume`, `--continue`) are undocumented.

### 5. Gemini CLI (Google) — full-chat
- **Command:** `gemini`
- **Install:** `npm install -g @google/gemini-cli` or `brew install gemini-cli`.
- **Sign-in:** run `gemini` and choose Sign in with Google, in the built-in terminal.
- **Status check:** none documented, so status shows as unknown.
- **Headless:** `gemini -p "<prompt>" --output-format stream-json --approval-mode auto_edit [-m <m>]`
- **Parser:** events are init, message, tool_use, tool_result, error and result. Accept both `session_id` and `sessionId`.
- **Models:** fixed list of the names auto, pro, flash and flash-lite.
- **Logo:** official icon from geminicli.com/brand-kit, unchanged, with the clear space the guidelines require. This is my reading of the guidelines, not a licence.
- **Risks:**
  - Since 18 Jun 2026, Google AI Pro, Ultra and free users can't use Gemini CLI. Only Code Assist Standard/Enterprise licences and paid API or Vertex keys work. Label it "Work or API accounts".
  - Google's terms say using its sign-in (OAuth) through third-party tools may get the account suspended.

### 6. Antigravity CLI (Google) — terminal-only (low)
- **Command:** `agy`
- **Install:** official command still to be confirmed.
- **Sign-in:** a browser sign-in on first run.
- **Why terminal-only:** a reported bug (GitHub issue #318, v1.0.6) makes `agy -p` hang with no output when it isn't attached to a real terminal. Revisit when that is fixed.
- **Models:** none in Vector; the user switches models inside the agent.
- **Logo:** letters.
- **Why ship it:** this is where Google sent consumer Pro/Ultra users after the Gemini CLI cutoff.

### 7. Muse Code (Meta) — full-chat
- **Command:** `muse`
- **Install:**
  - `curl -fsSL https://dev.meta.ai/install.sh | sh`
  - `irm https://dev.meta.ai/install.ps1 | iex`
  - Link only to dev.meta.ai, because lookalike domains exist.
- **Sign-in:** a browser sign-in on first run, or `/login`.
- **Status check:** none documented, so status shows as unknown.
- **Headless:** `muse serve`, Meta's stable versioned session protocol, which is the recommended route. Fallback: `muse exec --json --model <m> "<prompt>"`, whose event format is undocumented.
- **Models:** live list from `model/list` over `muse serve`.
- **Logo:** letters. Meta requires approval.
- **Risks:**
  - The subscription credential is "for use with Muse Code only".
  - "Contributor mode" is on by default and lets Meta train on user content. Vector must tell users.
  - Meta can revoke subscriptions immediately.

### 8. Kilo Code (Kilo) — full-chat
- **Command:** `kilo`
- **Install:**
  - `npm install -g @kilocode/cli`
  - `curl -fsSL https://kilo.ai/cli/install | bash`
  - `brew install Kilo-Org/tap/kilo`
- **Sign-in:** `kilo auth login`.
- **Status check:** `kilo auth list`; read provider names only.
- **Headless:** `kilo run --format json [-m provider/model] [-s <id>] "<prompt>"`. Without `--auto`, every permission request is rejected. `kilo acp` gives an approval flow.
- **Models:** live list from `kilo models`, which reads a local cache.
- **Logo:** official repo logo. Kilo explicitly allows this to show compatibility.
- **Risks:**
  - Telemetry is on by default.
  - Kilo Auto Free may route prompts to providers that log them.

### 9. Cline (Cline Bot) — full-chat
- **Command:** `cline`
- **Install:** `npm install -g cline`.
- **Sign-in:** `cline auth`.
- **Status check:** none documented, so status shows as unknown.
- **Headless:** `cline --json --auto-approve <true|false> [-P provider] [-m <m>] [--id <sid>] "<prompt>"`. Always pass `--auto-approve` explicitly, because it defaults to true.
- **Models:** fixed list per provider plus free text.
- **Logo:** official bot icon from the cline.bot/brand ZIP.
- **Risks:**
  - Don't surface Cline's relay provider for Claude subscriptions; Anthropic's terms govern that use.
  - Vector must not touch the Codex credentials file that Cline can import.

### 10. pi (badlogic/pi-mono, MIT) — full-chat (low)
- **Command:** `pi`
- **Install:** `npm install -g @mariozechner/pi-coding-agent`. The package may have moved to the `@earendil-works` scope; check the registry.
- **Sign-in:** `/login` inside pi, or an API key.
- **Status check:** unknown.
- **Headless:** `pi --mode json` (JSON events) or `pi --mode rpc` (a line-based JSON protocol). Prefer `rpc`.
- **Models:** free text plus the provider's model list.
- **Logo:** letters until a logo file in the repo is confirmed.
- **Risk:** pi's own Claude Pro/Max sign-in is the third-party claude.ai login Anthropic forbids. Never promote pi as a way to use a Claude plan.

### 11. Factory Droid (Factory) — full-chat (low)
- **Command:** `droid`
- **Install:** `curl -fsSL https://app.factory.ai/cli | sh`, or `npm install -g droid`.
- **Sign-in:** `droid`, interactive.
- **Status check:** unknown.
- **Headless:** `droid exec --output-format stream-json --auto medium [-m <m>] "<prompt>"`. Use `stream-jsonrpc` for runs with several turns. Without `--auto`, the agent can only read.
- **Models:** fixed list plus free text.
- **Logo:** letters.
- **Risk:** billing is Factory credits or a Factory plan, not someone else's subscription.

### 12. Amp (Amp) — full-chat (low)
- **Command:** `amp`
- **Install:** `curl -fsSL https://ampcode.com/install.sh | bash`, or `npm install -g @sourcegraph/amp`. Both came from third-party sources; verify on ampcode.com.
- **Sign-in:** `amp login`.
- **Headless:** `amp -x --stream-json "<prompt>"`; `--stream-json-input` accepts several turns.
- **Models:** Amp has no model picker. Vector should only expose Amp's own mode setting.
- **Logo:** letters.
- **Risk:** billing is Amp credits or ad-supported Amp Free, so it is a weak fit for "use your existing subscription".

### 13. Qwen Code (Alibaba) — full-chat
- **Command:** `qwen`
- **Install:**
  - `npm install -g @qwen-code/qwen-code@latest`
  - `brew install qwen-code`
  - The official standalone script (hosted on qwen-code-assets.oss-cn-hangzhou.aliyuncs.com)
- **Sign-in:** only through `/auth` inside the agent, so it needs the built-in terminal.
- **Status check:** unknown.
- **Headless:** `qwen -p "<prompt>" --output-format stream-json --include-partial-messages --approval-mode auto-edit [-m <m>] [--resume <id>]`
- **Parser:** close to Claude Code's event shape, so it can share a parser with differences per field.
- **Models:** fixed list of the plan's models. Do not read `~/.qwen/settings.json`, because it can hold API keys.
- **Logo:** official repo SVG.
- **Risks:**
  - Coding Plan terms ban use from "custom applications" and have threatened key bans. Keep every run started by the user.
  - The free OAuth tier ended 15 Apr 2026.

### 14. Kimi Code CLI (Moonshot) — full-chat (low)
- **Command:** `kimi`
- **Install:** `uv tool install --python 3.13 kimi-cli`, or `curl -LsSf https://code.kimi.com/install.sh | bash`.
- **Sign-in:** `/login` inside the agent.
- **Headless:** `kimi acp` (preferred), or `kimi -p "<prompt>" --output-format stream-json`, which is reported only by the community.
- **Models:** fixed list.
- **Logo:** letters.
- **Risk:** the subscription terms for Kimi membership are unverified.

### 15. goose (Agentic AI Foundation) — full-chat (low)
- **Command:** `goose`
- **Install:** `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash`, or `brew install block-goose-cli`. That formula conflicts with an unrelated `goose` formula.
- **Sign-in:** `goose configure`, which sets up the provider.
- **Headless:** `goose run --output-format stream-json --no-session -t "<prompt>"`.
- **Models:** free text, or the provider and model set in its configuration.
- **Logo:** repo logo if the Linux Foundation trademark policy allows naming use; otherwise letters.
- **Risk:** mostly bring-your-own-key, with a weak subscription fit.

### 16. Junie CLI (JetBrains) — terminal-only (low)
- **Command:** `junie`
- **Install:** the official script, a PowerShell command, or the Homebrew tap from junie.jetbrains.com/docs.
- **Sign-in:** JetBrains Account login, which uses the subscription, in interactive mode only.
- **Why terminal-only:** the headless mode needs a `--auth` token, and that is billed by usage, not by subscription.
- **Logo:** letters.

## 2. Dropped
- **Hermes Agent and OpenClaw:** both are personal or messaging agents, not built for coding. Hermes has no official JSON output.
- **omp:** a fork of pi, so it would duplicate entry 10.
- **Strix:** a security and penetration-testing agent.
- **Not coding command lines, or no description on the ranking page:** Proto Agent, DeepSeek Harness, Freebuff, CodeGPT, Letta, mimocode.
- **OpenHands CLI:** headless mode always auto-approves and can't be changed, and it is bring-your-own-key only. Revisit through its agent server.
- **Aider and Crush:** bring-your-own-key only, no structured output, and low usage. They are candidates for the terminal-only tier in a later release.
- **Kiro CLI, Continue CLI and Roo Code:** not researched, or no maintained terminal command line. Candidates for a later release.
- **Warp and Zed:** a terminal app and an editor, not agent command lines.

## 3. Build plan

### One catalog
Today two lists are kept in sync by hand: `packages/app/src/features/agents/external-runtimes.ts` and `packages/desktop/src/main/external-agents.ts`. The comment in the desktop file says so.

Replace both with one data-only catalog that both sides import. `@vectordevai/schema` works, because app and desktop both already depend on it. Each entry has:
- `id`, `name`, `vendor`, `binaries[]` (the first one wins), `tier`, `minVersion`
- `install[]`: platform, method, the exact official command, and the docs link
- `signIn`: command and whether it is interactive
- `statusProbe?`, a builder for the headless command (fresh run and resume), `modelFlag`, a `parser` id
- `models`: live (with its command) / fixed (with the list) / none
- `logo`: official (file path plus the brand-rule note) or letters (letters plus colour)
- `notes`: billing and terms warnings
- `docsUrl`, `termsUrl`

Then derive from the catalog everything that is hard-coded today:
- the `ExternalRuntime` type and `isExternalRuntime`
- the `["claude-code","codex","cursor"]` arrays in `packages/app/src/pages/layout-new.tsx` (around lines 1326 and 1333)
- `CANDIDATES`, `RUNTIME_SETUP` and `AUTH_PROBE` in the desktop file

### The picker
- A "Host locally" dialog built on the pattern in `packages/app/src/components/dialog-select-model.tsx`.
- Search at the top. Each row has the logo or letters on the left, the name, and a status pill on the right: Ready / Signed out / Not installed / Checking / Unknown.
- Clicking a row opens a detail view with Connect, Sign in or Install, plus the billing and terms note.
- Interface copy must never use the word "project".

### Install flow
- Show the exact official command for this platform and its source link.
- Nothing runs until the user clicks "Run in terminal" after seeing the command. Also offer "Copy".
- Run it in the built-in terminal (`packages/app/src/components/terminal.tsx`) so the user sees `sudo`, Gatekeeper and other prompts. Never run it hidden in the background.
- After it exits, run `refreshAgentEnvironment()` and detect again. This needs a new refresh option on `external-agents-detect`, because detection results are cached for 60 seconds and there is no refresh option today.

### Sign-in flow
- Always the agent's own login command, run in the built-in terminal.
- Vector never reads, copies or passes credentials, keychain entries or tokens.
- When the terminal exits, check the sign-in status again.

### Status detection
- Use the existing PATH search across shell setups and version managers, plus a version check and minimum-version gating per entry.
- Add a status probe only where the agent documents a local one, which today is Claude Code, Codex, Cursor and Kilo. Every other agent shows Unknown.

### Terminal-only agents
- Open the built-in terminal in the isolated workspace from the existing `prepareWorkspace` step.
- Review changes through the git worktree diff the same way as today.

### Event parsers and approvals
- One parser per event family: Claude/Qwen, Codex, Cursor, Gemini, Kilo, Cline, Droid, Amp, Copilot, pi, goose.
- Second milestone: one Agent Client Protocol client (ACP, a JSON protocol several agents speak over stdin and stdout). It covers Cursor `agent acp`, Gemini `--experimental-acp`, Kilo, Cline, Kimi and goose, and would give real approve/deny buttons. A Muse `muse serve` client sits beside it.

### Model picker per agent
- Reuse the model dialog.
- Live lists come through the desktop process with a timeout and a cache. Fixed lists come from the catalog.
- Every agent also gets "Agent default" (pass no model flag) and a "Custom model ID" box.

### Tests
- **Catalog check:**
  - every install link is https on the vendor's own domain
  - no third-party logo files
  - a logo is marked official only where the brand rules allow it
- **Command builders:** fresh run, resume and model flag for every agent, with no `--bare` and no credential flags.
- **Parsers:** fixture tests from recorded real output, with secrets removed.
- **Sign-in probes:** a table of `signedInFromProbe` cases.
- **Detection:** fake command lines through the existing `env` seam.
- **A guard test:** no code path reads `~/.claude`, `~/.codex/auth.json`, `~/.gemini`, `~/.qwen` and similar.
- **End to end:** a picker test in `packages/app/e2e`, plus one live run per agent on a real machine before each one is enabled.

## 4. Open questions for the owner
1. **Logos:** you asked for real logos, but Claude Code, Codex and Muse need written permission. Copilot, Antigravity, Droid, Amp, Kimi, pi and Junie are unclear. Can we ship letters for those, with a switch to official logos once permission arrives? Who contacts Anthropic, OpenAI and Meta?
2. **Wording:** Anthropic's terms favour "run your installed Claude Code" over "use your subscription in Vector". Will you get a legal review before launch?
3. **Gemini CLI:** ship it labelled "Work or API accounts", with Antigravity as terminal-only for consumer users? Or wait?
4. **Install commands:** can Vector run official `curl | bash` commands in its built-in terminal after the user confirms, or should it only offer Copy?
5. **Default approval level:** keep the current safe default in the isolated workspace (accept edits / workspace write), or allow full auto (Cursor already uses `--force`)?
6. **Agents billed in their own credits** (Amp, Droid, Kilo, Cline): are these acceptable, given the pitch is "use your existing subscriptions"?
7. **Disclosures:** should the app show Muse's "Contributor mode" training, Kilo's telemetry, and where Qwen and Kimi host data?
8. **Windows:** in the first release or later?
9. **Versions:** what minimum versions and update policy, given several of these CLIs ship almost daily?

### Sources (new facts beyond the research JSON)
- https://openrouter.ai/apps/category/coding/cli-agent
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli
- https://docs.factory.ai/reference/cli-reference
- https://ampcode.com/docs/cli/execute-mode
- https://ampcode.com/news/streaming-json
- https://app.unpkg.com/@mariozechner/pi-coding-agent@0.73.1/files/README.md
- https://goose-docs.ai/docs/guides/running-tasks
- https://github.com/google-antigravity/antigravity-cli/issues/318
- https://computingforgeeks.com/antigravity-cli-cheat-sheet/
- https://cdn.jsdelivr.net/gh/moonshotai/kimi-cli@main/README.md
- https://junie.jetbrains.com/docs/junie-headless.html
- https://docs.openhands.dev/openhands/usage/cli/headless

**Code read for the build plan:**
- `packages/desktop/src/main/external-agents.ts`
- `packages/app/src/features/agents/external-runtimes.ts`
- `packages/app/src/pages/layout-new.tsx`
- `packages/app/src/components/dialog-select-model.tsx`