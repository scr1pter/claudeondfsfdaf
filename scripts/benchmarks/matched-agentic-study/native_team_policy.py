"""Pure Codex native-lineage gate prototype; has no network or credential code.

This is a free-proof seam, not a funded witness. Callers must bind a trusted
root, exact native-home reader, owned batch and durable audit before funding.
"""
import copy
import json

MODEL = "gpt-6.1-sol"
WORKERS = {"task", "task_manage", "research", "escalate", "spawn_agent", "start_agent", "create_agent", "delegate", "delegate_task", "subagent", "subagents", "agent", "agents", "followup_task", "interrupt_agent", "list_agents", "send_message", "send_input", "wait_agent", "close_agent", "resume_agent", "get_agent"}


class PolicyError(ValueError):
    pass


def require(value, message):
    if not value:
        raise PolicyError(message)


def worker_tool(name):
    parts = name.lower().split(".")
    return "collaboration" in parts or parts[-1] in WORKERS


def filter_tools(tools, child):
    require(isinstance(tools, list), "unknown tools container")
    result = []
    for tool in tools:
        require(isinstance(tool, dict) and tool.get("type") in ("function", "custom", "namespace") and isinstance(tool.get("name"), str), "unknown tool schema")
        if child and worker_tool(tool["name"]):
            continue
        if tool["type"] == "namespace":
            children = filter_tools(tool.get("tools"), child)
            if children:
                result.append({**tool, "tools": children})
        else:
            result.append(tool)
    return result


class NativeTeamPolicy:
    def __init__(self, root_id, roles, provider="free_probe"):
        require(isinstance(root_id, str) and root_id and len(set(roles)) == len(roles) and len(roles) <= 3, "invalid bound profile")
        self.root_id, self.roles, self.provider = root_id, set(roles), provider
        self.slots = {}

    def apply(self, body, headers, snapshot):
        require(body.get("model") == MODEL and isinstance(body.get("reasoning"), dict) and body["reasoning"].get("effort") == "high", "model or effort changed")
        require(body.get("service_tier", "default") in ("default", "standard") and body.get("pro") in (None, False), "unreviewed processing mode")
        require(all(str(body.get(key, "")).lower() != "pro" for key in ("mode", "model_mode", "modelMode")), "unreviewed mode")
        require(str(body["reasoning"].get("mode", "")).lower() != "pro" and body["reasoning"].get("pro") in (None, False), "unreviewed reasoning mode")
        normalized = {key.lower(): value for key, value in headers.items()}
        identity = normalized.get("thread-id")
        try:
            metadata = json.loads(normalized.get("x-codex-turn-metadata", "null"))
        except ValueError:
            raise PolicyError("invalid identity metadata") from None
        require(isinstance(metadata, dict) and identity and metadata.get("thread_id") == identity, "thread identity ambiguous")
        require(normalized.get("session-id") == self.root_id and metadata.get("session_id") == self.root_id, "arm root mismatch")
        require(metadata.get("model") == MODEL and metadata.get("reasoning_effort") == "high", "wire metadata model mismatch")
        databases = [value for value in snapshot.get("sqlite", []) if value.get("relativePath") == "state_5.sqlite" and not value.get("readError")]
        require(len(databases) == 1, "native registry unavailable")
        rows = [row for row in databases[0].get("threads", []) if row.get("id") == identity]
        require(len(rows) == 1, "identity not persisted before inference")
        row = rows[0]
        require(row.get("model") == MODEL and row.get("reasoning_effort") == "high" and row.get("model_provider") == self.provider, "native model/provider mismatch")
        role = "lead"
        if identity == self.root_id:
            require(row.get("source") == "exec" and row.get("thread_source") == "user" and row.get("agent_role") is None, "root native metadata mismatch")
            require(metadata.get("parent_thread_id") is None and metadata.get("agent_name") == "/root", "root ancestry mismatch")
        else:
            try:
                ancestry = json.loads(row.get("source", "null"))["subagent"]["thread_spawn"]
            except (ValueError, TypeError, KeyError):
                raise PolicyError("unknown native child ancestry") from None
            role = row.get("agent_role")
            require(role in self.roles and row.get("thread_source") == "subagent", "unapproved child role")
            require(ancestry.get("parent_thread_id") == self.root_id and ancestry.get("depth") == 1, "nested or cross-arm child")
            require(ancestry.get("agent_role") == role and ancestry.get("agent_path") == row.get("agent_path") == metadata.get("agent_name"), "role/path metadata mismatch")
            require(metadata.get("parent_thread_id") == self.root_id, "wire/native parent mismatch")
            edges = [edge for edge in databases[0].get("spawnEdges", []) if edge.get("parent_thread_id") == self.root_id and edge.get("child_thread_id") == identity]
            require(len(edges) == 1, "native parent edge not persisted")
            require(role not in self.slots or self.slots[role] == identity, "duplicate fixed child slot")
        result = copy.deepcopy(body)
        if "tools" in result:
            result["tools"] = filter_tools(result["tools"], role != "lead")
        require(isinstance(result.get("input"), list), "structured input required")
        for item in result["input"]:
            if isinstance(item, dict) and item.get("type") == "additional_tools":
                item["tools"] = filter_tools(item.get("tools"), role != "lead")
            if isinstance(item, dict) and item.get("type") == "configuration_update":
                require(set(item) <= {"type", "model", "reasoning", "text"} and item.get("model", MODEL) == MODEL and isinstance(item.get("reasoning"), dict) and item["reasoning"].get("effort") == "high", "configuration update changes profile")
        if role != "lead":
            self.slots[role] = identity
        return result, {"role": role, "nativeIdentityJoined": True, "autonomousSessionsAdmitted": 1 + len(self.slots), "workerDefinitionsRemovedForChild": role != "lead"}
