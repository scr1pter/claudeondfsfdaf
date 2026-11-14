"""CI-only pure-function checks for the immutable native source asset.

Run from packages/core in the approved native CI job:
    /usr/bin/python3 -I -S -B test/fixture/native-mask-origins.py

The asset is parsed as data. Only the explicit pure-function allowlist and its
two path constants are compiled; module initialization, ctypes and live native
operations are never imported or executed by this fixture.
"""

import ast
import copy
import hashlib
import json
import os
import pathlib
import re
import stat
import unittest


ENTRY = pathlib.Path(__file__).resolve().parents[2] / "src/process-isolation/linux/entry.py"
TREE = ast.parse(ENTRY.read_text(encoding="utf-8"), filename=str(ENTRY))
FUNCTIONS = {node.name: node for node in TREE.body if isinstance(node, ast.FunctionDef)}
PURE = {
    "require", "integer", "exact", "canonical", "object_identity", "construction_namespace",
    "filesystem", "json_digest", "digest_value", "mask_records", "mount_field", "mount_path", "parse_mount_table",
    "beneath", "hidden", "refuse_mask_aliases", "require_private_mounts", "require_known_mask_origins",
    "require_capture_closure", "keeper_log_stage", "keeper_environment", "keeper_log_classification",
    "keeper_info_progress", "keeper_failure_stage",
}
CONSTANTS = {"HOST_TEMP", "MASKS"}
SELECTED = [node for node in TREE.body if
            isinstance(node, ast.FunctionDef) and node.name in PURE or
            isinstance(node, ast.Assign) and len(node.targets) == 1 and
            isinstance(node.targets[0], ast.Name) and node.targets[0].id in CONSTANTS]
if ({node.name for node in SELECTED if isinstance(node, ast.FunctionDef)} != PURE or
        len(SELECTED) != len(PURE) + len(CONSTANTS)):
    raise AssertionError("The production pure-function allowlist changed")
SAFE_CALLS = PURE | {"RuntimeError", "type", "len", "all", "any", "ord", "chr", "int", "str", "set", "sorted", "list", "dict"}
SAFE_MODULE_CALLS = {"os.major", "os.minor", "os.path.normpath", "os.path.relpath", "os.path.join",
                     "hashlib.sha256", "json.dumps", "json.loads", "re.sub", "re.fullmatch", "stat.S_ISDIR", "stat.S_ISREG"}
SAFE_METHODS = {"encode", "startswith", "endswith", "rstrip", "values", "count", "isascii", "isdigit", "split", "items", "decode",
                "splitlines", "index", "append", "add", "hexdigest", "get"}
for node in SELECTED:
    if isinstance(node, ast.FunctionDef):
        if (node.decorator_list or node.returns or any(argument.annotation for argument in node.args.args) or
                any(not isinstance(value, ast.Constant) for value in node.args.defaults) or
                any(value is not None for value in node.args.kw_defaults)):
            raise AssertionError("Pure-function definition has executable initialization")
        for call in (value for value in ast.walk(node) if isinstance(value, ast.Call)):
            if isinstance(call.func, ast.Name) and call.func.id not in SAFE_CALLS:
                raise AssertionError("Unexpected call in production pure function")
            if isinstance(call.func, ast.Attribute):
                dotted = ast.unparse(call.func)
                receiver = call.func.value
                while isinstance(receiver, ast.Attribute):
                    receiver = receiver.value
                if isinstance(receiver, ast.Name) and receiver.id in {"os", "hashlib", "json", "re", "stat"}:
                    if dotted not in SAFE_MODULE_CALLS:
                        raise AssertionError("Native operation reached a production pure function")
                elif call.func.attr not in SAFE_METHODS:
                    raise AssertionError("Unexpected method in production pure function")
            elif not isinstance(call.func, ast.Name):
                raise AssertionError("Unexpected dynamic call in production pure function")
    elif any(not isinstance(value, (ast.Assign, ast.Constant, ast.Tuple, ast.Name, ast.Load, ast.Store))
             for value in ast.walk(node)):
        raise AssertionError("Unexpected constant initialization")
NATIVE = {"__name__": "native_mask_pure_fixture", "os": os, "re": re, "stat": stat,
          "json": json, "hashlib": hashlib}
exec(compile(ast.Module(body=SELECTED, type_ignores=[]), str(ENTRY), "exec", dont_inherit=True), NATIVE)
MASKS = NATIVE["MASKS"]


def line(number=1, parent=99, filesystem="8:1", root="/", target="/", options="rw,relatime",
         propagation=(), kind="ext4", source="/dev/root", super_options="rw"):
    return " ".join((str(number), str(parent), filesystem, root, target, options, *propagation,
                     "-", kind, source, super_options))


def mounts(*rows):
    return NATIVE["parse_mount_table"](("\n".join(rows) + "\n").encode("utf-8"))


def source(path, number=2, filesystem="0:99", root="/", inode=700, kind="tmpfs"):
    major, minor = (int(part) for part in filesystem.split(":"))
    return {"path": path, "device": os.makedev(major, minor), "inode": inode, "mountID": number,
            "filesystem": filesystem, "root": root, "kind": kind, "mode": stat.S_IFDIR | 0o755,
            "uid": 0, "gid": 0}


def seal(value):
    value.pop("digest", None)
    value["digest"] = NATIVE["json_digest"](value)
    return value


def records():
    return seal({
        "v": 2,
        "namespace": {"mount": {"device": 4, "inode": 12}, "parentMount": {"device": 4, "inode": 10},
                      "user": {"device": 4, "inode": 20}, "root": {"device": os.makedev(8, 1), "inode": 2}},
        "topology": NATIVE["json_digest"](mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"))),
        "roots": [source(path, 1, "8:1", path, 100 + index, "ext4") for index, path in enumerate(MASKS)],
        "origins": [source("/run/private")],
    })


def calls(function, name):
    return [node for node in ast.walk(FUNCTIONS[function]) if isinstance(node, ast.Call) and
            ast.unparse(node.func) == name]


class MountTableTests(unittest.TestCase):
    def refused(self, *rows):
        with self.assertRaises((RuntimeError, ValueError, UnicodeError)):
            mounts(*rows)

    def test_sorted_full_topology_and_private_unbindable_rows(self):
        parsed = mounts(line(3, 2, "0:100", target="/run/private/child", kind="tmpfs", propagation=("unbindable",)),
                        line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"))
        self.assertEqual([row["id"] for row in parsed], [1, 2, 3])
        self.assertEqual(parsed[2]["parent"], 2)
        self.assertEqual(parsed[2]["propagation"], ["unbindable"])
        self.assertEqual(parsed[0]["options"], ["rw", "relatime"])
        self.assertEqual(parsed[0]["source"], "/dev/root")
        self.assertEqual(parsed[0]["superOptions"], ["rw"])
        NATIVE["require_private_mounts"](parsed)

    def test_ids_parent_graph_and_scope_are_strict(self):
        for number in ("0", "01", "-1", "1.0", "9007199254740992"):
            with self.subTest(number=number):
                self.refused(line(number=number))
        for parent in ("0", "099", "-1", "9007199254740992"):
            with self.subTest(parent=parent):
                self.refused(line(parent=parent))
        self.refused(line(), line(1, 1, target="/run"))
        self.refused(line(), line(2, 88, target="/run"))
        self.refused(line(target="/run"))
        self.refused(line(1, 1))
        self.refused(line(), line(2, 3, target="/run"), line(3, 2, target="/run"))
        self.refused(line(), line(2, 1, target="/run"), line(3, 2, target="/tmp"))

    def test_filesystems_propagation_and_options_are_strict(self):
        for filesystem in ("8", "8:1:2", "08:1", "8:01", "-1:2", "8:x"):
            with self.subTest(filesystem=filesystem):
                self.refused(line(filesystem=filesystem))
        for propagation in (("shared:1", "shared:2"), ("master:1", "master:1"), ("shared:0",),
                            ("shared:01",), ("shared:9007199254740992",), ("unknown:1",), ("shared",)):
            with self.subTest(propagation=propagation):
                self.refused(line(propagation=propagation))
        for options in ("rw,ro", "relatime", "rw,rw", "rw,", ",ro"):
            with self.subTest(options=options):
                self.refused(line(options=options))
        for options in ("rw,rw", "rw,ro", "rw,"):
            with self.subTest(super_options=options):
                self.refused(line(super_options=options))
        self.refused(line(kind="invalid/kind"))
        self.refused(line() + " unexpected")
        self.refused(line().replace(" - ", " "))

    def test_kernel_escapes_decode_once_and_paths_remain_canonical(self):
        parsed = mounts(line(), line(2, 1, target=r"/run/a\040b", root=r"/data\134040name", source=r"/dev/a\040b"))
        self.assertEqual(parsed[1]["target"], "/run/a b")
        self.assertEqual(parsed[1]["root"], r"/data\040name")
        self.assertEqual(parsed[1]["source"], "/dev/a b")
        for target in (r"/run/a\011b", r"/run/a\012b", r"/run/a\041b", r"/run/a\04", r"/run/a\x",
                       "/run/../tmp", "/run/", "relative", "/run/\x7f"):
            with self.subTest(target=target):
                self.refused(line(), line(2, 1, target=target))
        for field in (r"/dev/a\041b", r"/dev/a\04", r"/dev/a\x", r"/dev/a\011b"):
            with self.subTest(source=field):
                self.refused(line(source=field))

    def test_input_size_utf8_and_row_count_are_bounded(self):
        for value in (b"", b"\xff", b"x" * 2097153):
            with self.assertRaises((RuntimeError, ValueError, UnicodeError)):
                NATIVE["parse_mount_table"](value)
        self.refused(*[line()] * 4097)

    def test_propagating_rows_parse_but_private_contract_refuses_them(self):
        for propagation in (("shared:7",), ("master:7",), ("propagate_from:7",), ("shared:7", "master:8")):
            parsed = mounts(line(propagation=propagation))
            self.assertEqual(parsed[0]["propagation"], list(propagation))
            with self.assertRaises(RuntimeError):
                NATIVE["require_private_mounts"](parsed)


class SourceRecordTests(unittest.TestCase):
    def test_valid_v2_record_and_digest_bind_each_capture_component(self):
        original = records()
        self.assertIs(NATIVE["mask_records"](original), original)
        for component in ("namespace", "topology", "roots", "origins"):
            changed = copy.deepcopy(original)
            if component == "namespace":
                changed[component]["mount"]["inode"] += 1
            elif component == "topology":
                changed[component] = "c" * 64
            else:
                changed[component][0]["inode"] += 1
            # Identical changed snapshots still cannot replace the digest-bound capture.
            self.assertEqual(changed, copy.deepcopy(changed))
            with self.subTest(component=component), self.assertRaises(RuntimeError):
                NATIVE["mask_records"](changed)
            NATIVE["mask_records"](seal(changed))

    def test_exact_schema_original_roots_and_identity_validation(self):
        invalid = []
        for field, value in (("v", 1), ("v", True), ("topology", "A" * 64), ("extra", True)):
            changed = records()
            changed[field] = value
            invalid.append(seal(changed))
        changed = records()
        changed["namespace"]["mount"] = copy.deepcopy(changed["namespace"]["parentMount"])
        invalid.append(seal(changed))
        for field in ("mount", "parentMount", "user", "root"):
            for part, value in (("device", 0), ("inode", True), ("inode", 9007199254740992)):
                changed = records()
                changed["namespace"][field][part] = value
                invalid.append(seal(changed))
        changed = records()
        changed["roots"].reverse()
        invalid.append(seal(changed))
        changed = records()
        changed["roots"].pop()
        invalid.append(seal(changed))
        for field, value in (("device", 0), ("inode", True), ("mountID", 9007199254740992), ("mode", stat.S_IFLNK | 0o777),
                             ("uid", -1), ("gid", True), ("filesystem", "8:01"), ("kind", "bad/kind"),
                             ("path", "/outside"), ("root", "/run/../tmp"), ("extra", True)):
            changed = records()
            changed["origins"][0][field] = value
            invalid.append(seal(changed))
        changed = records()
        changed["roots"][0]["mode"] = stat.S_IFREG | 0o644
        invalid.append(seal(changed))
        changed = records()
        changed["origins"][0]["filesystem"] = "0:100"
        invalid.append(seal(changed))
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                NATIVE["mask_records"](value)
        for digest in ("b" * 63, "B" * 64, 7):
            changed = records()
            changed["digest"] = digest
            with self.assertRaises(RuntimeError):
                NATIVE["mask_records"](changed)

    def test_origins_are_sorted_distinct_and_never_repeat_an_original_root(self):
        for origins in ([source("/run/z", 2), source("/run/a", 3)],
                        [source("/run/a", 2), source("/run/z", 2)], [source("/run", 2)]):
            changed = records()
            changed["origins"] = origins
            with self.assertRaises(RuntimeError):
                NATIVE["mask_records"](seal(changed))

    def test_total_record_count_and_exact_serialized_byte_boundary(self):
        value = records()
        value["origins"] = [source(f"/run/p{index:03}", index + 2, inode=700 + index) for index in range(59)]
        NATIVE["mask_records"](seal(value))
        value["origins"].append(source("/run/z", 100))
        with self.assertRaises(RuntimeError):
            NATIVE["mask_records"](seal(value))
        value = records()
        value["origins"] = [source(f"/run/p{index:03}", index + 2, inode=700 + index) for index in range(8)]
        seal(value)
        remaining = 32768 - len(json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii"))
        self.assertGreater(remaining, 0)
        for origin in value["origins"]:
            count = min(remaining, 4096 - len(origin["path"]))
            origin["path"] += "x" * count
            remaining -= count
        self.assertEqual(remaining, 0)
        seal(value)
        self.assertEqual(len(json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii")), 32768)
        NATIVE["mask_records"](value)
        next(origin for origin in value["origins"] if len(origin["path"]) < 4096)["path"] += "x"
        with self.assertRaises(RuntimeError):
            NATIVE["mask_records"](seal(value))


class OriginClosureTests(unittest.TestCase):
    def test_capture_closure_binds_topology_and_every_nested_mount_id(self):
        value = records()
        baseline = mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"))
        NATIVE["require_capture_closure"](value, baseline)
        different = mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"),
                           line(3, 1, "0:100", target="/mnt/unrelated", kind="tmpfs"))
        with self.assertRaises(RuntimeError):
            NATIVE["require_capture_closure"](value, different)
        value["topology"] = NATIVE["json_digest"](different)
        NATIVE["require_capture_closure"](seal(value), different)
        for origins in ([], [source("/run/private", 3)],
                        [source("/run/private", 2), source("/run/uncaptured", 4)]):
            changed = records()
            changed["origins"] = origins
            with self.subTest(origins=origins), self.assertRaises(RuntimeError):
                NATIVE["require_capture_closure"](seal(changed), baseline)
        unknown = mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"),
                         line(3, 1, "0:101", target="/run/unknown", kind="tmpfs"))
        value = records()
        value["topology"] = NATIVE["json_digest"](unknown)
        with self.assertRaises(RuntimeError):
            NATIVE["require_capture_closure"](seal(value), unknown)

    def test_capture_closure_refuses_covered_exact_root_mounts_without_pins(self):
        value = records()
        complete = mounts(line(), line(2, 3, "0:99", target="/run/private", kind="tmpfs"),
                          line(3, 1, "8:1", "/run", "/run"))
        value["roots"][MASKS.index("/run")]["mountID"] = 3
        value["topology"] = NATIVE["json_digest"](complete)
        NATIVE["require_capture_closure"](seal(value), complete)
        covered = mounts(line(), line(2, 4, "0:99", target="/run/private", kind="tmpfs"),
                         line(3, 1, "8:1", "/run", "/run"), line(4, 1, "8:1", "/run", "/run"))
        value["roots"][MASKS.index("/run")]["mountID"] = 4
        value["topology"] = NATIVE["json_digest"](covered)
        with self.assertRaises(RuntimeError):
            NATIVE["require_capture_closure"](seal(value), covered)

    def test_original_and_nested_origins_have_no_outside_alias_in_either_direction(self):
        value = records()
        baseline = mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"))
        NATIVE["refuse_mask_aliases"](value, baseline)
        for root in MASKS:
            candidate = mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"),
                               line(3, 1, "8:1", root, "/mnt/copy"))
            with self.subTest(original=root), self.assertRaises(RuntimeError):
                NATIVE["refuse_mask_aliases"](value, candidate)
        for filesystem, root, target in (("8:1", "/", "/mnt/copy"),
                                          ("8:1", "/tmp/child", "/mnt/copy"),
                                          ("0:99", "/", "/mnt/copy"),
                                          ("0:99", "/child", "/mnt/copy")):
            candidate = mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"),
                               line(3, 1, filesystem, root, target, kind="tmpfs"))
            with self.subTest(filesystem=filesystem, root=root), self.assertRaises(RuntimeError):
                NATIVE["refuse_mask_aliases"](value, candidate)
        nested = records()
        nested["origins"][0]["root"] = "/secret"
        seal(nested)
        for root in ("/", "/secret", "/secret/child"):
            candidate = mounts(line(), line(2, 1, "0:99", "/secret", "/run/private", kind="tmpfs"),
                               line(3, 1, "0:99", root, "/mnt/copy", kind="tmpfs"))
            with self.subTest(root=root), self.assertRaises(RuntimeError):
                NATIVE["refuse_mask_aliases"](nested, candidate)

    def test_hidden_aliases_and_unrelated_filesystems_are_supported(self):
        value = records()
        candidate = mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"),
                           line(3, 1, "0:99", "/child", "/tmp/nested-copy", kind="tmpfs"),
                           line(4, 1, "0:100", "/", "/mnt/unrelated", kind="tmpfs"))
        NATIVE["refuse_mask_aliases"](value, candidate)

    def test_covered_old_rows_still_undergo_alias_and_known_origin_checks(self):
        value = records()
        covered = mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"),
                         line(3, 1, "0:100", target="/run", options="ro", kind="tmpfs", super_options="ro"))
        NATIVE["refuse_mask_aliases"](value, covered)
        NATIVE["require_known_mask_origins"](value, covered, {3})
        leaking = mounts(line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"),
                         line(3, 1, "0:100", target="/run", options="ro", kind="tmpfs", super_options="ro"),
                         line(4, 1, "0:99", target="/mnt/leak", kind="tmpfs"))
        with self.assertRaises(RuntimeError):
            NATIVE["refuse_mask_aliases"](value, leaking)
        unknown = mounts(line(), line(2, 1, "0:101", target="/run/private", kind="tmpfs"),
                         line(3, 1, "0:100", target="/run", options="ro", kind="tmpfs", super_options="ro"))
        with self.assertRaises(RuntimeError):
            NATIVE["require_known_mask_origins"](value, unknown, {3})

    def test_unknown_hidden_origin_cannot_hide_beneath_known_or_replacement_row(self):
        value = records()
        for target, root, kind in (("/run/private/unknown", "/", "tmpfs"),
                                   ("/run/private", "/other", "tmpfs"),
                                   ("/run/private", "/", "ext4")):
            candidate = mounts(line(), line(2, 1, "0:99", root, target, kind=kind))
            with self.subTest(target=target, root=root, kind=kind), self.assertRaises(RuntimeError):
                NATIVE["require_known_mask_origins"](value, candidate, set())


class KeeperEnvironmentTests(unittest.TestCase):
    def test_bwrap_pwd_and_actual_cwd_match_the_same_canonical_scratch(self):
        scratch = "/mnt/vector-agent-sandbox/tool-scratch"
        for environment in (
            {"PWD": scratch},
            {"PWD": scratch, "PATH": "/usr/bin:/bin", "HOME": scratch, "LC_ALL": "C", "LC_CTYPE": "C.UTF-8"},
            {"PWD": scratch, "PATH": "existing-value-contract", "HOME": "existing-value-contract"},
        ):
            original = copy.deepcopy(environment)
            with self.subTest(environment=environment):
                self.assertIsNone(NATIVE["keeper_environment"](environment, scratch, scratch))
                self.assertEqual(environment, original)

    def test_missing_wrong_or_aliased_pwd_cwd_and_unknown_names_are_refused(self):
        scratch = "/mnt/vector-agent-sandbox/tool-scratch"
        cases = (
            ({}, scratch, scratch),
            ({"PWD": ""}, scratch, scratch),
            ({"PWD": "/tmp"}, scratch, scratch),
            ({"PWD": scratch + "/"}, scratch, scratch),
            ({"PWD": scratch}, scratch, None),
            ({"PWD": scratch}, scratch, "/tmp"),
            ({"PWD": scratch}, scratch, scratch + "/"),
            ({"PWD": scratch + "/"}, scratch + "/", scratch + "/"),
            ({"PWD": "relative"}, "relative", "relative"),
        )
        for environment, target, cwd in cases:
            with self.subTest(environment=environment, scratch=target, cwd=cwd), self.assertRaises(RuntimeError):
                NATIVE["keeper_environment"](environment, target, cwd)
        for name in ("LD_PRELOAD", "GITHUB_TOKEN", "VECTOR_PRIVATE", "UNKNOWN"):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                NATIVE["keeper_environment"]({"PWD": scratch, name: "never-forward"}, scratch, scratch)


class KeeperLogTests(unittest.TestCase):
    def test_only_exact_ordered_lf_markers_return_fixed_stages(self):
        prefix = b"VECTOR_NATIVE_KEEPER_STAGE "
        phases = ("identity", "capabilities", "environment", "ready-write")
        for count, phase in enumerate(phases, start=1):
            data = b"private-path argv token=never-forward\xff\n" + b"".join(
                prefix + item.encode("ascii") + b"\nraw-undecodable-stderr\xfe\n" for item in phases[:count])
            with self.subTest(phase=phase):
                self.assertEqual(NATIVE["keeper_log_stage"](data), phase)
        marker = prefix + b"identity\n"
        exact_bound = b"x" * (65536 - len(marker) - 1) + b"\n" + marker
        self.assertEqual(len(exact_bound), 65536)
        self.assertEqual(NATIVE["keeper_log_stage"](exact_bound), "identity")
        self.assertIsNone(NATIVE["keeper_log_stage"](b"\xffprivate-stderr-only\xfe\n"))

    def test_malformed_markers_nonbytes_and_overbound_stderr_never_escape(self):
        prefix = b"VECTOR_NATIVE_KEEPER_STAGE "
        identity = prefix + b"identity\n"
        full = b"".join(prefix + phase + b"\n" for phase in
                        (b"identity", b"capabilities", b"environment", b"ready-write"))
        malformed = (
            prefix + b"capabilities\n", identity + prefix + b"environment\n", identity + identity,
            full + prefix + b"ready-write\n", identity + prefix + b"unknown-secret-value\n",
            prefix + b"identity", identity + prefix + b"capabilities", prefix + b"identity\r\n",
            prefix + b"identity\r", prefix + b"identity \n", prefix + b"identity\0\n",
            b"VECTOR_NATIVE_KEEPER_STAGE\n", b"VECTOR_NATIVE_KEEPER_STAGE_EXTRA identity\n",
            identity + b"VECTOR_NATIVE_KEEPER_STAGE", identity + prefix + b"\xff\n",
        )
        for data in malformed:
            with self.subTest(data=data):
                self.assertIsNone(NATIVE["keeper_log_stage"](data))
        for data in (None, "VECTOR_NATIVE_KEEPER_STAGE identity\n", bytearray(identity), memoryview(identity),
                     7, identity + b"x" * 65536, b"x" * 65537):
            self.assertIsNone(NATIVE["keeper_log_stage"](data))


class KeeperDiagnosticTests(unittest.TestCase):
    def test_log_classification_keeps_opaque_stderr_private_and_marker_stages_closed(self):
        classify = NATIVE["keeper_log_classification"]
        self.assertEqual(classify(b""), "empty")
        for data in (b"opaque stderr\n", b"/owner/private synthetic-private-token\xff\0\n", b"x" * 65536):
            with self.subTest(data=data[:80]):
                self.assertEqual(classify(data), "no-marker")
        prefix = b"VECTOR_NATIVE_KEEPER_STAGE "
        phases = ("identity", "capabilities", "environment", "ready-write")
        for count, phase in enumerate(phases, start=1):
            data = b"\xff/owner/private\n" + b"".join(
                prefix + item.encode("ascii") + b"\n" for item in phases[:count])
            self.assertEqual(classify(data), "phase-" + phase)
        for data in (
            prefix + b"capabilities\n", prefix + b"identity", prefix + b"identity\r\n",
            prefix + b"identity\n" + prefix + b"identity\n", prefix + b"private-path /owner/secret\n",
            b"VECTOR_NATIVE_KEEPER_STAGE_EXTRA identity\n",
        ):
            self.assertEqual(classify(data), "invalid")
        for data in (None, "private stderr", bytearray(b""), memoryview(b""), 7, b"x" * 65537):
            self.assertEqual(classify(data), "invalid")

    def test_pinned_fatal_labels_return_only_fixed_private_output_free_categories(self):
        labels = (
            ("bwrap-initial-caps", b"bwrap: Unexpected capabilities but not setuid, old file caps config?", True),
            ("bwrap-capset", b"bwrap: capset failed: ", False),
            ("bwrap-userns-denied", b"bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces. On e.g. debian this can be enabled with 'sysctl kernel.unprivileged_userns_clone=1'.", True),
            ("bwrap-clone", b"bwrap: Creating new namespace failed: ", False),
            ("bwrap-clone", b"bwrap: Creating new namespace failed, likely because the kernel does not support user namespaces.  bwrap must be installed setuid on such systems.", True),
            ("bwrap-uid-map", b"bwrap: setting up uid map: ", False),
            ("bwrap-gid-map", b"bwrap: setting up gid map: ", False),
            ("bwrap-setgroups", b"bwrap: error writing to setgroups: ", False),
            ("bwrap-mount-propagation", b"bwrap: Failed to make / slave: ", False),
            ("bwrap-root-tmpfs", b"bwrap: Failed to mount tmpfs: ", False),
            ("bwrap-source", b"bwrap: Can't find source path ", False),
            ("bwrap-source", b"bwrap: Can't get type of source ", False),
            ("bwrap-destination", b"bwrap: Can't mkdir ", False),
            ("bwrap-bind", b"bwrap: Can't bind mount ", False),
            ("bwrap-remount", b"bwrap: Can't remount readonly on ", False),
            ("bwrap-proc", b"bwrap: Can't mount proc on ", False),
            ("bwrap-mask-tmpfs", b"bwrap: Can't mount tmpfs on ", False),
            ("bwrap-devpts", b"bwrap: Can't mount devpts on ", False),
            ("bwrap-pivot", b"bwrap: pivot_root: ", False),
            ("bwrap-pivot", b"bwrap: pivot_root(/newroot): ", False),
            ("bwrap-exec", b"bwrap: execvp /usr/bin/python3: ", False),
        )
        self.assertEqual(len(labels), 21)
        self.assertEqual(len({category for category, _, _ in labels}), 18)
        for category, label, exact_label in labels:
            suffix = b"" if exact_label else b"Permission denied /owner/private synthetic-private-token\xff"
            data = b"opaque stderr\xfe\n" + label + suffix + b"\n"
            with self.subTest(category=category, label=label):
                result = NATIVE["keeper_log_classification"](data)
                self.assertEqual(result, category)
                self.assertNotIn("private", result)
                self.assertNotIn("/", result)
                self.assertNotIn("Permission", result)
                self.assertEqual(NATIVE["keeper_log_classification"](
                    b"VECTOR_NATIVE_KEEPER_STAGE identity\n" + data), category)
                for near_match in (
                    b"prefix " + label + suffix + b"\n", label.replace(b"bwrap:", b"Bwrap:", 1) + suffix + b"\n",
                    label + b" private-suffix\n" if exact_label else label[:-1] + suffix + b"\n",
                ):
                    self.assertEqual(NATIVE["keeper_log_classification"](near_match), "no-marker")
                self.assertEqual(NATIVE["keeper_log_classification"](label + suffix), "invalid")
                self.assertEqual(NATIVE["keeper_log_classification"](data + data), "invalid")

    def test_fatal_classification_requires_pinned_prefix_case_delimiter_and_complete_unique_line(self):
        classify = NATIVE["keeper_log_classification"]
        exact = b"bwrap: Unexpected capabilities but not setuid, old file caps config?"
        prefix = b"bwrap: capset failed: "
        complete = prefix + b"Permission denied\n"
        for data in (
            b"Bwrap: capset failed: Permission denied\n", b"bwrap: Capset failed: Permission denied\n",
            b"prefix " + complete, b"bwrap: capset failed:Permission denied\n",
            b"bwrap: capset failed Permission denied\n", b"bwrap: capset faile\n",
            exact + b" extra-private-value\n", exact.lower() + b"\n",
            b"bwrap: execvp /bin/sh: Permission denied\n", b"bwrap: execvp /usr/bin/python3-private: Permission denied\n",
            b"bwrap: Failed to make /owner/private slave: Permission denied\n",
        ):
            with self.subTest(data=data):
                self.assertEqual(classify(data), "no-marker")
        for data in (
            exact, prefix + b"Permission denied", complete + complete,
            complete + b"bwrap: setting up uid map: Permission denied\n",
            b"bwrap: Creating new namespace failed: Permission denied\n" +
            b"bwrap: Creating new namespace failed, likely because the kernel does not support user namespaces.  bwrap must be installed setuid on such systems.\n",
            b"VECTOR_NATIVE_KEEPER_STAGE capabilities\n" + complete,
        ):
            with self.subTest(data=data):
                self.assertEqual(classify(data), "invalid")

    def test_info_progress_accepts_only_bounded_child_creation_with_known_namespace_ids(self):
        progress = NATIVE["keeper_info_progress"]
        self.assertEqual(progress(b""), "empty")
        fields = ("cgroup-namespace", "ipc-namespace", "mnt-namespace", "net-namespace", "pid-namespace", "uts-namespace")
        records = [{"child-pid": 2}, {"child-pid": 9007199254740991}]
        records.extend({"child-pid": 42, field: 1} for field in fields)
        records.append({"child-pid": 42, **{field: index + 1 for index, field in enumerate(fields)}})
        for record in records:
            with self.subTest(record=record):
                self.assertEqual(progress(json.dumps(record).encode("utf-8")), "child-created")
        data = b'{"child-pid":2}'
        boundary = data + b" " * (65536 - len(data))
        self.assertEqual(len(boundary), 65536)
        self.assertEqual(progress(boundary), "child-created")
        self.assertEqual(progress(boundary + b" "), "invalid")

    def test_info_progress_refuses_malformed_duplicate_unknown_and_unsafe_fields_without_returning_data(self):
        progress = NATIVE["keeper_info_progress"]
        for data in (
            b" ", b"\xff", b"{", b"{}", b"[]", b"null", b"2", b"true",
            b'{"child-pid":2,"child-pid":3}', b'{"child-pid":2,"ipc-namespace":1,"ipc-namespace":2}',
            b'{"child-pid":2,"user-namespace":3}', b'{"child-pid":2,"private-path":"/owner/secret"}',
            b'{"child-pid":2} trailing', b'{"child-pid":NaN}',
        ):
            with self.subTest(data=data):
                self.assertEqual(progress(data), "invalid")
        for value in (None, False, True, 0, 1, -1, 1.5, "2", 9007199254740992, {}, []):
            self.assertEqual(progress(json.dumps({"child-pid": value}).encode("utf-8")), "invalid")
        for field in ("cgroup-namespace", "ipc-namespace", "mnt-namespace", "net-namespace", "pid-namespace", "uts-namespace"):
            for value in (None, False, True, 0, -1, 1.5, "1", 9007199254740992, {}, []):
                with self.subTest(field=field, value=value):
                    self.assertEqual(progress(json.dumps({"child-pid": 2, field: value}).encode("utf-8")), "invalid")
        for data in (None, "private-info", bytearray(b""), memoryview(b""), 7, b"x" * 65537):
            self.assertEqual(progress(data), "invalid")

    def test_failure_stage_builder_returns_the_exact_closed_product_and_refuses_unknown_values(self):
        logs = (
            "empty", "no-marker", "invalid", "unstable", "unreadable", "phase-identity", "phase-capabilities",
            "phase-environment", "phase-ready-write", "bwrap-initial-caps", "bwrap-capset", "bwrap-userns-denied",
            "bwrap-clone", "bwrap-uid-map", "bwrap-gid-map", "bwrap-setgroups", "bwrap-mount-propagation",
            "bwrap-root-tmpfs", "bwrap-source", "bwrap-destination", "bwrap-bind", "bwrap-remount",
            "bwrap-proc", "bwrap-mask-tmpfs", "bwrap-devpts", "bwrap-pivot", "bwrap-exec",
        )
        stages = []
        for outcome in ("child-exit", "timeout"):
            for log in logs:
                for info in ("empty", "child-created", "invalid"):
                    stage = NATIVE["keeper_failure_stage"](outcome, log, info)
                    self.assertEqual(stage, f"prepare-keeper-{outcome}-log-{log}-info-{info}")
                    stages.append(stage)
        self.assertEqual(len(stages), 162)
        self.assertEqual(len(set(stages)), 162)
        for values in (
            ("exit", "empty", "empty"), ("child-exit-log-empty", "empty", "empty"),
            ("timeout", "phase-network", "empty"), ("child-exit", "bwrap-private", "empty"),
            ("child-exit", "/owner/private", "empty"), ("child-exit", "empty", "/run/private"),
            ("child-exit", "empty", "ready"), ("timeout", "empty", "invalid\nprivate-value"),
            (None, "empty", "empty"), (b"child-exit", "empty", "empty"), (True, "empty", "empty"),
        ):
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                NATIVE["keeper_failure_stage"](*values)


class SourceStructureTests(unittest.TestCase):
    def test_only_allowlisted_pure_definitions_are_executed(self):
        self.assertEqual({node.name for node in SELECTED if isinstance(node, ast.FunctionDef)}, PURE)
        self.assertFalse(any(isinstance(node, (ast.Import, ast.ImportFrom)) for node in SELECTED))
        forbidden = {"open", "eval", "exec", "__import__", "mount_table", "read_state", "validate_source_view",
                     "validate_masks", "pin_source", "source_record", "capture_mount_namespace"}
        for name in PURE:
            for node in ast.walk(FUNCTIONS[name]):
                if isinstance(node, ast.Call):
                    self.assertNotIn(ast.unparse(node.func), forbidden)
                    self.assertFalse(ast.unparse(node.func).startswith(("LIBC.", "os.open", "os.stat", "os.fstat",
                                                                        "os.unshare", "fcntl.", "subprocess.")))

    def test_root_construction_sequence_is_confined_to_prepare(self):
        self.assertEqual([name for name in FUNCTIONS if calls(name, "os.unshare")], ["capture_mount_namespace"])
        self.assertEqual([name for name in FUNCTIONS if calls(name, "LIBC.mount")], ["capture_mount_namespace"])
        unshare = calls("capture_mount_namespace", "os.unshare")
        private = calls("capture_mount_namespace", "LIBC.mount")
        self.assertEqual(len(unshare), 1)
        self.assertEqual(len(private), 1)
        self.assertLess(unshare[0].lineno, private[0].lineno)
        self.assertEqual(ast.dump(unshare[0].args[0]), ast.dump(ast.parse("KINDS['mnt']", mode="eval").body))
        self.assertEqual([ast.literal_eval(value) for value in private[0].args[:3]], [None, b"/", None])
        self.assertEqual(ast.dump(private[0].args[3]), ast.dump(ast.parse("16384 | 262144", mode="eval").body))
        self.assertIsNone(ast.literal_eval(private[0].args[4]))
        self.assertLess(private[0].lineno, calls("capture_mount_namespace", "require_private_mounts")[0].lineno)
        callers = [name for name in FUNCTIONS if calls(name, "capture_mount_namespace")]
        self.assertEqual(callers, ["prepare"])
        self.assertLess(calls("prepare", "os.geteuid")[0].lineno,
                        calls("prepare", "capture_mount_namespace")[0].lineno)
        self.assertLess(calls("prepare", "capture_mount_namespace")[0].lineno,
                        calls("prepare", "prepare_in_capture")[0].lineno)
        self.assertEqual([name for name in FUNCTIONS if calls(name, "supported_mask_sources")], ["prepare_in_capture"])

    def test_broker_inherits_only_listener_and_three_keeper_descriptors(self):
        self.assertEqual([argument.arg for argument in FUNCTIONS["broker"].args.args],
                         ["parent", "listener_fd", "descriptors"])
        launch = next(node for node in calls("prepare_in_capture", "subprocess.Popen") if
                      any(isinstance(value, ast.Constant) and value.value == "broker" for value in ast.walk(node.args[0])))
        keywords = {keyword.arg: keyword.value for keyword in launch.keywords}
        self.assertTrue(ast.literal_eval(keywords["close_fds"]))
        self.assertEqual(ast.dump(keywords["pass_fds"]),
                         ast.dump(ast.parse("(listener.fileno(), *descriptors.values())", mode="eval").body))
        self.assertFalse(any(isinstance(node, ast.Name) and node.id in {"capture", "pins"}
                             for node in ast.walk(keywords["pass_fds"])))
        expected = ast.parse("fd < 3 or fd in {listener_fd, *descriptors.values()}", mode="eval").body
        self.assertTrue(any(ast.dump(node.test) == ast.dump(expected) for node in ast.walk(FUNCTIONS["broker"])
                            if isinstance(node, ast.If)))
        self.assertTrue(calls("broker", "validate_descriptors"))
        self.assertTrue(calls("broker", "validate_source_view"))
        wait = FUNCTIONS["wait_keeper"]
        self.assertEqual(wait.args.args[-1].arg, "seconds")
        self.assertEqual([ast.literal_eval(value) for value in wait.args.defaults], [5])
        invocation = calls("prepare_in_capture", "wait_keeper")
        self.assertEqual(len(invocation), 1)
        self.assertEqual(len(invocation[0].args), 5)
        self.assertFalse(invocation[0].keywords)
        self.assertEqual([ast.dump(value) for value in invocation[0].args],
                         [ast.dump(value) for value in ast.parse(
                             "f(value['scratch'] + '/keeper-ready.json', value['directory'] + '/keeper.log', "
                             "info_path, uid, process)", mode="eval").body.args])
        self.assertEqual(len(calls("wait_keeper", "process.poll")), 1)
        self.assertEqual([ast.literal_eval(call.args[0]) for call in calls("wait_keeper", "time.sleep")], [0.01])
        child_error = calls("wait_keeper", "subprocess.CalledProcessError")
        timeout = calls("wait_keeper", "subprocess.TimeoutExpired")
        self.assertEqual(len(child_error), 1)
        self.assertEqual(len(timeout), 1)
        self.assertEqual([ast.dump(value) for value in child_error[0].args],
                         [ast.dump(value) for value in ast.parse("f(result, ('fixed-keeper',))", mode="eval").body.args])
        self.assertEqual([ast.dump(value) for value in timeout[0].args],
                         [ast.dump(value) for value in ast.parse("f(('fixed-keeper',), seconds)", mode="eval").body.args])
        self.assertEqual({ast.dump(node.exc) for node in ast.walk(wait) if isinstance(node, ast.Raise)},
                         {ast.dump(child_error[0]), ast.dump(timeout[0])})
        diagnostics = calls("wait_keeper", "read_keeper_diagnostic")
        self.assertEqual(len(diagnostics), 4)
        self.assertCountEqual(
            [tuple(ast.dump(value) for value in call.args) for call in diagnostics],
            [tuple(ast.dump(value) for value in ast.parse(expression, mode="eval").body.args)
             for expression in ("f(log, 'log')", "f(info, 'info')", "f(log, 'log')", "f(info, 'info')")])
        self.assertTrue(all(not call.keywords for call in diagnostics))
        stages = {ast.dump(node.value) for node in ast.walk(wait) if isinstance(node, ast.Assign) and
                  any(isinstance(target, ast.Name) and target.id == "_DIAGNOSTIC_STAGE" for target in node.targets)}
        expected_stages = {
            ast.dump(ast.parse(expression, mode="eval").body) for expression in (
                "keeper_failure_stage('child-exit', read_keeper_diagnostic(log, 'log'), read_keeper_diagnostic(info, 'info'))",
                "keeper_failure_stage('timeout', read_keeper_diagnostic(log, 'log'), read_keeper_diagnostic(info, 'info'))",
                "'prepare-keeper-ready-record'",
            )}
        self.assertEqual(stages, expected_stages)
        expressions = {ast.dump(node) for node in ast.walk(wait)}
        for expression in ("time.monotonic() + seconds", "time.monotonic() >= deadline", "read_json(name, owner)"):
            self.assertIn(ast.dump(ast.parse(expression, mode="eval").body), expressions)
        reader = FUNCTIONS["read_keeper_diagnostic"]
        self.assertEqual([argument.arg for argument in reader.args.args], ["name", "kind"])
        opened = calls("read_keeper_diagnostic", "os.open")
        self.assertEqual(len(opened), 1)
        self.assertEqual(ast.dump(opened[0].args[1]),
                         ast.dump(ast.parse("os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK", mode="eval").body))
        read = calls("read_keeper_diagnostic", "os.read")
        self.assertEqual(len(read), 1)
        self.assertEqual(ast.literal_eval(read[0].args[1]), 65537)
        snapshots = calls("read_keeper_diagnostic", "os.fstat")
        self.assertEqual(len(snapshots), 2)
        self.assertLess(snapshots[0].lineno, read[0].lineno)
        self.assertLess(read[0].lineno, snapshots[1].lineno)
        expressions = {ast.dump(node) for node in ast.walk(reader)}
        for expression in (
            "stat.S_ISREG(before.st_mode)", "before.st_uid == before.st_gid == 0", "before.st_nlink == 1",
            "kind not in ('log', 'info')", "stat.S_IMODE(before.st_mode) == 0o600", "before.st_size <= 65536",
            "len(data) != before.st_size",
            "(before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_gid, before.st_nlink, "
            "before.st_size, before.st_mtime_ns, before.st_ctime_ns) != "
            "(after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid, after.st_nlink, "
            "after.st_size, after.st_mtime_ns, after.st_ctime_ns)",
        ):
            self.assertIn(ast.dump(ast.parse(expression, mode="eval").body), expressions)
        self.assertEqual({ast.dump(node.value) for node in ast.walk(reader) if isinstance(node, ast.Return)},
                         {ast.dump(ast.parse(expression, mode="eval").body) for expression in (
                             "'invalid'", "'unstable' if kind == 'log' else 'invalid'",
                             "keeper_log_classification(data) if kind == 'log' else keeper_info_progress(data)",
                             "'unreadable' if kind == 'log' else 'invalid'",
                         )})
        for function in ("read_keeper_diagnostic", "wait_keeper", "keeper_failure_stage"):
            for output in ("print", "os.write", "sys.stdout.write", "sys.stdout.buffer.write",
                           "sys.stderr.write", "sys.stderr.buffer.write"):
                self.assertFalse(calls(function, output), (function, output))
        handlers = [node for node in ast.walk(reader) if isinstance(node, ast.ExceptHandler)]
        self.assertEqual(len(handlers), 1)
        self.assertEqual(ast.dump(handlers[0].type),
                         ast.dump(ast.parse("(OSError, RuntimeError, ValueError)", mode="eval").body))
        self.assertEqual(len(calls("read_keeper_diagnostic", "os.close")), 1)
        builder = FUNCTIONS["keeper_failure_stage"]
        self.assertEqual([argument.arg for argument in builder.args.args], ["outcome", "log", "info"])
        self.assertEqual({ast.dump(node.value) for node in ast.walk(builder) if isinstance(node, ast.Return)},
                         {ast.dump(ast.parse("'prepare-keeper-' + outcome + '-log-' + log + '-info-' + info",
                                             mode="eval").body)})
        keeper = FUNCTIONS["keeper"]
        markers = calls("keeper", "keeper_marker")
        self.assertEqual([ast.literal_eval(call.args[0]) for call in markers],
                         ["identity", "capabilities", "environment", "ready-write"])
        guard_expressions = (
            "require(os.getuid() == os.getgid() == 0 and os.getgroups() == [])",
            "assert_capabilities_dropped()",
            "keeper_environment(dict(os.environ), scratch, os.getcwd())",
        )
        for index, expression in enumerate(guard_expressions):
            guard = keeper.body[index * 2 + 1]
            self.assertEqual(ast.dump(guard.value), ast.dump(ast.parse(expression, mode="eval").body))
            self.assertLess(markers[index].lineno, guard.lineno)
            self.assertLess(guard.lineno, markers[index + 1].lineno)
        ready = calls("keeper", "write_json")
        self.assertEqual(len(ready), 1)
        self.assertLess(markers[-1].lineno, ready[0].lineno)
        self.assertEqual(ast.literal_eval(ready[0].args[2]), 0o600)

    def test_cleanup_record_validation_has_no_live_source_dependencies(self):
        self.assertTrue(calls("read_state", "mask_records"))
        forbidden = {"capture_mount_namespace", "supported_mask_sources", "validate_source_view", "validate_masks",
                     "mount_table", "parse_mount_table", "refuse_mask_aliases", "require_known_mask_origins",
                     "require_capture_closure", "wait_keeper", "read_keeper_diagnostic", "keeper_log_classification",
                     "keeper_info_progress", "keeper_failure_stage"}
        for function in ("cleanup", "read_state", "mask_records"):
            for name in forbidden:
                self.assertFalse(calls(function, name), (function, name))
        cleanup = FUNCTIONS["cleanup"]
        uid_stop = next(node.lineno for node in ast.walk(cleanup) if isinstance(node, ast.Constant) and
                        node.value == "cleanup-uid-stop")
        broker_stop = next(node.lineno for node in ast.walk(cleanup) if isinstance(node, ast.Constant) and
                           node.value == "cleanup-broker-stop")
        self.assertLess(uid_stop, broker_stop)


if __name__ == "__main__":
    if os.environ.get("CI") != "true":
        raise SystemExit("Native mask-origin fixture is restricted to the approved CI job")
    unittest.main()
