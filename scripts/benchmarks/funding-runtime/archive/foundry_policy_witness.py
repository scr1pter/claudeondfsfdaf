"""Keyless Foundry single-agent/High witness. Never reads funding credentials.

Default route: 23130 -> funded meter23128. Historical witness23129 is unchanged.
Only explicit tool-definition containers are filtered; messages and JSONSchemas
are never traversed or rewritten. Historical funding/receipts stay untouched.
"""
import argparse
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import socket
import threading

MODEL = "gpt-6.1-sol"
MAX_BODY = 8_000_000
BLOCKED = {"research", "escalate", "task", "task_manage", "spawn_agent", "start_agent", "create_agent", "delegate", "delegate_task",
           "subagent", "subagents", "agent", "agents", "followup_task", "interrupt_agent", "list_agents",
           "send_message", "send_input", "wait_agent", "close_agent", "resume_agent", "get_agent"}
HOP = {"host", "content-length", "connection", "transfer-encoding", "proxy-connection", "keep-alive", "upgrade"}


class PolicyError(ValueError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def blocked(name):
    parts = name.lower().split(".")
    return "collaboration" in parts or parts[-1] in BLOCKED


def tool_list(tools, prefix=""):
    if not isinstance(tools, list):
        raise PolicyError("unknown tool container schema")
    output, before, after = [], [], []
    for tool in tools:
        if not isinstance(tool, dict) or tool.get("type") not in ("namespace", "function", "custom"):
            raise PolicyError("unknown tool definition schema")
        name = tool.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}", name):
            raise PolicyError("unknown tool name schema")
        full = prefix + name
        if tool["type"] == "namespace":
            children, child_before, child_after = tool_list(tool.get("tools"), full + ".")
            before.extend(child_before)
            if blocked(name):
                continue
            if children:
                output.append({**tool, "tools": children})
                after.extend(child_after)
        else:
            before.append(full)
            if not blocked(name) and not blocked(full):
                output.append(tool)
                after.append(full)
    return output, before, after



def wire_tool_kinds(tools, prefix=""):
    """Audit only declaration names and bounded type enums; no schema/text/key data."""
    found = []
    for tool in tools:
        full = prefix + tool["name"]
        if tool["type"] == "namespace":
            found.extend(wire_tool_kinds(tool["tools"], full + "."))
        else:
            entry = {"name": full, "type": tool["type"]}
            if tool["type"] == "custom":
                value = tool.get("format")
                entry["formatType"] = value.get("type") if isinstance(value, dict) and value.get("type") in ("text", "grammar") else "unknown"
            found.append(entry)
    return found


def reject_pro(value):
    for field in ("mode", "model_mode", "modelMode", "service_tier"):
        mode = value.get(field)
        if isinstance(mode, str) and mode.lower() == "pro":
            raise PolicyError("Pro mode is not permitted")
    if value.get("pro") not in (None, False):
        raise PolicyError("Pro mode is not permitted")
    reasoning = value.get("reasoning")
    if isinstance(reasoning, dict) and (reasoning.get("pro") not in (None, False) or str(reasoning.get("mode", "")).lower() == "pro"):
        raise PolicyError("Pro mode is not permitted")


def apply_policy(body):
    if not isinstance(body, dict) or body.get("model") != MODEL:
        raise PolicyError("Foundry requires the exact reviewed model")
    if not isinstance(body.get("reasoning"), dict) or body["reasoning"].get("effort") != "high":
        raise PolicyError("Foundry requires explicit High effort")
    reject_pro(body)
    result, before, after = dict(body), [], []
    if "tools" in body:
        result["tools"], names, retained = tool_list(body["tools"])
        before.extend(names); after.extend(retained)
    if "input" in body:
        if not isinstance(body["input"], list):
            raise PolicyError("Foundry requires structured Responses input")
        items = []
        for item in body["input"]:
            if isinstance(item, dict) and item.get("type") == "additional_tools":
                tools, names, retained = tool_list(item.get("tools"))
                before.extend(names); after.extend(retained)
                items.append({**item, "tools": tools})
            elif isinstance(item, dict) and item.get("type") == "configuration_update":
                if set(item) - {"type", "model", "reasoning", "text"} or not isinstance(item.get("reasoning"), dict) or item["reasoning"].get("effort") != "high" or item.get("model", MODEL) != MODEL:
                    raise PolicyError("configuration update may not change reviewed effort/model")
                reject_pro(item)
                items.append(item)
            else:
                items.append(item)
        result["input"] = items
    audit = {"policyVersion": "single-agent-no-workers-v2", "model": MODEL, "effort": "high", "reasoningSummary": body["reasoning"].get("summary"),
             "reasoningMode": body["reasoning"].get("mode", "standard"),
             "verbosity": body.get("text", {}).get("verbosity") if isinstance(body.get("text"), dict) else None,
             "requestSha256Before": digest(body), "requestSha256After": digest(result),
             "toolDefinitionSha256Before": digest([body.get("tools"), [x.get("tools") for x in body.get("input", []) if isinstance(x, dict) and x.get("type") == "additional_tools"]]),
             "toolDefinitionSha256After": digest([result.get("tools"), [x.get("tools") for x in result.get("input", []) if isinstance(x, dict) and x.get("type") == "additional_tools"]]),
             "toolNamesBefore": before, "toolNamesAfter": after, "removedCount": len(before) - len(after),
             "store": result.get("store") if isinstance(result.get("store"), bool) else None,
             "toolWireKindsAfter": wire_tool_kinds(result.get("tools", [])) +
                 [entry for item in result.get("input", []) if isinstance(item, dict) and item.get("type") == "additional_tools"
                  for entry in wire_tool_kinds(item["tools"])]}
    return result, audit


class Server(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = False
    block_on_close = True

    def __init__(self, address, upstream_port, audit_path):
        self.upstream_port, self.audit_path = upstream_port, Path(audit_path)
        self.audit_lock = threading.Lock()
        self.audit_failed = False
        if self.audit_path.exists():
            data = self.audit_path.read_bytes()
            if data and not data.endswith(b"\n"):
                raise ValueError("incomplete policy audit; startup refused")
            for line in data.splitlines():
                if not isinstance(json.loads(line), dict):
                    raise ValueError("invalid policy audit; startup refused")
        super().__init__(address, Handler)

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def get_request(self):
        request, address = super().get_request(); request.settimeout(30)
        return request, address

    def record(self, audit):
        with self.audit_lock:
            if self.audit_failed:
                raise OSError("policy audit failure is latched")
            try:
                with self.audit_path.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(audit, ensure_ascii=False) + "\n")
                    stream.flush(); os.fsync(stream.fileno())
            except OSError:
                self.audit_failed = True
                raise


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def error(self, code, message):
        wire = json.dumps({"error": {"type": "foundry_policy", "message": message}}).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(wire))); self.end_headers(); self.wfile.write(wire)

    def forward(self):
        if not ((self.command == "GET" and self.path == "/status") or (self.command == "POST" and self.path in ("/control", "/disarm", "/v1/responses"))):
            return self.error(404, "Unknown Foundry witness route")
        try:
            if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Encoding", "identity") != "identity":
                raise PolicyError("unsupported request transfer encoding")
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_BODY:
                raise PolicyError("request exceeds reviewed transport bound")
            data = self.rfile.read(length)
            if len(data) != length:
                raise PolicyError("incomplete request body")
            if self.path == "/v1/responses":
                filtered, audit = apply_policy(json.loads(data))
                data = json.dumps(filtered, ensure_ascii=False, separators=(",", ":")).encode()
                self.server.record(audit)
        except (PolicyError, ValueError, TypeError, KeyError):
            return self.error(400, "Foundry policy rejected model, effort or tool schema before upstream")
        except OSError:
            return self.error(503, "Foundry policy audit unavailable; nothing forwarded")
        connection = http.client.HTTPConnection("127.0.0.1", self.server.upstream_port, timeout=650)
        sent, alive = False, True
        try:
            connection.request(self.command, self.path, body=data if self.command == "POST" else None,
                               headers={key: value for key, value in self.headers.items() if key.lower() not in HOP})
            response = connection.getresponse()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP:
                    self.send_header(key, value)
            self.send_header("Connection", "close"); self.end_headers(); sent = True
            while chunk := response.read1(65536):
                if alive:
                    try:
                        self.wfile.write(chunk); self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        alive = False  # Drain upstream; never retry a funded request.
        except (OSError, http.client.HTTPException):
            if not sent:
                self.error(502, "Foundry upstream unavailable; request was not retried")
        finally:
            connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=23130)
    parser.add_argument("--upstream-port", type=int, default=23128)
    parser.add_argument("--audit", type=Path, default=Path(__file__).with_name("foundry-policy-metadata.jsonl"))
    args = parser.parse_args()
    with Server(("127.0.0.1", args.port), args.upstream_port, args.audit) as server:
        print("Keyless Foundry policy witness ready; no funding key or batch is loaded.", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
