"""CI-only pure-function checks for the immutable native source asset.

Run from packages/core in the approved native CI job:
    /usr/bin/python3 -I -S -B test/fixture/native-mask-origins.py

The asset is parsed as data. Only the explicit pure-function allowlist, its
three path constants (CONTAINERS, RUNNER_HOME, MASKS) and the four fixed guarded
statements of supported_mask_sources named in FRAGMENTS are compiled, the latter
on synthetic metadata only; module initialization, ctypes and live native
operations are never imported or executed by this fixture.
"""

import ast
import copy
import errno
import hashlib
import json
import os
import pathlib
import re
import stat
import unittest
from types import SimpleNamespace


ENTRY = pathlib.Path(__file__).resolve().parents[2] / "src/process-isolation/linux/entry.py"
TREE = ast.parse(ENTRY.read_text(encoding="utf-8"), filename=str(ENTRY))
FUNCTIONS = {node.name: node for node in TREE.body if isinstance(node, ast.FunctionDef)}
PURE = {
    "require", "integer", "exact", "canonical", "object_identity", "construction_namespace",
    "filesystem", "json_digest", "digest_value", "mask_records", "mount_field", "mount_path", "parse_mount_table",
    "beneath", "hidden", "refuse_mask_aliases", "require_private_mounts", "require_known_mask_origins",
    "require_capture_closure", "keeper_log_stage", "keeper_environment", "keeper_log_classification",
    "keeper_info_progress", "keeper_failure_stage", "keeper_destination_stage", "keeper_searchable",
}
CONSTANTS = {"CONTAINERS", "RUNNER_HOME", "MASKS"}
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


DESTINATION_PREFIXES = (b"bwrap: Can't mkdir ", b"bwrap: Can't mkdir parents for ")
DESTINATIONS = (
    ("root", b"/"), ("home", b"/home/vector-agent"), ("tmp", b"/tmp"), ("var-tmp", b"/var/tmp"),
    ("run", b"/run"), ("runner-home", b"/home/runner"), ("dev", b"/dev"), ("proc", b"/proc"),
) + tuple((kind, container + suffix)
          for container in (b"/mnt/vector-agent-sandbox", b"/var/lib/vector-agent-sandbox", b"/home/vector-agent-sandbox")
          for kind, suffix in (("checkout", b"/checkout"), ("scratch", b"/tool-scratch")))
DESTINATION_KINDS = ("root", "home", "tmp", "var-tmp", "run", "runner-home", "dev", "proc", "checkout", "scratch")
# The exact C-locale strerror text bubblewrap v0.9.0 prints for each closed cause (utils.c:die_with_error).
CAUSES = (("eacces", errno.EACCES, b"Permission denied"), ("erofs", errno.EROFS, b"Read-only file system"),
          ("enoent", errno.ENOENT, b"No such file or directory"), ("enotdir", errno.ENOTDIR, b"Not a directory"),
          ("eloop", errno.ELOOP, b"Too many levels of symbolic links"),
          ("eperm", errno.EPERM, b"Operation not permitted"))
KEEPER_LOGS = (
    "empty", "no-marker", "invalid", "unstable", "unreadable", "phase-identity", "phase-capabilities",
    "phase-environment", "phase-ready-write", "bwrap-initial-caps", "bwrap-capset", "bwrap-userns-denied",
    "bwrap-clone", "bwrap-uid-map", "bwrap-gid-map", "bwrap-setgroups", "bwrap-mount-propagation",
    "bwrap-root-tmpfs", "bwrap-source", "bwrap-destination", "bwrap-bind", "bwrap-remount",
    "bwrap-destination-root", "bwrap-destination-home", "bwrap-destination-tmp",
    "bwrap-destination-var-tmp", "bwrap-destination-run", "bwrap-destination-runner-home",
    "bwrap-destination-dev", "bwrap-destination-proc", "bwrap-destination-checkout",
    "bwrap-destination-scratch",
    "bwrap-proc", "bwrap-mask-tmpfs", "bwrap-devpts", "bwrap-pivot", "bwrap-exec",
) + tuple("bwrap-destination-" + kind + "-" + cause for kind in DESTINATION_KINDS for cause, _, _ in CAUSES)


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
            ("bwrap-userns-denied", b"bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.", True),
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
        self.assertEqual(len(labels), 22)
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

    def test_ubuntu_userns_denied_text_is_exact(self):
        # NQ-D4: Ubuntu 0.9.0-1ubuntu0.3's rewritten userns-denied line, and near copies of it that must not match.
        classify = NATIVE["keeper_log_classification"]
        ubuntu = b"bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>."
        self.assertEqual(classify(ubuntu + b"\n"), "bwrap-userns-denied")
        for data in (
            ubuntu + b" private-suffix\n", ubuntu.lower() + b"\n",
            ubuntu[: ubuntu.index(b" See <https://deb.li/bubblewrap>") + len(b" See <https://deb.li/bubblewrap>")] + b"\n",
        ):
            with self.subTest(data=data):
                self.assertEqual(classify(data), "no-marker")
        for data in (ubuntu, ubuntu + b"\n" + ubuntu + b"\n"):
            with self.subTest(data=data):
                self.assertEqual(classify(data), "invalid")

    def test_destination_diagnostics_name_only_exact_fixed_targets(self):
        targets = (
            ("root", b"/"), ("home", b"/home/vector-agent"), ("tmp", b"/tmp"), ("var-tmp", b"/var/tmp"),
            ("run", b"/run"), ("runner-home", b"/home/runner"), ("dev", b"/dev"), ("proc", b"/proc"),
        )
        targets += tuple((kind, container + suffix)
                         for container in (b"/mnt/vector-agent-sandbox", b"/var/lib/vector-agent-sandbox",
                                           b"/home/vector-agent-sandbox")
                         for kind, suffix in (("checkout", b"/checkout"), ("scratch", b"/tool-scratch")))
        for prefix in (b"bwrap: Can't mkdir ", b"bwrap: Can't mkdir parents for "):
            for kind, target in targets:
                with self.subTest(prefix=prefix, kind=kind, target=target):
                    data = prefix + target + b": Permission denied synthetic-private-token\xff\n"
                    result = NATIVE["keeper_log_classification"](data)
                    self.assertEqual(result, "bwrap-destination-" + kind)
                    self.assertNotIn("/", result)
                    self.assertNotIn("private", result)
                    self.assertEqual(NATIVE["keeper_log_classification"](
                        prefix + target + b"-private: Permission denied\n"), "bwrap-destination")
                    self.assertEqual(NATIVE["keeper_log_classification"](
                        prefix + target + b"/private: Permission denied\n"), "bwrap-destination")
        self.assertEqual(NATIVE["keeper_destination_stage"](b"/owner/private"), "bwrap-destination")
        self.assertEqual(NATIVE["keeper_destination_stage"]("private"), "bwrap-destination")
        self.assertEqual(NATIVE["keeper_destination_stage"](b"x" * 65537), "bwrap-destination")

    def test_destination_errno_causes_are_one_closed_suffix_per_fixed_target(self):
        classify = NATIVE["keeper_log_classification"]
        destination = NATIVE["keeper_destination_stage"]
        for cause, number, text in CAUSES:
            with self.subTest(cause=cause):
                # bubblewrap formats strerror without setlocale, so the runner C library's C-locale text is exact.
                self.assertEqual(os.strerror(number).encode("ascii"), text)
        words = {word.lower() for _, _, text in CAUSES for word in text.decode("ascii").split() if len(word) > 3}
        for prefix in DESTINATION_PREFIXES:
            for kind, target in DESTINATIONS:
                for cause, _, text in CAUSES:
                    with self.subTest(prefix=prefix, kind=kind, target=target, cause=cause):
                        data = prefix + target + b": " + text
                        label = "bwrap-destination-" + kind + "-" + cause
                        self.assertEqual(destination(data), label)
                        self.assertEqual(classify(data + b"\n"), label)
                        self.assertEqual(classify(b"opaque stderr\xfe\n" + data + b"\n"), label)
                        self.assertEqual(classify(b"VECTOR_NATIVE_KEEPER_STAGE identity\n" + data + b"\n"), label)
                        self.assertIsNotNone(re.fullmatch(r"[a-z-]+", label))
                        self.assertFalse(any(word in label for word in words))
                        self.assertEqual(NATIVE["keeper_failure_stage"]("child-exit", label, "child-created"),
                                         "prepare-keeper-child-exit-log-" + label + "-info-child-created")
        for prefix in DESTINATION_PREFIXES:
            with self.subTest(prefix=prefix):
                log = classify(prefix + b"/home/runner: Permission denied\n")
                self.assertEqual(NATIVE["keeper_failure_stage"]("child-exit", log, "child-created"),
                                 "prepare-keeper-child-exit-log-bwrap-destination-runner-home-eacces-info-child-created")
                # The former hosted temporary target is no longer a fixed destination, so it fails closed unsuffixed.
                log = classify(prefix + b"/home/runner/work/_temp: Permission denied\n")
                self.assertEqual(NATIVE["keeper_failure_stage"]("child-exit", log, "child-created"),
                                 "prepare-keeper-child-exit-log-bwrap-destination-info-child-created")

    def test_destination_unknown_or_inexact_errno_tails_keep_the_unsuffixed_target_label(self):
        classify = NATIVE["keeper_log_classification"]
        destination = NATIVE["keeper_destination_stage"]
        tails = (
            b"", b"Permission denied synthetic-private-token\xff", b"permission denied", b"PERMISSION DENIED",
            b" Permission denied", b"Permission denied ", b"Permission denied\r", b"Permission denied\0",
            b"Permission denied: Permission denied", b"Input/output error", b"Device or resource busy",
            b"File exists", b"Invalid argument", b"No space left on device", b"Keine Berechtigung",
            b"EACCES", b"eacces", b"Read-only file system /owner/private", b"Not a directory\xff",
        )
        for prefix in DESTINATION_PREFIXES:
            for kind, target in DESTINATIONS:
                for tail in tails:
                    with self.subTest(prefix=prefix, kind=kind, target=target, tail=tail):
                        data = prefix + target + b": " + tail
                        self.assertEqual(destination(data), "bwrap-destination-" + kind)
                        self.assertEqual(classify(data + b"\n"), "bwrap-destination-" + kind)
                self.assertEqual(destination(prefix + target + b": Permission denied\nprivate"),
                                 "bwrap-destination-" + kind)
                for data in (prefix + target + b" Permission denied", prefix + target + b":Permission denied",
                             prefix + target + b"Permission denied"):
                    with self.subTest(prefix=prefix, kind=kind, target=target, data=data):
                        self.assertEqual(destination(data), "bwrap-destination")
                        self.assertEqual(classify(data + b"\n"), "bwrap-destination")
            for target in (b"/owner/private", b"/home/runner/", b"/home/runner/work", b"/home/runner/work/_temp",
                           b"/home/runnerx"):
                for cause, _, text in CAUSES:
                    with self.subTest(prefix=prefix, target=target, cause=cause):
                        data = prefix + target + b": " + text
                        self.assertEqual(destination(data), "bwrap-destination")
                        self.assertEqual(classify(data + b"\n"), "bwrap-destination")

    def test_destination_errno_lines_keep_the_complete_unique_bounded_line_contract(self):
        classify = NATIVE["keeper_log_classification"]
        destination = NATIVE["keeper_destination_stage"]
        data = b"bwrap: Can't mkdir parents for /home/runner: Permission denied"
        results = []
        for log in (
            data, data + b"\n" + data + b"\n",
            data + b"\nbwrap: Can't bind mount /oldroot/private on /newroot/private: Permission denied\n",
            b"VECTOR_NATIVE_KEEPER_STAGE capabilities\n" + data + b"\n",
        ):
            with self.subTest(log=log):
                results.append(classify(log))
                self.assertEqual(results[-1], "invalid")
        for log in (data.replace(b"bwrap:", b"Bwrap:", 1) + b"\n", b"prefix " + data + b"\n"):
            with self.subTest(log=log):
                results.append(classify(log))
                self.assertEqual(results[-1], "no-marker")
        exact = b"x" * (65536 - len(data) - 2) + b"\n" + data + b"\n"
        self.assertEqual(len(exact), 65536)
        results.append(classify(exact))
        self.assertEqual(results[-1], "bwrap-destination-runner-home-eacces")
        results.append(classify(b"x" + exact))
        self.assertEqual(results[-1], "invalid")
        self.assertEqual(destination(data + b"\0" * (65536 - len(data))), "bwrap-destination-runner-home")
        self.assertEqual(destination(data + b"\0" * (65537 - len(data))), "bwrap-destination")
        for value in (data.decode("ascii"), bytearray(data), memoryview(data), None):
            with self.subTest(value=type(value)):
                self.assertEqual(destination(value), "bwrap-destination")
                results.append(classify(value))
                self.assertEqual(results[-1], "invalid")
        for log in results:
            with self.subTest(log=log):
                self.assertEqual(NATIVE["keeper_failure_stage"]("child-exit", log, "child-created"),
                                 "prepare-keeper-child-exit-log-" + log + "-info-child-created")

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
        # 37 unsuffixed log values plus 10 destination targets x 6 closed errno causes.
        self.assertEqual(len(KEEPER_LOGS), 97)
        self.assertEqual(len(set(KEEPER_LOGS)), 97)
        stages = []
        for outcome in ("child-exit", "timeout"):
            for log in KEEPER_LOGS:
                for info in ("empty", "child-created", "invalid"):
                    stage = NATIVE["keeper_failure_stage"](outcome, log, info)
                    self.assertEqual(stage, f"prepare-keeper-{outcome}-log-{log}-info-{info}")
                    stages.append(stage)
        self.assertEqual(len(stages), 582)
        self.assertEqual(len(set(stages)), 582)
        for values in (
            ("exit", "empty", "empty"), ("child-exit-log-empty", "empty", "empty"),
            ("timeout", "phase-network", "empty"), ("child-exit", "bwrap-private", "empty"),
            ("child-exit", "/owner/private", "empty"), ("child-exit", "empty", "/run/private"),
            ("child-exit", "empty", "ready"), ("timeout", "empty", "invalid\nprivate-value"),
            (None, "empty", "empty"), (b"child-exit", "empty", "empty"), (True, "empty", "empty"),
            ("child-exit", "bwrap-destination-eacces", "child-created"),
            ("child-exit", "bwrap-destination-runner-home-eio", "child-created"),
            ("child-exit", "bwrap-destination-runner-home-EACCES", "child-created"),
            ("child-exit", "bwrap-destination-runner-home-eacces-eacces", "child-created"),
            ("child-exit", "bwrap-destination-private-eacces", "child-created"),
            ("child-exit", "bwrap-bind-eacces", "child-created"),
            ("child-exit", "bwrap-destination-runner-home-Permission denied", "child-created"),
            ("child-exit", "bwrap-destination-runner-home-", "child-created"),
            ("timeout", "bwrap-destination-runner-home-eacces", "child-created-eacces"),
            # The removed hosted temporary destination kind.
            ("child-exit", "bwrap-destination-host-temp", "child-created"),
            ("child-exit", "bwrap-destination-host-temp-eacces", "child-created"),
        ):
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                NATIVE["keeper_failure_stage"](*values)


# The keeper is vector-agent with its own user group; the runner is 1001:1001 and 118 is a foreign group (docker).
KEEPER = (1002, 1002)
MASK_STEPS = ("target-stat", "target-type", "target-canonical", "target-owner", "target-mode", "parent-stat",
              "parent-type", "parent-owner", "parent-mode", "parent-canonical", "mount-present", "mount-device",
              "keeper-search")
MASK_LITERALS = tuple("prepare-mask-" + step for step in (
    "os-chain", "os-open", "os-stat", "os-read", "os-decode", "os-version", "runner-lookup", "runner-identity",
    "mount-table", "origins", "aliases"))


def stage_assignments(function):
    return sorted((node for node in ast.walk(FUNCTIONS[function]) if isinstance(node, ast.Assign) and
                   any(isinstance(target, ast.Name) and target.id == "_DIAGNOSTIC_STAGE" for target in node.targets)),
                  key=lambda node: node.lineno)


# The only statements of the non-pure supported_mask_sources this fixture compiles: each fixed stage assignment with
# the one guarded statement after it. They run on synthetic metadata; no lstat, realpath, pin or mount call is reached.
FRAGMENTS = {
    "runner-identity": "_DIAGNOSTIC_STAGE = 'prepare-mask-runner-identity'",
    "target-owner": "_DIAGNOSTIC_STAGE = f'prepare-mask-{label}-target-owner'",
    "parent-owner": "_DIAGNOSTIC_STAGE = f'prepare-mask-{label}-parent-owner'",
    "parent-mode": "_DIAGNOSTIC_STAGE = f'prepare-mask-{label}-parent-mode'",
}
FRAGMENT_CALLS = {"require", "integer"}
FRAGMENT_NAMES = FRAGMENT_CALLS | {"_DIAGNOSTIC_STAGE", "label", "target", "info", "item", "uid", "gid", "runner",
                                   "RUNNER_HOME"}
RUNNER = SimpleNamespace(pw_uid=1001, pw_dir="/home/runner")


def fragment(step):
    stage = ast.dump(ast.parse(FRAGMENTS[step]).body[0])
    found = [body[index:index + 2] for node in ast.walk(FUNCTIONS["supported_mask_sources"])
             for body in (getattr(node, "body", None), getattr(node, "orelse", None)) if type(body) is list
             for index in range(len(body) - 1) if ast.dump(body[index]) == stage]
    if len(found) != 1:
        raise AssertionError("A guarded mask admission statement moved")
    nodes = [node for statement in found[0] for node in ast.walk(statement)]
    if ({ast.unparse(node.func) for node in nodes if isinstance(node, ast.Call)} - FRAGMENT_CALLS or
            {node.id for node in nodes if isinstance(node, ast.Name)} - FRAGMENT_NAMES or
            not all(isinstance(node, (ast.Assign, ast.Expr, ast.If)) for node in nodes if isinstance(node, ast.stmt))):
        raise AssertionError("A guarded mask admission statement gained a native operation")
    return found[0]


def metadata(mode, uid, gid):
    return SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=uid, st_gid=gid)


class KeeperSearchTests(unittest.TestCase):
    def test_unsearchable_ancestors_are_refused(self):
        for mode, owner, group in (
            (0o750, 1001, 1001),  # A runner home created with HOME_MODE 0750.
            (0o750, 1001, 118),
            (0o710, 1001, 1001),  # A group-only grant to a gid the keeper does not hold.
            (0o770, 0, 0),
            (0o700, 0, 0),
            (0o766, 0, 0),  # Other may read but not search.
            (0o701, 1001, 1002),  # The group class is selected and has no search bit; other's bit never applies.
            (0o071, 1002, 1001),  # The owner class is selected; the gid is unmapped, so no capability override.
        ):
            with self.subTest(mode=oct(mode), owner=owner, group=group):
                self.assertIs(NATIVE["keeper_searchable"](stat.S_IFDIR | mode, owner, group, *KEEPER), False)

    def test_searchable_ancestors_are_admitted(self):
        for mode, owner, group in (
            (0o755, 0, 0),
            (stat.S_ISVTX | 0o777, 0, 0),  # /tmp
            (0o700, 1002, 1002),
            (0o000, 1002, 1002),  # Both ids are mapped, so the namespace capability override applies.
            (0o711, 1001, 1001),  # Search through other only.
            (0o750, 1001, 1002),  # A group grant to the keeper gid.
            (0o100, 1002, 1001),  # Owner bits with a foreign gid.
        ):
            with self.subTest(mode=oct(mode), owner=owner, group=group):
                self.assertIs(NATIVE["keeper_searchable"](stat.S_IFDIR | mode, owner, group, *KEEPER), True)

    def test_inputs_are_strict_non_negative_integers_and_the_keeper_is_never_root(self):
        valid = (stat.S_IFDIR | 0o755, 0, 0, *KEEPER)
        self.assertIs(NATIVE["keeper_searchable"](*valid), True)
        for index in range(len(valid)):
            for value in (None, True, False, "755", -1, 1.0):
                with self.subTest(index=index, value=value), self.assertRaises(RuntimeError):
                    NATIVE["keeper_searchable"](*valid[:index], value, *valid[index + 1:])
        # mode is bounded as an st_mode value, and owner and group by integer()'s upper bound; each bound is inclusive.
        for index, value in ((0, 0o200000), (1, 9007199254740992), (2, 9007199254740992)):
            with self.subTest(index=index, value=value), self.assertRaises(RuntimeError):
                NATIVE["keeper_searchable"](*valid[:index], value, *valid[index + 1:])
        self.assertIs(NATIVE["keeper_searchable"](0o177777, 9007199254740991, 9007199254740991, *KEEPER), True)
        for uid, gid in ((0, 1002), (1002, 0), (0, 0), (9007199254740992, 1002), (1002, 9007199254740992)):
            with self.subTest(uid=uid, gid=gid), self.assertRaises(RuntimeError):
                NATIVE["keeper_searchable"](stat.S_IFDIR | 0o700, 0, 0, uid, gid)


class SourceStructureTests(unittest.TestCase):
    def test_keeper_search_runs_after_every_mask_predicate_and_before_construction(self):
        def statements(source):
            return [ast.dump(node) for node in ast.parse(source).body]

        sources = FUNCTIONS["supported_mask_sources"]
        self.assertEqual([ast.dump(node) for node in sources.body[-3:]], statements(
            "validate_source_view(os.getpid(), identity(os.getpid(), 0)['start'], result, pins['sources'])\n"
            "for label, item in searches:\n"
            "    _DIAGNOSTIC_STAGE = f'prepare-mask-{label}-keeper-search'\n"
            "    require(keeper_searchable(item.st_mode, item.st_uid, item.st_gid, uid, gid))\n"
            "return result\n"))
        loop = next(index for index, node in enumerate(sources.body) if isinstance(node, ast.For) and
                    ast.unparse(node.iter) == "MASKS")
        self.assertEqual([ast.dump(node) for node in sources.body[loop - 2:loop]],
                         statements("records = []\nsearches = []\n"))
        parents = [node for node in sources.body[loop].body if isinstance(node, ast.For) and
                   ast.unparse(node.iter) == "pathlib.Path(target).parents"]
        self.assertEqual(len(parents), 1)
        self.assertEqual(ast.dump(parents[0].body[-1]), statements("searches.append((label, item))")[0])
        self.assertEqual([node.value.values[-1].value for node in parents[0].body if isinstance(node, ast.Assign)
                          and ast.unparse(node.targets[0]) == "_DIAGNOSTIC_STAGE"],
                         ["-parent-stat", "-parent-type", "-parent-owner", "-parent-mode", "-parent-canonical"])
        self.assertEqual(sum(isinstance(node, ast.Name) and node.id == "searches" for node in ast.walk(sources)), 3)
        prepare = FUNCTIONS["prepare_in_capture"]
        masks = next(index for index, node in enumerate(prepare.body) if
                     ast.dump(node) == statements("masks = supported_mask_sources(uid, gid, namespace, pins)")[0])
        self.assertEqual(ast.dump(prepare.body[masks + 1]), statements("_DIAGNOSTIC_STAGE = 'prepare-images'")[0])
        self.assertIn("runtime_images", {ast.unparse(node.func) for node in ast.walk(prepare.body[masks + 2])
                                         if isinstance(node, ast.Call)})
        self.assertEqual([ast.dump(node) for node in prepare.body[masks + 3:masks + 6]], statements(
            "_DIAGNOSTIC_STAGE = 'prepare-keeper-search-checkout'\n"
            "require(all(keeper_searchable(item.st_mode, item.st_uid, item.st_gid, uid, gid)\n"
            "            for item in (os.lstat(parent) for parent in pathlib.Path(stage).parents)))\n"
            "_DIAGNOSTIC_STAGE = 'prepare-record'\n"))
        search = calls("prepare_in_capture", "keeper_searchable")
        self.assertEqual(len(search), 1)
        for construction in ("write_json", "os.mkdir", "os.chown", "subprocess.Popen"):
            self.assertLess(search[0].lineno, min(call.lineno for call in calls("prepare_in_capture", construction)))
        self.assertLess(calls("prepare_in_capture", "supported_mask_sources")[0].lineno, search[0].lineno)
        self.assertEqual([name for name in FUNCTIONS if calls(name, "keeper_searchable")],
                         ["supported_mask_sources", "prepare_in_capture"])
        self.assertEqual(len(calls("supported_mask_sources", "keeper_searchable")), 1)

    def test_mask_admission_stages_are_one_closed_fixed_product(self):
        assignments = stage_assignments("supported_mask_sources")
        literals = [node.value.value for node in assignments if isinstance(node.value, ast.Constant)]
        formatted = [node for node in assignments if isinstance(node.value, ast.JoinedStr)]
        self.assertEqual(len(literals) + len(formatted), len(assignments))
        self.assertEqual(tuple(literals), MASK_LITERALS)
        steps = []
        for node in formatted:
            head, label, tail = node.value.values
            self.assertTrue(isinstance(head, ast.Constant) and head.value == "prepare-mask-")
            self.assertTrue(isinstance(label, ast.FormattedValue) and label.conversion == -1 and
                            label.format_spec is None and ast.unparse(label.value) == "label")
            self.assertTrue(isinstance(tail, ast.Constant) and tail.value.startswith("-"))
            steps.append(tail.value[1:])
        self.assertEqual(len(steps), 14)
        self.assertEqual(set(steps), set(MASK_STEPS))
        self.assertEqual(len(set(steps)), 13)
        parent = {child: node for node in ast.walk(FUNCTIONS["supported_mask_sources"])
                  for child in ast.iter_child_nodes(node)}
        modes = [node for node in formatted if node.value.values[-1].value == "-target-mode"]
        self.assertEqual([ast.unparse(parent[node].test) for node in modes],
                         ["target == '/home/vector-agent'", "target == RUNNER_HOME"])
        self.assertTrue(all(node in parent[node].body for node in modes))
        labels = next(node.value for node in ast.walk(FUNCTIONS["supported_mask_sources"]) if
                      isinstance(node, ast.Assign) and ast.unparse(node.targets[0]) == "labels")
        self.assertEqual([ast.unparse(key) for key in labels.keys],
                         ["'/home/vector-agent'", "'/tmp'", "'/var/tmp'", "'/run'", "RUNNER_HOME"])
        self.assertEqual(tuple(NATIVE["RUNNER_HOME"] if isinstance(key, ast.Name) else key.value for key in labels.keys),
                         MASKS)
        names = [ast.literal_eval(value) for value in labels.values]
        self.assertEqual(names, ["home", "tmp", "var-tmp", "run", "runner-home"])
        product = {*MASK_LITERALS, *(f"prepare-mask-{name}-{step}" for name in names for step in MASK_STEPS
                                     if step != "target-mode" or name in ("home", "runner-home"))}
        self.assertEqual(len(product), 73)
        self.assertEqual([node.value.value for node in stage_assignments("prepare_in_capture")], [
            "prepare-input", "prepare-masks", "prepare-images", "prepare-keeper-search-checkout", "prepare-record",
            "prepare-keeper-start", "prepare-keeper-wait", "prepare-keeper-identity", "prepare-namespaces",
            "prepare-mounts", "prepare-mask-proof", "prepare-endpoint", "prepare-broker-start", "prepare-broker-ready",
            "prepare-broker-adopt", "prepare-broker-mask-proof", "prepare-publish",
        ])

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
        # Beyond PURE, only these fixed guarded statements of supported_mask_sources are ever compiled.
        self.assertEqual(tuple(FRAGMENTS), ("runner-identity", "target-owner", "parent-owner", "parent-mode"))
        for step in FRAGMENTS:
            statements = fragment(step)
            nodes = [node for statement in statements for node in ast.walk(statement)]
            called = {ast.unparse(node.func) for node in nodes if isinstance(node, ast.Call)}
            with self.subTest(step=step):
                self.assertEqual(len(statements), 2)
                self.assertEqual(called, FRAGMENT_CALLS if step == "runner-identity" else {"require"})
                self.assertFalse(called & forbidden)
                self.assertLessEqual({node.id for node in nodes if isinstance(node, ast.Name)}, FRAGMENT_NAMES)
                self.assertIs(type(statements[1]), ast.If if step == "target-owner" else ast.Expr)

    def test_destination_classifier_returns_only_fixed_labels_from_the_closed_vocabulary(self):
        stage = FUNCTIONS["keeper_destination_stage"]
        self.assertEqual([argument.arg for argument in stage.args.args], ["data"])
        self.assertEqual({ast.dump(node.value) for node in ast.walk(stage) if isinstance(node, ast.Return)},
                         {ast.dump(ast.parse(expression, mode="eval").body) for expression in (
                             "'bwrap-destination'",
                             "'bwrap-destination-' + kind + ('' if cause is None else '-' + cause)",
                         )})
        assigned = {node.targets[0].id: node.value for node in ast.walk(stage) if isinstance(node, ast.Assign) and
                    len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)}
        self.assertEqual(ast.literal_eval(assigned["prefixes"]), DESTINATION_PREFIXES)
        self.assertEqual(ast.literal_eval(assigned["targets"]), DESTINATIONS)
        self.assertEqual(ast.literal_eval(assigned["causes"]), {text: cause for cause, _, text in CAUSES})
        self.assertEqual(tuple(dict.fromkeys(kind for kind, _ in DESTINATIONS)), DESTINATION_KINDS)
        builder = FUNCTIONS["keeper_failure_stage"]
        accepted = [node for node in ast.walk(builder) if isinstance(node, ast.Compare) and
                    isinstance(node.left, ast.Name) and node.left.id == "log"]
        self.assertEqual(len(accepted), 1)
        self.assertEqual([type(operator) for operator in accepted[0].ops], [ast.In])
        logs = ast.literal_eval(accepted[0].comparators[0])
        self.assertEqual(len(logs), len(set(logs)))
        self.assertEqual(set(logs), set(KEEPER_LOGS))
        self.assertEqual({log for log in logs if log.startswith("bwrap-destination")},
                         {"bwrap-destination", *("bwrap-destination-" + kind for kind in DESTINATION_KINDS),
                          *("bwrap-destination-" + kind + "-" + cause
                            for kind in DESTINATION_KINDS for cause, _, _ in CAUSES)})

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
                     "keeper_info_progress", "keeper_failure_stage", "keeper_destination_stage", "keeper_searchable"}
        for function in ("cleanup", "read_state", "mask_records"):
            for name in forbidden:
                self.assertFalse(calls(function, name), (function, name))
        cleanup = FUNCTIONS["cleanup"]
        uid_stop = next(node.lineno for node in ast.walk(cleanup) if isinstance(node, ast.Constant) and
                        node.value == "cleanup-uid-stop")
        broker_stop = next(node.lineno for node in ast.walk(cleanup) if isinstance(node, ast.Constant) and
                           node.value == "cleanup-broker-stop")
        self.assertLess(uid_stop, broker_stop)


class RunnerHomeMaskTests(unittest.TestCase):
    def admission(self, step, label, refused, **names):
        scope = {"require": NATIVE["require"], "integer": NATIVE["integer"], "RUNNER_HOME": NATIVE["RUNNER_HOME"],
                 "label": label, "uid": KEEPER[0], "gid": KEEPER[1], "runner": RUNNER, **names}
        code = compile(ast.Module(body=fragment(step), type_ignores=[]), str(ENTRY), "exec", dont_inherit=True)
        if refused is None:
            exec(code, scope)
            return scope["_DIAGNOSTIC_STAGE"]
        with self.assertRaises(RuntimeError):
            exec(code, scope)
        self.assertEqual(scope["_DIAGNOSTIC_STAGE"], refused)
        return refused

    def test_runner_home_replaces_the_hosted_temporary_mask_and_still_hides_it(self):
        hidden = NATIVE["hidden"]
        self.assertEqual(MASKS, ("/home/vector-agent", "/tmp", "/var/tmp", "/run", "/home/runner"))
        self.assertEqual(NATIVE["RUNNER_HOME"], "/home/runner")
        self.assertNotIn("HOST_TEMP", {target.id for node in TREE.body if isinstance(node, ast.Assign)
                                       for target in node.targets if isinstance(target, ast.Name)})
        # Every former mask root stays hidden, so coverage only grows.
        for path in ("/home/vector-agent", "/tmp", "/var/tmp", "/run", "/home/runner/work/_temp",
                     "/home/runner/work/_temp/_github_workflow/event.json", "/home/runner/work",
                     "/home/runner/.bun/bin/bun"):
            with self.subTest(path=path):
                self.assertTrue(hidden(path))
        for path in ("/", "/home", "/home/runnerx", "/home/vector-agentx", "/home/vector-agent-sandbox"):
            with self.subTest(path=path):
                self.assertFalse(hidden(path))
        self.assertEqual(tuple(target.decode("ascii") for _, target in DESTINATIONS[1:6]), MASKS)

    def test_spec_paths_and_copied_runtime_trees_stay_outside_every_mask(self):
        hidden = NATIVE["hidden"]
        for container in NATIVE["CONTAINERS"]:
            for path in (container, container + "/checkout", container + "/tool-scratch", container + "/tool-namespaces",
                         container + "/tool-namespaces/broker.sock"):
                with self.subTest(path=path):
                    self.assertFalse(hidden(path))
        for path in ("/usr/libexec/vector-sandbox/v1", "/usr/libexec/vector-sandbox/v1/entry.py",
                     "/usr/libexec/vector-native-shell", "/usr/libexec/vector-native-shell/runtime/node",
                     "/usr/libexec/vector-native-shell-control", "/usr/libexec/vector-native-shell-control/runtime/bun",
                     "/usr/bin/python3", "/usr/bin/bwrap"):
            with self.subTest(path=path):
                self.assertFalse(hidden(path))
        validate = FUNCTIONS["validate_spec"]
        derived = next(index for index, node in enumerate(validate.body) if isinstance(node, ast.Expr) and
                       "/broker.sock" in ast.unparse(node))
        self.assertEqual(ast.dump(validate.body[derived + 1]), ast.dump(ast.parse(
            "require(not any(hidden(value[key]) for key in ('container', 'stage', 'scratch', 'directory', 'socket')))"
        ).body[0]))

    def test_runner_home_target_is_admitted_only_when_runner_owned_without_shared_write(self):
        home = NATIVE["RUNNER_HOME"]
        for mode, owner, group in ((0o750, 1001, 118), (0o755, 1001, 1001), (0o700, 1001, 1001)):
            with self.subTest(mode=oct(mode), owner=owner, group=group):
                self.assertEqual(self.admission("target-owner", "runner-home", None, target=home,
                                                info=metadata(mode, owner, group)),
                                 "prepare-mask-runner-home-target-mode")
        for mode, owner, group, step in ((0o750, 0, 0, "target-owner"), (0o750, 1002, 1002, "target-owner"),
                                         (0o750, 118, 118, "target-owner"), (0o770, 1001, 1001, "target-mode"),
                                         (0o757, 1001, 1001, "target-mode"),
                                         (stat.S_ISVTX | 0o777, 1001, 1001, "target-mode")):
            with self.subTest(mode=oct(mode), owner=owner, group=group):
                self.admission("target-owner", "runner-home", "prepare-mask-runner-home-" + step, target=home,
                               info=metadata(mode, owner, group))
        # The other two branches are unchanged.
        self.assertEqual(self.admission("target-owner", "home", None, target="/home/vector-agent",
                                        info=metadata(0o700, *KEEPER)), "prepare-mask-home-target-mode")
        self.admission("target-owner", "home", "prepare-mask-home-target-owner", target="/home/vector-agent",
                       info=metadata(0o700, 1001, 1001))
        self.admission("target-owner", "home", "prepare-mask-home-target-mode", target="/home/vector-agent",
                       info=metadata(0o770, *KEEPER))
        self.assertEqual(self.admission("target-owner", "tmp", None, target="/tmp",
                                        info=metadata(stat.S_ISVTX | 0o777, 0, 0)), "prepare-mask-tmp-target-owner")
        self.admission("target-owner", "tmp", "prepare-mask-tmp-target-owner", target="/tmp",
                       info=metadata(0o755, 1001, 1001))
        # The literal runner home is bound to the runner account it hides.
        self.assertEqual(self.admission("runner-identity", "runner-home", None), "prepare-mask-runner-identity")
        for runner in (SimpleNamespace(pw_uid=1001, pw_dir="/home/runner/"),
                       SimpleNamespace(pw_uid=1001, pw_dir="/home/runnerx"),
                       SimpleNamespace(pw_uid=1001, pw_dir="/root"),
                       SimpleNamespace(pw_uid=KEEPER[0], pw_dir="/home/runner"),
                       SimpleNamespace(pw_uid=0, pw_dir="/home/runner")):
            with self.subTest(runner=runner):
                self.admission("runner-identity", "runner-home", "prepare-mask-runner-identity", runner=runner)

    def test_every_mask_parent_must_be_root_owned_without_shared_write(self):
        for label in ("home", "runner-home"):
            for owner, group in ((0, 0), (0, 118)):
                with self.subTest(label=label, owner=owner, group=group):
                    self.admission("parent-owner", label, None, item=metadata(0o755, owner, group))
            # A runner-owned parent was admitted before the runner home became the mask.
            for owner, group in ((1001, 1001), KEEPER):
                with self.subTest(label=label, owner=owner, group=group):
                    self.admission("parent-owner", label, f"prepare-mask-{label}-parent-owner",
                                   item=metadata(0o755, owner, group))
            self.admission("parent-mode", label, None, item=metadata(0o755, 0, 0))
            for mode in (0o775, 0o757, stat.S_ISVTX | 0o777):
                with self.subTest(label=label, mode=oct(mode)):
                    self.admission("parent-mode", label, f"prepare-mask-{label}-parent-mode",
                                   item=metadata(mode, 0, 0))

    def test_nested_mount_beneath_runner_home_is_a_captured_origin(self):
        rows = (line(), line(2, 1, "0:99", target="/run/private", kind="tmpfs"),
                line(3, 1, "0:100", target="/home/runner/work", kind="tmpfs"))
        topology = mounts(*rows)
        value = records()
        value["topology"] = NATIVE["json_digest"](topology)
        value["origins"] = [source("/home/runner/work", 3, "0:100", inode=701), source("/run/private")]
        seal(value)
        NATIVE["mask_records"](value)
        NATIVE["require_capture_closure"](value, topology)
        NATIVE["refuse_mask_aliases"](value, topology)
        for origins in ([source("/run/private")], [source("/home/runner/work", 4, "0:100", inode=701),
                                                   source("/run/private")]):
            changed = copy.deepcopy(value)
            changed["origins"] = origins
            with self.subTest(origins=origins), self.assertRaises(RuntimeError):
                NATIVE["require_capture_closure"](seal(changed), topology)
        with self.assertRaises(RuntimeError):
            NATIVE["refuse_mask_aliases"](value, mounts(*rows, line(4, 1, "0:100", "/", "/mnt/copy", kind="tmpfs")))
        NATIVE["refuse_mask_aliases"](value, mounts(*rows, line(4, 1, "0:100", "/", "/home/runner/copy", kind="tmpfs")))
        with self.assertRaises(RuntimeError):
            NATIVE["require_known_mask_origins"](
                value, mounts(*rows, line(4, 3, "0:101", target="/home/runner/work/_temp", kind="tmpfs")), set())


if __name__ == "__main__":
    if os.environ.get("CI") != "true":
        raise SystemExit("Native mask-origin fixture is restricted to the approved CI job")
    unittest.main()
