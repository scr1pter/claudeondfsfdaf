"""Synthetic native databases and owned loopback meter only; no coding CLI."""
import copy
from contextlib import closing
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from native_registry import NativeRegistry
from native_team_policy import MODEL, PolicyError
from owned_team_witness import OwnedSupervisor, WitnessServer
from role_graph import HEAVY_ROLE_PARENTS, HEAVY_ROLES, RoleGraph
from test_owned_witness import FakeMeter, ROOT, add_thread, body, headers, native_fixture


class HeavyRoleGraphTests(unittest.TestCase):
    def test_fixed_graph_has_six_lifetime_children_and_only_one_nested_coordinator(self):
        profile = RoleGraph(HEAVY_ROLES, HEAVY_ROLE_PARENTS)
        self.assertEqual(profile.max_depth, 2)
        self.assertEqual({role for role in ("lead", *HEAVY_ROLES) if profile.delegates(role)}, {"lead", "backend_coordinator"})
        self.assertEqual({role for role in HEAVY_ROLES if profile.depths[role] == 2}, {"backend_api", "backend_data"})

    def test_invalid_graphs_fail_before_any_owned_scope(self):
        for parents in ({"a": "b", "b": "a"}, {"a": "missing"}, {"a": "lead", "b": "a", "c": "b"}, {str(index): "lead" for index in range(7)}, {"lead": "lead"}):
            with self.subTest(parents=parents), self.assertRaises(PolicyError):
                RoleGraph(tuple(parents), parents)

    def test_original_four_identity_profile_is_unchanged_by_default(self):
        profile = RoleGraph(("implementation", "verification", "judge"))
        self.assertEqual(profile.max_depth, 1)
        self.assertEqual(profile.parents, {"implementation": "lead", "verification": "lead", "judge": "lead"})
        for role in profile.parents:
            self.assertFalse(profile.delegates(role))
        with self.assertRaises(PolicyError):
            RoleGraph(HEAVY_ROLES)

    def test_graph_copies_callers_parent_map(self):
        parents = copy.deepcopy(HEAVY_ROLE_PARENTS)
        profile = RoleGraph(HEAVY_ROLES, parents)
        parents["backend_api"] = "lead"
        self.assertEqual(profile.parents["backend_api"], "backend_coordinator")


class HeavyOwnedWitnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.meter = FakeMeter()
        self.meter_thread = threading.Thread(target=self.meter.serve_forever, daemon=True)
        self.meter_thread.start()
        self.witness = None

    def tearDown(self):
        if self.witness:
            self.arm.latch("synthetic_cleanup")
            self.witness.shutdown(); self.witness.server_close(); self.witness_thread.join(5)
        self.meter.shutdown(); self.meter.server_close(); self.meter_thread.join(5)
        self.temp.cleanup()

    def start(self, runtime):
        self.runtime = runtime
        home = self.root / "native"
        self.ids = {"lead": ROOT, **{role: "synthetic-" + role for role in HEAVY_ROLES}}
        self.parents = {self.ids[role]: self.ids[parent] for role, parent in HEAVY_ROLE_PARENTS.items()}
        if runtime == "codex":
            old = native_fixture(home)
            self.registry = NativeRegistry(runtime, home, old.database, ROOT, "fake-provider", helper_names=("summary",), max_depth=2)
        else:
            home.mkdir()
            database = home / "vector.db"
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.executescript("CREATE TABLE session(id TEXT,parent_id TEXT,internal TEXT,agent TEXT,model TEXT,metadata TEXT); CREATE TABLE message(id TEXT,session_id TEXT); CREATE TABLE part(id TEXT,session_id TEXT);")
                connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", (ROOT, None, None, "build", json.dumps({"id": MODEL, "providerID": "openai", "variant": "high"}), None))
            self.registry = NativeRegistry(runtime, home, database, ROOT, "openai", helper_producers={"synthetic-summary": "summary"}, max_depth=2)
        for role in HEAVY_ROLES:
            self.add(role)
        self.supervisor = OwnedSupervisor(self.meter.control, lambda: copy.deepcopy(self.meter.receipts), self.root / "private-output", quiesced=lambda: True)
        self.arm = self.supervisor.begin(runtime, "synthetic-heavy-graph", self.registry, HEAVY_ROLES, role_parents=HEAVY_ROLE_PARENTS)
        self.witness = WitnessServer(("127.0.0.1", 0), self.meter.server_address, self.arm)
        self.witness_thread = threading.Thread(target=self.witness.serve_forever, daemon=True)
        self.witness_thread.start()

    def add(self, role, identity=None, parent_role=None, depth=None):
        identity = identity or self.ids[role]
        parent = self.ids[parent_role or HEAVY_ROLE_PARENTS[role]]
        depth = depth or RoleGraph(HEAVY_ROLES, HEAVY_ROLE_PARENTS).depths[role]
        if self.runtime == "codex":
            add_thread(self.registry.database, identity, role, parent=parent, depth=depth)
        else:
            record = {"subagent": {"agent": role, "parentSessionID": parent, "model": {"modelID": MODEL, "providerID": "openai", "variant": "high"}}}
            with closing(sqlite3.connect(self.registry.database)) as connection, connection:
                connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", (identity, parent, None, role, None, json.dumps(record)))
        self.parents[identity] = parent
        return identity

    def request(self, role="lead", identity=None, purpose="turn", payload=None):
        identity = identity or self.ids[role]
        parent = self.parents.get(identity)
        native_headers = headers(identity, parent=parent, purpose=purpose) if self.runtime == "codex" else {"X-Session-Id": identity, **({"x-parent-session-id": parent} if parent else {})}
        connection = http.client.HTTPConnection(*self.witness.server_address, timeout=5)
        connection.request("POST", "/v1/responses", body=json.dumps(body() if payload is None else payload), headers={"Authorization": "Bearer " + self.arm._alias, **native_headers})
        response = connection.getresponse()
        status = response.status
        response.read(); connection.close()
        return status

    def test_codex_full_graph_and_same_identity_followups_reconcile_every_charge(self):
        self.full_graph("codex")

    def test_vector_full_graph_and_same_identity_followups_reconcile_every_charge(self):
        self.full_graph("vector")

    def full_graph(self, runtime):
        self.start(runtime)
        roles = ("lead", *HEAVY_ROLES, "backend_api", "team_judge")
        for role in roles:
            self.assertEqual(self.request(role), 200)
            forwarded = self.meter.bodies[-1]
            names = [value["name"] for value in forwarded["input"][0]["tools"]]
            self.assertEqual("collaboration" in names, role in ("lead", "backend_coordinator"))
            self.assertEqual(forwarded["model"], MODEL)
            self.assertEqual(forwarded["reasoning"], {"effort": "high", "summary": "auto"})
            self.assertEqual(forwarded["max_output_tokens"], 32000)
        result = self.supervisor.close(timeout=2)
        self.assertFalse(result["reviewRequired"])
        self.assertTrue(result["settlementComplete"])
        self.assertEqual(result["providerRequests"], 9)
        self.assertAlmostEqual(result["measuredUsd"], 0.09)
        self.assertEqual(result["transcripts"]["sessionCount"], 7)
        self.assertEqual(set(self.arm.slots), set(HEAVY_ROLES))

    def test_grandchild_before_admitted_coordinator_is_refused(self):
        self.start("codex")
        self.assertEqual(self.request("backend_api"), 400)
        self.assertEqual(self.meter.calls, 0)

    def test_summary_first_grandchild_cannot_bypass_unadmitted_parent(self):
        self.start("codex")
        self.assertEqual(self.request("backend_api", purpose="summary"), 400)
        self.assertEqual(self.meter.calls, 0)

    def test_leaf_cannot_claim_coordinators_child_slot(self):
        self.start("codex")
        self.assertEqual(self.request("backend_coordinator"), 200)
        identity = self.add("backend_api", identity="synthetic-wrong-parent", parent_role="frontend_worker", depth=2)
        self.assertEqual(self.request(identity=identity), 400)
        self.assertEqual(self.meter.calls, 1)

    def test_root_cannot_create_grandchild_role_directly(self):
        self.start("vector")
        identity = self.add("backend_api", identity="synthetic-direct-grandchild", parent_role="lead", depth=1)
        self.assertEqual(self.request(identity=identity), 400)
        self.assertEqual(self.meter.calls, 0)

    def test_replacement_grandchild_identity_is_refused(self):
        self.start("vector")
        self.assertEqual(self.request("backend_coordinator"), 200)
        self.assertEqual(self.request("backend_api"), 200)
        identity = self.add("backend_api", identity="synthetic-replacement-api")
        self.assertEqual(self.request(identity=identity), 400)
        self.assertEqual(self.meter.calls, 2)

    def test_third_autonomous_depth_is_refused(self):
        self.start("codex")
        self.assertEqual(self.request("backend_coordinator"), 200)
        self.assertEqual(self.request("backend_api"), 200)
        identity = self.add("backend_data", identity="synthetic-depth-three", parent_role="backend_api", depth=3)
        self.assertEqual(self.request(identity=identity), 400)
        self.assertEqual(self.meter.calls, 2)

    def test_native_ancestor_model_change_is_refused(self):
        self.start("codex")
        self.assertEqual(self.request("backend_coordinator"), 200)
        with closing(sqlite3.connect(self.registry.database)) as connection, connection:
            connection.execute("UPDATE threads SET reasoning_effort='low' WHERE id=?", (self.ids["backend_coordinator"],))
        self.assertEqual(self.request("backend_api"), 400)
        self.assertEqual(self.meter.calls, 1)

    def test_vector_native_ancestor_cycle_is_refused(self):
        self.start("vector")
        self.assertEqual(self.request("backend_coordinator"), 200)
        with closing(sqlite3.connect(self.registry.database)) as connection, connection:
            record = {"subagent": {"agent": "backend_coordinator", "parentSessionID": self.ids["backend_api"], "model": {"modelID": MODEL, "providerID": "openai", "variant": "high"}}}
            connection.execute("UPDATE session SET parent_id=?,metadata=? WHERE id=?", (self.ids["backend_api"], json.dumps(record), self.ids["backend_coordinator"]))
        self.assertEqual(self.request("backend_api"), 400)
        self.assertEqual(self.meter.calls, 1)

    def test_known_toolless_helper_under_grandchild_is_counted_without_an_extra_autonomous_slot(self):
        self.start("vector")
        self.assertEqual(self.request("backend_coordinator"), 200)
        self.assertEqual(self.request("backend_api"), 200)
        identity = "synthetic-api-summary"
        self.parents[identity] = self.ids["backend_api"]
        with closing(sqlite3.connect(self.registry.database)) as connection, connection:
            connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", (identity, self.ids["backend_api"], "synthetic-summary", "summary", json.dumps({"id": MODEL, "providerID": "openai", "variant": "high"}), None))
        self.assertEqual(self.request(identity=identity, payload={"model": MODEL, "reasoning": {"effort": "high"}, "input": []}), 200)
        self.assertEqual(len(self.arm.slots), 2)
        self.assertEqual(len(self.arm.helper_slots), 1)
        result = self.supervisor.close(timeout=2)
        self.assertFalse(result["reviewRequired"])
        self.assertEqual(result["providerRequests"], 3)
        self.assertAlmostEqual(result["measuredUsd"], 0.03)


if __name__ == "__main__":
    unittest.main()
