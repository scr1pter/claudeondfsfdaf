"""Bounded posthoc execution observations, not a browser or operating-system fence."""
import ast
import hashlib
import json
from pathlib import Path
import re
import shlex

MAX_LOG_BYTES = 33_554_432
MAX_LINES = 50_000
MAX_LINE_BYTES = 1_048_576
MAX_COMMANDS = 1_000
MAX_COMMAND_CHARS = 65_536
MAX_SCRIPTS = 32
MAX_SCRIPT_BYTES = 262_144
LIBRARIES = ("playwright", "puppeteer", "selenium", "webdriver")
SCOPED_LIBRARIES = {"@playwright", "@puppeteer", "@wdio"}
TERMINAL_TOOLS = {"terminal", "bash", "shell", "exec", "exec_command", "execute", "run_command", "run_terminal_command"}
TERMINAL_OBSERVATION_ACTIONS = {"list", "read", "wait", "resize", "close", "reveal"}
TERMINAL_CONTROL_KEYS = {"ctrl-c", "ctrl-g", "ctrl-l", "ctrl-z"}
READ_WRITE_COMMANDS = {"get-content", "gc", "cat", "type", "rg", "grep", "select-string", "echo", "write-output", "set-content", "out-file", "new-item", "apply_patch"}
JS_TOKENS = re.compile(r"//[^\n]*|/\*[\s\S]*?\*/|'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]", re.MULTILINE)


def _library(value):
    normalized = value.lower().replace("\\", "/")
    parts = normalized.split("/")
    return bool(SCOPED_LIBRARIES & set(parts)) or any(name in parts[-2:] or normalized.startswith(name + "-") for name in LIBRARIES)


def _browser_marker(value):
    return bool(re.search(r"(?i)(?:PLAYWRIGHT_MODULE|CHROME_PATH|VECTOR_BENCH_CHROME|BROWSER_DRIVER_CLIENT|BROWSER_DRIVER_ENDPOINT|BENCH_BROWSER_TOKEN|@wdio/|"
                          r"(?<![\w-])(?:playwright|puppeteer|selenium|webdriver)(?:-(?:core|extra|webdriver))?(?![\w-])|"
                          r"\b(?:chrome|chromium|msedge)(?:\.exe)?\b|connect_over_cdp|\bbrowser\s*\.\s*(?:launch|connect|newContext|newPage)\b)", value))


def _trusted_client_wrapper_only(value):
    remaining, matches = re.subn(r"(?i)(?<![\w-])(?:BROWSER_DRIVER_CLIENT|BROWSER_DRIVER_ENDPOINT|BENCH_BROWSER_TOKEN)(?![\w-])", "", value)
    return matches > 0 and not _browser_marker(remaining)


def _script_signal(source, python=False):
    """Read source lexically; quoted source examples alone are not execution."""
    if python:
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return "unknown" if any(name in source.lower() for name in LIBRARIES) else None
        if any(isinstance(node, ast.Import) and any(_library(alias.name.split(".")[0]) for alias in node.names)
               or isinstance(node, ast.ImportFrom) and _library((node.module or "").split(".")[0]) for node in ast.walk(tree)):
            return "library"
        if any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"eval", "exec"} for node in ast.walk(tree)):
            return "unknown" if any(name in source.lower() for name in LIBRARIES) else None
        return None
    tokens = [("string" if token[0] in "'\"`" else "code", token[1:-1] if token[0] in "'\"`" else token)
              for token in JS_TOKENS.findall(source) if not token.startswith(("//", "/*"))]
    values = [value for _, value in tokens]
    env_names = {"PLAYWRIGHT_MODULE", "VECTOR_BENCH_PLAYWRIGHT_MODULE"}
    module_variables = set()
    chrome_variables = set()
    for i in range(len(tokens) - 2):
        if tokens[i][0] == "code" and values[i + 1] == "=":
            expression = values[i + 2:i + 12]
            end = expression.index(";") if ";" in expression else len(expression)
            if any(name in expression[:end] for name in env_names):
                module_variables.add(values[i])
            if any(name in expression[:end] for name in ("CHROME_PATH", "VECTOR_BENCH_CHROME")):
                chrome_variables.add(values[i])
    for i, (kind, value) in enumerate(tokens):
        if kind != "code":
            continue
        if value == "from" and i + 1 < len(tokens) and tokens[i + 1][0] == "string" and _library(values[i + 1]):
            return "library"
        if value in {"require", "import"} and i + 2 < len(tokens) and values[i + 1] == "(":
            argument = values[i + 2:i + 12]
            if tokens[i + 2][0] == "string" and _library(values[i + 2]) or values[i + 2] in module_variables or any(name in argument for name in env_names):
                return "library"
        if value == "import" and i + 1 < len(tokens) and tokens[i + 1][0] == "string" and _library(values[i + 1]):
            return "library"
        if value == "createRequire" and i + 1 < len(tokens) and values[i + 1] == "(":
            balance = 0
            end = None
            for position in range(i + 1, min(len(tokens), i + 32)):
                balance += values[position] == "("
                balance -= values[position] == ")"
                if balance == 0:
                    end = position
                    break
            if end is not None and end + 2 < len(tokens) and values[end + 1] == "(":
                argument = values[end + 2:end + 14]
                if any(name in argument for name in env_names) or tokens[end + 2][0] == "string" and _library(values[end + 2]):
                    return "library"
        if value in {"spawn", "spawnSync", "execFile", "execFileSync"} and i + 2 < len(tokens) and values[i + 1] == "(":
            argument = values[i + 2:i + 12]
            if values[i + 2] in chrome_variables or any(name in argument for name in ("CHROME_PATH", "VECTOR_BENCH_CHROME")):
                return "process"
            if tokens[i + 2][0] == "string" and re.search(r"(?:^|[\\/])(?:chrome|chromium|msedge)(?:\.exe)?$", values[i + 2], re.I):
                return "process"
    if any(kind == "code" and value in {"eval", "Function"} for kind, value in tokens) and any(name in source.lower() for name in LIBRARIES):
        return "unknown"
    return None


def _unquote(value):
    return value[1:-1] if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"" else value


def _client_env_token(value):
    return value.upper() in {"$ENV:BROWSER_DRIVER_CLIENT", "$BROWSER_DRIVER_CLIENT", "${BROWSER_DRIVER_CLIENT}", "%BROWSER_DRIVER_CLIENT%"}


def _command_parts(command):
    lexer = shlex.shlex(command, posix=False, punctuation_chars=";&|")
    lexer.whitespace_split = True
    lexer.commenters = ""
    parts = [[]]
    for token in lexer:
        if token and set(token) <= set(";&|"):
            if parts[-1]:
                parts.append([])
        else:
            parts[-1].append(_unquote(token))
    return [part for part in parts if part]


def audit_tool_events(path, runtime, app, mode, trusted_client=None):
    """Return only enum/count/flag metadata; never commands, paths, IDs or secrets."""
    app = Path(app).resolve()
    trusted_client = Path(trusted_client).resolve() if trusted_client else None
    observations = set()
    commands = set()
    scripts = set()
    pending = set()
    counts = {"lines": 0, "toolExecutions": 0, "commandsInspected": 0, "scriptsInspected": 0,
              "directBrowserReferences": 0, "commonClientInvocations": 0, "unknownObservations": 0,
              "informationalUnknownObservations": 0, "reviewRequiredUnknownObservations": 0,
              "terminalObservationActions": 0, "terminalControlActions": 0, "terminalInteractiveInputs": 0}

    def note(name, unknown=False, review=True):
        observations.add(name)
        if unknown:
            counts["unknownObservations"] += 1
            counts["reviewRequiredUnknownObservations" if review else "informationalUnknownObservations"] += 1

    def signal(value):
        if value in {"library", "process"}:
            counts["directBrowserReferences"] += 1
            note("executed_browser_library_reference" if value == "library" else "executed_browser_process_reference")
        elif value == "unknown":
            note("browser_related_execution_unknown", True)

    def script(token, python=False):
        if _client_env_token(token):
            counts["commonClientInvocations"] += 1
            note("common_client_invocation")
            return
        candidate = Path(token)
        candidate = (app / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
        if trusted_client and candidate == trusted_client:
            counts["commonClientInvocations"] += 1
            note("common_client_invocation")
            return
        if not candidate.is_relative_to(app) or any(part in {"node_modules", ".git"} for part in candidate.relative_to(app).parts):
            note("executed_script_outside_authored_workspace", True)
            return
        if candidate in scripts:
            return
        if len(scripts) >= MAX_SCRIPTS:
            note("audit_limit_reached", True)
            return
        current = app
        for part in candidate.relative_to(app).parts:
            current /= part
            if current.is_symlink() or current.is_junction():
                note("executed_script_link_not_inspected", True)
                return
        scripts.add(candidate)
        try:
            with candidate.open("rb") as stream:
                data = stream.read(MAX_SCRIPT_BYTES + 1)
            if len(data) > MAX_SCRIPT_BYTES:
                note("audit_limit_reached", True)
                return
            source = data.decode("utf-8")
        except (OSError, UnicodeError):
            note("executed_script_unavailable", True)
            return
        counts["scriptsInspected"] += 1
        signal(_script_signal(source, python))

    def inspect(command, depth=0, argv=None):
        if len(command) > MAX_COMMAND_CHARS or depth > 2:
            note("audit_limit_reached", True)
            return
        try:
            parts = [argv] if argv is not None else _command_parts(command)
        except ValueError:
            browser_related = _browser_marker(command)
            trusted_client_only = _trusted_client_wrapper_only(command)
            note("shell_execution_unparseable", True, review=browser_related and not trusted_client_only)
            if trusted_client_only:
                note("informational_trusted_client_wrapper_parse_limit")
            elif browser_related:
                note("browser_related_shell_ambiguity")
            return
        aliases = {}
        for words in parts:
            first = words[0].lower()
            if first in READ_WRITE_COMMANDS:
                continue
            if len(words) >= 3 and words[1] == "=" and first.startswith("$"):
                aliases[first] = words[2]
                continue
            assignment = re.fullmatch(r"(\$[\w:]+)=(.+)", words[0])
            if assignment:
                aliases[assignment[1].lower()] = assignment[2]
                continue
            executable = aliases.get(first, words[0]).lower()
            name = executable.replace("\\", "/").rsplit("/", 1)[-1]
            if name in {"pwsh", "pwsh.exe", "powershell", "powershell.exe", "bash", "sh", "cmd", "cmd.exe"}:
                flags = [word.lower() for word in words]
                position = next((i for i, word in enumerate(flags) if word in {"-command", "-c", "/c"}), None)
                if position is not None and position + 1 < len(words):
                    inspect(" ".join(words[position + 1:]), depth + 1)
                elif any(value in command.lower() for value in (*LIBRARIES, "chrome_path", "browser")):
                    note("browser_related_execution_unknown", True)
                continue
            if re.fullmatch(r"(?:chrome|chromium|msedge)(?:\.exe)?", name) or "chrome_path" in executable or "vector_bench_chrome" in executable:
                signal("process")
                continue
            if name in {"npx", "npm", "bunx"} and any(_library(word) for word in words[1:]):
                signal("library")
                continue
            javascript = name in {"node", "node.exe", "bun", "bun.exe"} or "node_exe" in executable or "bun_exe" in executable
            python = name in {"python", "python.exe", "python3", "py", "py.exe"} or "python_exe" in executable
            if not javascript and not python:
                if first in {"invoke-expression", "iex", "start-process"} and any(value in command.lower() for value in (*LIBRARIES, "chrome", "browser")):
                    note("browser_related_execution_unknown", True)
                continue
            flags = [word.lower() for word in words]
            inline = next((i for i, word in enumerate(flags[1:], 1) if word in ({"-c"} if python else {"-e", "--eval", "-p", "--print"})), None)
            if inline is not None:
                signal(_script_signal(words[inline + 1], python) if inline + 1 < len(words) else "unknown")
                continue
            token = next((word for word in words[1:] if re.search(r"\.(?:[cm]?js|tsx?|py)$", word, re.I) or _client_env_token(word)), None)
            if token:
                script(token, python)
            elif "-" in words[1:] or any(value in " ".join(words[1:]).lower() for value in (*LIBRARIES, "browser", "chrome")):
                note("browser_related_execution_unknown", True)

    try:
        with Path(path).open("rb") as stream:
            data = stream.read(MAX_LOG_BYTES + 1)
    except OSError:
        data = b""
        note("tool_telemetry_unavailable", True)
    if len(data) > MAX_LOG_BYTES:
        note("audit_limit_reached", True)
        data = data[:MAX_LOG_BYTES]
    for line in data.splitlines():
        counts["lines"] += 1
        if counts["lines"] > MAX_LINES or len(line) > MAX_LINE_BYTES:
            note("audit_limit_reached", True)
            if counts["lines"] > MAX_LINES:
                break
            continue
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            note("tool_telemetry_unparseable", True)
            continue
        command = None
        command_argv = None
        if not isinstance(event, dict):
            note("tool_telemetry_unparseable", True)
            continue
        if runtime == "codex" and event.get("type") == "item.started" and isinstance(event.get("item"), dict) and event["item"].get("type") == "command_execution":
            item = event["item"]
            pending.add(str(item.get("id", item.get("command", "unknown"))))
            continue
        if runtime == "vector" and event.get("type") == "tool_use":
            part = event.get("part")
            if not isinstance(part, dict) or not isinstance(part.get("tool"), str):
                note("tool_telemetry_unparseable", True)
                continue
            if part["tool"].split(".")[-1] not in TERMINAL_TOOLS:
                continue
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            value = part.get("input", state.get("input"))
            identity = str(part.get("id", part.get("callID", "unknown")))
            if state.get("status") in {"pending", "running"}:
                pending.add(identity)
            else:
                pending.discard(identity)
            if state.get("status") in {"pending", "running"} and not value:
                continue
            if part["tool"].split(".")[-1] == "terminal" and isinstance(value, dict):
                action = value.get("action")
                if action in TERMINAL_OBSERVATION_ACTIONS:
                    counts["terminalObservationActions"] += 1
                    continue
                if action == "keys":
                    keys = value.get("keys")
                    if isinstance(keys, list) and keys and all(isinstance(key, str) and key in TERMINAL_CONTROL_KEYS for key in keys):
                        counts["terminalControlActions"] += 1
                    else:
                        counts["terminalInteractiveInputs"] += 1
                        note("terminal_interactive_input_unknown", True)
                    continue
                if action == "type":
                    counts["terminalInteractiveInputs"] += 1
                    note("terminal_interactive_input_unknown", True)
                    if isinstance(value.get("text"), str) and value["text"].strip():
                        inspect(value["text"])
                    continue
                if action not in {None, "open"}:
                    note("terminal_action_unrecognized", True)
                    continue
                if action == "open" and "args" in value:
                    args = value["args"]
                    if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
                        note("terminal_open_arguments_unknown", True)
                        continue
                    command_argv = [value.get("command", value.get("cmd")), *args]
            command = value.get("command", value.get("cmd")) if isinstance(value, dict) else None
        elif runtime == "codex" and event.get("type") == "item.completed":
            item = event.get("item")
            if not isinstance(item, dict):
                note("tool_telemetry_unparseable", True)
                continue
            if item.get("type") != "command_execution":
                continue
            pending.discard(str(item.get("id", item.get("command", "unknown"))))
            command = item.get("command")
        else:
            continue
        if not isinstance(command, str) or not command.strip():
            note("tool_execution_command_unavailable", True)
            continue
        counts["toolExecutions"] += 1
        if command_argv is not None and sum(len(arg) for arg in command_argv) > MAX_COMMAND_CHARS:
            note("audit_limit_reached", True)
            continue
        identity = hashlib.sha256(json.dumps(command_argv).encode() if command_argv is not None else command.encode()).digest()
        if identity in commands:
            continue
        if len(commands) >= MAX_COMMANDS:
            note("audit_limit_reached", True)
            break
        commands.add(identity)
        counts["commandsInspected"] += 1
        inspect(command, argv=command_argv)
    if not counts["toolExecutions"] and not counts["terminalObservationActions"] and not counts["terminalControlActions"] and not counts["terminalInteractiveInputs"]:
        note("completed_execution_telemetry_absent", True)
    if pending:
        note("unfinished_execution_telemetry", True)
    if runtime not in {"vector", "codex"} or mode not in {"shared-client", "legacy-library-env"}:
        note("audit_profile_unrecognized", True)
    mode = mode if mode in {"shared-client", "legacy-library-env"} else "unknown"
    review = mode != "legacy-library-env" and (counts["directBrowserReferences"] > 0 or counts["reviewRequiredUnknownObservations"] > 0)
    return {"kind": "bounded-posthoc-browser-observations-v1", "mode": mode,
            "status": "review_required" if review else "legacy_observation_only" if mode == "legacy-library-env" else "no_clear_bypass_observed",
            "requiresManualReview": bool(review), "counts": counts, "observations": sorted(observations),
            "coverage": {"observedToolExecutions": counts["toolExecutions"], "uniqueCommandsInspected": counts["commandsInspected"],
                         "unknownObservations": counts["unknownObservations"],
                         "informationalOnlyUnknownObservations": counts["informationalUnknownObservations"],
                         "unresolvedBrowserOrTelemetryObservations": counts["reviewRequiredUnknownObservations"], "adherenceProven": False},
            "limits": {"logBytes": MAX_LOG_BYTES, "lines": MAX_LINES, "lineBytes": MAX_LINE_BYTES, "commands": MAX_COMMANDS,
                       "commandChars": MAX_COMMAND_CHARS, "scripts": MAX_SCRIPTS, "scriptBytes": MAX_SCRIPT_BYTES},
            "hardFenceOrSandboxClaim": False, "transitiveImportsInspected": False, "rawExecutionDetailsPublished": False,
            "scriptBytesArePosthocSnapshots": True, "executionSuccessInferred": False}
