**Vector flexibility: what's already there**

Unless a path says "repo root", file paths are under `main/packages/`, on shipped main 6eaf445a (desktop 1.99.111). I only read code and docs and ran nothing. The status labels are:

- **Documented:** shipped and in the docs.
- **Undocumented:** shipped but not in the docs.
- **Off:** built but switched off.
- **Code only:** exists in code, but nothing uses it.
- **Next CLI:** in the desktop's engine now, but not in the published npm CLI (1.99.99).

## 1. Short answer

Vector is already very flexible, and in more places than the docs show.

- **Models:** you can plug in almost any model. The built-in catalog has 219 providers and 8,184 models. You can also add any OpenAI-compatible server, any AI SDK package, or your own Ollama or LM Studio machine.
- **Where it runs:** Vector can run as a server. You can then drive it from another computer, a browser, an editor, a script or your own app.
- **What it connects to:** it connects to MCP servers, and it can run 15 other coding agent CLIs inside it.
- **Extending it:** you add agents, commands, skills, tools and plugins as plain files in `.vector/`. Files in a project's `.vector/` load only once that repository is trusted.
- **Controlling it:** you can set permissions per tool, spend caps, effort and memory.

The catch is that a lot of the best flexibility isn't in the docs. That includes custom providers, the plugin hook API, connecting the desktop app to a remote server, and the HTTP API. A few pieces are built but switched off. Writing docs for what already ships is the cheapest win you have.

## 2. The most flexible parts

### Models and providers
- **A huge catalog:** 219 providers and 8,184 models. 179 providers use a generic OpenAI-compatible connector. The rest use native ones: Anthropic, OpenAI, Google, Vertex, Azure, Bedrock, Mistral, Groq, xAI, Cohere, Perplexity, the Cloudflare and Vercel gateways, and more.
  - Where: Settings → Providers & keys, `vector providers login`, or just an environment variable such as `OPENAI_API_KEY`.
  - Status: Documented. Connecting automatically from an environment variable is Undocumented.
  - Evidence: `web/public/models/api.json`; `schema/src/provider-policy.ts:21-245`; `engine/src/provider/provider.ts:2094-2107`.
- **Any OpenAI-compatible server:** the Custom provider dialog takes an ID, base URL, key (or `{env:NAME}`), headers and models. "Detect" reads the server's model list.
  - Where: Settings → Providers & keys → Custom provider.
  - Status: Undocumented.
  - Evidence: `app/src/components/dialog-custom-provider-form.ts:182-196`.
- **Any AI SDK package:** `provider.<id>.npm` names any npm SDK, which Vector installs at runtime, or a `file://` path.
  - Where: vector.json.
  - Status: Undocumented.
  - Evidence: `engine/src/provider/provider.ts:2643-2663`.
- **Send any provider through a proxy or gateway:** use `provider.<id>.options.{baseURL, headers, timeout, concurrency}`.
  - Status: Undocumented.
  - Evidence: `core/src/v1/config/provider.ts:76-128`.
- **Add a model that isn't in the catalog:** use `provider.<id>.models.<model>`. You can set limits, price, image input, tool calling, reasoning and custom effort levels.
  - Status: Undocumented.
  - Evidence: `core/src/v1/config/provider.ts:8-74`.
- **Enterprise clouds:** Bedrock (profile, region, endpoint), Azure, Vertex (project, location), Cloudflare AI Gateway, SAP AI Core and Snowflake Cortex.
  - Where: environment variables or `provider.<id>.options`.
  - Status: Undocumented.
  - Evidence: `engine/src/provider/provider.ts:498-1195`.
- **Models you host (Vector Local):** Vector finds Ollama, LM Studio, vLLM, llama.cpp and SGLang on this computer. You can also add any server address, and it recognises LiteLLM proxies.
  - Where: Settings → Vector Local, `/local` in the TUI, `vector local …`, `vector run --local`.
  - Status: Documented. The CLI commands are Next CLI.
  - Evidence: `web/src/pages/docs/local.astro`; `engine/src/cli/cmd/local.ts:26-293`.
- **A different model for each job:** you can set the main `model`, a `small_model` for titles and summaries, `agent.<name>.model` and `command.<name>.model`. Vector Local adds six role pickers for hosted models: main, subagents, judge, Vectorscope, titles, and deep research.
  - Status: `model` is Documented. The others are Undocumented.
  - Evidence: `core/src/v1/config/config.ts:77-82`; `core/src/v1/config/agent.ts:12-41`; `app/src/features/local/local-model.ts:605-670`.
- **Reasoning effort:** use the Default / Light / Balanced / Max slider, `--variant`, or `ctrl+t` in the TUI. You can define your own effort levels with any provider options under `provider.<id>.models.<m>.variants`.
  - Status: The slider and `--variant` are Documented. Custom levels are Undocumented.
  - Evidence: `engine/src/provider/transform.ts:549-1100`; `core/src/v1/config/provider.ts:63-73`.
- **Automatic choices:**
  - "Automatic model routing" sends hard tasks to a stronger model from the same provider. It is off by default.
    - Where: Settings → General → Verified completion.
    - Status: Undocumented. The changelog only mentions "model routing" in passing.
    - Evidence: `app/src/components/settings-v2/general.tsx:259-264`; `app/src/components/prompt-input/submit.ts:793-826`.
  - Image routing switches an image to a model that accepts images. It is always on in the desktop app and has no setting.
    - Status: Undocumented.
    - Evidence: `submit.ts:796-816`.
  - The `sizing.auto` config key (default true) picks the effort for each request.
    - Status: described only in the config schema.
    - Evidence: `core/src/v1/config/config.ts:193-204`.
- **Your own catalog source:** `VECTOR_MODELS_URL`, `VECTOR_MODELS_PATH`, `VECTOR_DISABLE_MODELS_FETCH`.
  - Status: Documented.
  - Evidence: `web/src/pages/docs/models.astro:106-108`.
- **Allow and block lists:** `enabled_providers`, `disabled_providers`, model `whitelist` and `blacklist` per provider, and a hide switch per model in Settings → Default models.
  - Status: Undocumented.
  - Evidence: `core/src/v1/config/config.ts:71-76`; `app/src/components/settings-v2/models.tsx:22-140`.

### Where it runs and what it connects to
- **15 other coding agents inside Vector ("Host locally"):** Claude Code, Codex, Cursor CLI, Copilot CLI, Gemini CLI, goose, Amp, Cline, Kilo, Qwen Code, Kimi Code, Junie, Factory Droid, pi and Muse Code.
  - Each uses its own sign-in and has a model picker. Up to four run at once, and each works in its own copy of the repository.
  - Status: Documented.
  - Evidence: `web/src/pages/docs/external-agents.astro:32`; `schema/src/external-agent.ts:203-1035, 1096`.
- **Headless server:** `vector serve --port --hostname --cors`, or a `server` block in vector.json. The owner password comes from `VECTOR_SERVER_PASSWORD`.
  - Status: The flags and the owner password are Documented. The `server` block, `--mdns` and the guest variables that `vector invite` sets are Undocumented.
  - Evidence: `engine/src/cli/cmd/serve.ts:6-23`; `engine/src/cli/network.ts:6-91`; `core/src/v1/config/server.ts:6-18`.
- **Connect the desktop app to a Vector server on another machine:** add the address, username and password, then "Set as default". Each server shows its health and version.
  - Where: Settings → Environment & servers.
  - Status: Undocumented.
  - Evidence: `app/src/components/settings-v2/servers.tsx:19-144`.
- **WSL on Windows:** "Add WSL" installs Vector inside Linux and runs it there, on the 1.99.99 engine.
  - Status: Documented.
  - Evidence: `web/src/pages/docs/terminal-agent.astro`.
- **Browser UI:** `vector web`.
  - Status: Documented.
  - Evidence: `engine/src/cli/cmd/web.ts:31-84`.
- **Drive a running server from a terminal:**
  - `vector attach <url>`: Documented.
  - `vector run --attach <url>` for scripts: Undocumented.
  - `vector tasks` to manage that server's subagents: Undocumented.
  - Evidence: `engine/src/cli/cmd/attach.ts:9-61`; `engine/src/cli/cmd/run.ts:267-280`; `engine/src/cli/cmd/tasks.ts:10-35`.
- **Live multiplayer:** `vector invite` gives you an owner link and a guest link.
  - Status: Documented. `--public-url` (for a tunnel), `--trusted-network` and the guest limits are Next CLI.
  - Evidence: `web/src/pages/docs/multiplayer.astro:18-19`.
- **Build your own client:** an HTTP API covers sessions, a live event stream, answering permission prompts, files, MCP, terminals and remote control of the TUI. `vector serve` serves its OpenAPI spec at `/doc`, and there is a JS SDK.
  - Status: The API is Undocumented. The SDK is Documented, but its docs say publication is pending, and `sdk/js/package.json` is private.
  - Evidence: `engine/src/server/routes/instance/httpapi/server.ts:211`; `engine/src/server/routes/instance/httpapi/groups/*`; `web/src/pages/docs/sdk.astro:6`.
- **Editors:** `vector acp` speaks the Agent Client Protocol. Editors that use it get sessions, model and effort pickers, and can pass in their own MCP servers.
  - Status: Documented in one line only.
  - Evidence: `engine/src/cli/cmd/acp.ts:6-73`; `web/src/pages/docs/terminal-agent.astro:110`.
- **MCP servers:** local (stdio) or remote (HTTP, falling back to SSE), with OAuth and headers. Secrets go in as `{env:VAR}` or `{vault:KEY}`. MCP prompts become slash commands.
  - Where: `mcp` in vector.json, `vector mcp add|list|auth|debug`, desktop Connections → MCP, or `/mcps` in the TUI.
  - Status: The CLI is Documented. The config format is Undocumented. The desktop dialog is mentioned only in passing.
  - Evidence: `core/src/v1/config/mcp.ts:6-63`; `engine/src/cli/cmd/mcp.ts:95-680`; `engine/src/mcp/index.ts:147-190`.
- **Connector catalog:** 133 connectors in 21 categories, while the docs say 135. About 58 use OAuth, 39 a token and 36 no sign-in. 17 are marked "coming soon" and can't be installed. Of the rest, 70 are remote and 46 are local.
  - Where: desktop → Plugins.
  - Status: Documented, but only the 70 remote connectors install today (see section 3).
  - Evidence: `app/src/components/plugins/catalog.tsx`; `web/src/pages/docs/mcp-and-plugins.astro:11`.
- **GitHub:** `vector github install` writes a workflow and asks for the provider, model, automatic review and a monthly cap. You comment `/vector` or `/vs` on pull requests. Rules go in `.vector/review.md`, and 27 settings (limits, filters and models) go in `.vector/review.json`.
  - Status: Documented. Some workflow settings are Undocumented: `PROMPT` (needed for scheduled and manual runs), `MENTIONS` (custom trigger words) and `GITHUB_SERVER_URL` (GitHub Enterprise links).
  - Evidence: `core/src/review/config.ts:77-106`; `engine/src/cli/cmd/github.handler.ts:429-430, 483, 820-835`.
- **GitLab:** "Push to GitLab" from Vector Cloud. Self-managed instances use `VECTOR_GITLAB_HOST` with `VECTOR_GITLAB_CLIENT_ID`.
  - Status: Undocumented.
  - Evidence: `desktop/src/main/gitlab-auth.ts:11-19`.
- **Vercel and Supabase accounts:** deploys, environment variables, database and migrations. Desktop only.
  - Status: Documented.
  - Evidence: `web/src/pages/docs/cloud-services.astro`.
- **Company config from your own server:** `vector providers login <url>` reads `<url>/.well-known/vector` and merges that config on every start.
  - Status: Undocumented.
  - Evidence: `engine/src/config/config.ts:1971-2006`.
- **Your own monitoring:** `experimental.openTelemetry` with `OTEL_EXPORTER_OTLP_ENDPOINT` sends traces to your own collector.
  - Status: Undocumented.
  - Evidence: `core/src/v1/config/config.ts:217`; `core/src/observability/otlp.ts:10`.
- **Browser agent:** desktop only.
  - Status: Documented.
  - Evidence: `web/src/pages/docs/browser-agent.astro`.
- **Scheduled automations:** they run once, daily, on weekdays or weekly, across several repositories. Desktop only.
  - Status: Documented.
  - Evidence: `web/src/pages/docs/automations.astro`.

### Extending it
- **Code plugins with about 20 hooks:** one of these hooks, `permission.ask`, never fires.
  - A plugin can add tools, providers and sign-in methods.
  - It can change temperature or headers per request.
  - It can rewrite tool input, tool output and the system prompt.
  - It can add environment variables to the shell, set a custom compaction prompt, and react to every event.
  - Where: the `plugin` array, a file in `.vector/plugins/`, or `vector plugin <module>`.
  - Status: Installing plugins is Documented. The hook API is Undocumented. The docs say the plugin package isn't published to npm yet.
  - Evidence: `plugin/src/index.ts:226-347`; `web/src/pages/docs/mcp-and-plugins.astro:53`.
- **One-file custom tools:** a file in `.vector/tools/*.ts` that exports `tool({description, args, execute})`.
  - Status: Undocumented.
  - Evidence: `engine/src/tool/registry.ts:233-259`.
- **Custom agents:**
  - Where: Markdown files in `.vector/agents/`, or `agent.<name>` in config.
  - You can set the model, prompt, temperature, step cap, permissions and colour.
  - You can also override built-in agents, set `default_agent`, or have `vector agent create` write one for you.
  - Status: The files are Documented. The field list is Undocumented.
  - Evidence: `core/src/v1/config/agent.ts:12-81`; `engine/src/config/agent.ts:13-29`.
- **Custom slash commands:** files in `.vector/commands/*.md`.
  - Templates support `$ARGUMENTS`, `$1..$n`, `` !`shell` `` snippets and `@file` references.
  - Each command can set its own model or agent.
  - Status: The files are Documented. The template syntax is Undocumented.
  - Evidence: `engine/src/session/prompt.ts:4053-4100`.
- **Skills:** SKILL.md folders from `.vector/`, `~/.claude/skills`, `~/.agents/skills`, `skills.paths`, or remote `skills.urls`.
  - Status: Documented. The extra sources are Undocumented.
  - Evidence: `engine/src/skill/index.ts:21-25, 182-235`.
- **Instructions:** AGENTS.md or CLAUDE.md (nested ones load automatically), `.vector/RULES.md`, and the `instructions` key, which takes file patterns or URLs.
  - Status: RULES.md is Documented. The `instructions` key is Undocumented.
  - Evidence: `engine/src/session/instruction.ts:146-160`; `core/src/v1/config/config.ts:124`.
- **Terminal UI:** plugins, 33 bundled themes, about 180 rebindable actions, and sounds, all set in `tui.json`.
  - Status: Undocumented.
  - Evidence: `plugin/src/tui.ts:91-600`; `tui/src/config/keybind.ts:40-240`.
- **Formatters (26 built in) and language servers (38 built in):** both stay off until you set `formatter` or `lsp`, and they run only in a trusted repository. You can add your own.
  - Status: Undocumented.
  - Evidence: `engine/src/format/index.ts:121-133`; `engine/src/lsp/lsp.ts:228-234`; `core/src/v1/config/lsp.ts:9-79`.
- **Config layers:** global, project, `.vector/`, a machine-only `vector.local.json`, and inline `VECTOR_CONFIG_CONTENT`. Any of them can use `{env:VAR}` and `{file:path}` substitution.
  - Status: Partly documented.
  - Evidence: `engine/src/config/config.ts:1972-2199`; `engine/src/config/variable.ts:33-61`.

### Controlling it
- **Permissions per tool and pattern:** allow, ask or deny for bash, edit, read, web, browser, cloud and any MCP tool. Patterns such as `"git status*"` work, and you can set rules per agent.
  - Where: `permission` in vector.json.
  - Status: The idea is Documented. The full list of keys is Undocumented.
  - Evidence: `core/src/v1/config/permission.ts:5-48`.
- **Approval modes:** Manual, Plan and Full access in the composer, and `vector run --auto` for scripts.
  - Status: Plan and `--auto` are Documented. Manual and Full access are Undocumented.
  - Evidence: `app/src/components/prompt-input.tsx:1625-1662`; `web/src/pages/docs/vector-agent.astro:26`.
- **Shell sandbox:** `VECTOR_SHELL_SANDBOX=1` runs shell commands in a sandbox and hides secret folders from them.
  - Status: Documented.
  - Evidence: `engine/src/tool/shell/sandbox.ts:32-77`.
- **Spend limits:** separate caps for work you watch and for automations, per run, day and month. The CLI's `--max-cost` and `--max-steps` are Next CLI.
  - Where: Settings → Spend limits.
  - Status: Documented.
  - Evidence: `web/src/pages/docs/tokenomics.astro:34`; `web/src/pages/docs/terminal-agent.astro:63-65`.
- **Repository trust:** an untrusted repository can't add plugins, MCP servers, providers or agents.
  - Status: Documented.
  - Evidence: `web/src/pages/docs/permissions.astro`.
- **Company lock:** a managed vector.json, a macOS profile or a Windows registry entry. `locked_keys` pins model choice and other settings.
  - Status: Documented.
  - Evidence: `web/src/pages/docs/local.astro`.
- **Memory:** turn learning on or off, choose what kinds of thing it learns, and export or import.
  - Where: Settings → Memory, or `vector memory …` (Next CLI).
  - Status: Documented.
  - Evidence: `web/src/pages/docs/brain.astro`.
- **Context:** `compaction.{auto, prune, tail_turns, max_context}`, `tool_output` limits, and `snapshot: false`.
  - Status: Undocumented.
  - Evidence: `core/src/v1/config/config.ts:56-59, 136-177`.

## 3. Built but switched off or undocumented (quick wins)

**Built but blocked or unreachable (cheap fixes):**
- **All 46 local connectors in the Plugins catalog fail to install.** Each one uses an `@latest` or versionless command, or a Docker image without a digest. The install check throws "not pinned".
  - A test confirms this for Supabase.
  - The docs say plugin runtimes "install themselves", but the pin check blocks these before that step.
  - Fix: pin the versions in the catalog.
  - Evidence: `app/src/components/plugins/catalog.tsx:183-197, 221-229`; `app/src/components/dialog-select-plugins.tsx:88`; `catalog-security.test.ts:15-20`.
- **The desktop shortcut editor exists but can't be opened.**
  - It is mounted only in the old settings dialog, and `newLayoutDesigns` is hard-wired on.
  - The docs say shortcuts are editable.
  - Evidence: `app/src/components/dialog-settings.tsx:8, 67`; `app/src/context/settings.tsx:279`; `web/src/pages/docs/desktop-app.astro:56`.
- **The shell picker is also only in the old settings dialog.**
  - Evidence: `app/src/components/settings-general.tsx:106-109`.
- **The agent's `lsp` tool is off unless `VECTOR_EXPERIMENTAL_LSP_TOOL` or `VECTOR_EXPERIMENTAL` is set.** The docs present it as a standard tool.
  - Evidence: `engine/src/effect/runtime-flags.ts:40`; `web/src/pages/docs/vector-agent.astro:36`.

**Switched off on purpose (turn on when the service is ready):**
- **Provider sign-ins:** ChatGPT, xAI, Poe, DigitalOcean, GitLab and Copilot. The docs say these are paused.
  - Evidence: `core/src/provider-policy.ts:20-24`; `schema/src/provider-policy.ts:4`; `web/src/pages/docs/models.astro:24`.
- **Vector Codium (the managed model plan):** the client has shipped. The server enables it only when `MODEL_PLANS_ENABLED=true`, and the internal doc says that flag is kept false.
  - Evidence: repo root `api/_lib/model-plan-config.ts:116`; repo root `docs/vector/MODEL-PLANS.md`.
- **Vector GitHub App (branded commits):** behind `VECTOR_GITHUB_APP_ENABLED`. The internal status doc lists it as switched off pending registration.
  - Evidence: repo root `api/_lib/github-app.ts:47`.
- **Vector Teams (`vector org`):** behind `VECTOR_TEAMS_ENABLED`.
  - Evidence: repo root `api/_lib/teams.ts:148`.
- **Public session sharing:** the `share` key is ignored.
- **Remote workspaces from plugins:** behind `VECTOR_EXPERIMENTAL_WORKSPACES`.
- **Model help for reading documents:** behind `VECTOR_KNOWLEDGE_DISTILL`.

**Code only (finish it or delete it):**
- **SSH remote servers:** the connection type is declared, but nothing implements it.
  - Evidence: `app/src/context/server.tsx:307-328`.
- **The `permission.ask` plugin hook:** declared but never fired.
  - Evidence: `plugin/src/index.ts:273`.
- **Settings that are accepted but never read:**
  - the config keys `enterprise.url`, `local.recommend` and `experimental.batch_tool`
  - the app setting `settings.permissions.autoApprove`
  - `experimental.policies` provider denies, which the current engine ignores
- **Unused modules:** the editor-detection module and the scheduled-task `cloud` field.

**Shipped and only needing a docs page (biggest return):**
- **Custom providers and models:** the dialog's help link points to /docs/models, which doesn't cover them.
- **Connecting the desktop app to a remote server.**
- **The plugin hook API and one-file tools.**
- **Agent fields and command templates:** the schema's links redirect to /docs/subagents#custom-agents and /docs/skills-and-commands#commands, and neither page lists these.
- **The HTTP API:** `vector serve` already serves an OpenAPI spec at `/doc`.
- **Smaller CLI and TUI items:** `run --attach`, `vector tasks` and `/connect`.
- **Connecting providers from environment variables.**
- **Provider allow and block lists.**
- **Automatic model routing.**
- **The MCP config format.**
- **The organisation well-known config.**
- **OpenTelemetry export.**
- **Terminal UI themes and keybinds.**
- **Config keys:** `instructions`, `skills.paths/urls`, `formatter`, `lsp` and `compaction`.

**Places where the docs and code disagree:**
- **Permission order:** the docs say deny always wins. In the engine, the last matching rule wins, so the order of keys in your config matters.
  - Evidence: `engine/src/permission/index.ts:31-44`; `web/src/pages/docs/permissions.astro:10`.
- **Skills named `<name>.md`:** the docs say these work, but the scanner only finds SKILL.md.
  - Evidence: `engine/src/skill/index.ts:23-25`; `web/src/pages/docs/skills-and-commands.astro:16`.
- **Saved "Always allow" answers:** the docs say you can clear them, but no app screen does it. Only the API does.
- **Catalog size:** the docs say 135 connectors, and the catalog has 133.

## 4. Gaps where Vector is less flexible than it could be

1. **The catalog's provider list is frozen.** A custom catalog file or a refresh can't add a new provider ID; new IDs come only from config or the Custom provider dialog. Idea: let `VECTOR_MODELS_PATH` or the remote policy add new IDs.
2. **The list of external agents is fixed in code at 15.** Idea: an `external_agents.<name>` config block with command, args and model flag, so users can add any CLI.
3. **The desktop app has one look, while the TUI has 33 themes.** Idea: let the desktop read the same theme JSON files.
4. **Hooks need JavaScript.** There is no config key for shell-command hooks. Idea: a `hooks` key that runs commands before or after a tool, and at session start or end.
5. **There are no webhooks.** Idea: outbound webhooks for "run finished" and "approval needed", and an inbound one that starts a run.
6. **Automations and the browser agent only work in the desktop app.** Idea: run both on `vector serve`, with a headless browser on the server.
7. **There is no SSH remote, and clients can't discover servers on the network,** even though Vector already advertises itself over mDNS. Idea: finish the SSH type using the same flow as WSL, and add "Find servers on my network".
8. **The desktop and the terminal keep separate global config folders.** A setting in `~/.config/vector/vector.json` doesn't reach the desktop. Only `~/.vector/` and the repository's `.vector/` are read by both. Idea: an optional shared config, or "Import from terminal".
9. **The Default models page in desktop Settings only has show and hide switches.** Idea: add pickers for per-agent model, small model and effort for hosted models, reusing the Vector Local role pickers.
10. **There is no Permissions screen in Settings.** Idea: a page to edit rules and clear saved "Always allow" answers.
11. **Vector Cloud only supports Vercel and Supabase.** Idea: let plugins add deploy targets such as Netlify, Cloudflare or Fly.
12. **Outsiders can't build on Vector yet.** The plugin package and the SDK aren't published. Idea: publish both to npm.
13. **The npm CLI (1.99.99) is behind the desktop's engine.** It lacks:
    - `vector local`, `vector memory` and `vector trust`
    - `--max-cost` and `--max-steps`
    - `--trusted-network` and `--public-url`
    - the guest limits

    Idea: ship the next CLI release.
14. **There is no beta update channel.** Idea: a beta toggle in Settings → Updates & about.