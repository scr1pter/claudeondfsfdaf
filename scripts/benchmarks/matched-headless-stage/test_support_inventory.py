"""Local mutable-support inventory controls; no provider, browser, or runtime."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import paired_runner as runner


class OwnedSupportInventoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="support-inventory-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "support"
        self.root.mkdir()

    def symlink(self, link, target, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError) as error:
            self.skipTest("Symbolic link creation is unavailable: " + type(error).__name__)

    def inventory(self, root=None, **limits):
        result = runner.owned_support_inventory(self.root if root is None else root, **limits)
        self.assertIs(result["contentRead"], False)
        self.assertIs(result["linksFollowedForTraversal"], False)
        self.assertIsInstance(result["observations"], list)
        self.assertIsInstance(result["limits"], dict)
        return result

    def assert_review(self, result, *, complete=None):
        self.assertIs(result["requiresManualReview"], True)
        if complete is not None:
            self.assertIs(result["complete"], complete)

    def test_ordinary_files_and_directories_are_counted_without_opening_content(self):
        (self.root / "one.bin").write_bytes(b"synthetic local fixture")
        nested = self.root / "nested"
        nested.mkdir()
        (nested / "two.bin").write_bytes(b"synthetic local fixture")
        with patch.object(Path, "open", side_effect=AssertionError("inventory opened file content")), \
             patch.object(Path, "read_bytes", side_effect=AssertionError("inventory read file content")):
            result = self.inventory()
        self.assertEqual(result["regularFiles"], 2)
        self.assertEqual(result["directories"], 1)
        self.assertEqual(result["entriesVisited"], 3)
        self.assertEqual(result["reparseEntries"], 0)
        self.assertEqual(result["unexpectedEntries"], 0)
        self.assertIs(result["complete"], True)
        self.assertIs(result["requiresManualReview"], False)

    def test_empty_owned_directory_is_a_complete_inventory(self):
        result = self.inventory()
        self.assertEqual(result["regularFiles"], 0)
        self.assertEqual(result["directories"], 0)
        self.assertEqual(result["entriesVisited"], 0)
        self.assertIs(result["complete"], True)
        self.assertIs(result["requiresManualReview"], False)

    def test_internal_file_link_is_metadata_without_duplicate_file_count(self):
        target = self.root / "target.bin"
        target.write_bytes(b"synthetic local fixture")
        self.symlink(self.root / "alias.bin", target)
        result = self.inventory()
        self.assertEqual(result["regularFiles"], 1)
        self.assertEqual(result["reparseEntries"], 1)
        self.assertEqual(result["withinOwnedRootTargets"], 1)
        self.assertEqual(result["outsideOwnedRootTargets"], 0)
        self.assertEqual(result["unresolvedTargets"], 0)
        self.assertIs(result["complete"], True)
        self.assertIs(result["requiresManualReview"], False)

    def test_internal_directory_link_is_not_descended_or_double_counted(self):
        target = self.root / "target"
        target.mkdir()
        (target / "one.bin").write_bytes(b"synthetic local fixture")
        alias = self.root / "alias"
        self.symlink(alias, target, directory=True)
        original_scandir = os.scandir

        def scandir(path):
            self.assertNotEqual(Path(path), alias, "inventory descended a directory symlink")
            return original_scandir(path)

        with patch("os.scandir", side_effect=scandir):
            result = self.inventory()
        self.assertEqual(result["regularFiles"], 1)
        self.assertEqual(result["directories"], 1)
        self.assertEqual(result["reparseEntries"], 1)
        self.assertEqual(result["withinOwnedRootTargets"], 1)
        self.assertEqual(result["entriesVisited"], 3)
        self.assertIs(result["requiresManualReview"], False)

    def test_external_directory_link_requires_review_without_scanning_target(self):
        target = self.base / "external"
        target.mkdir()
        (target / "unread.bin").write_bytes(b"synthetic outside-support fixture")
        alias = self.root / "alias"
        self.symlink(alias, target, directory=True)
        original_scandir = os.scandir

        def scandir(path):
            self.assertEqual(Path(path), self.root, "inventory scanned outside support or through its alias")
            return original_scandir(path)

        with patch("os.scandir", side_effect=scandir), \
             patch.object(Path, "open", side_effect=AssertionError("inventory opened target content")):
            result = self.inventory()
        self.assertEqual(result["regularFiles"], 0)
        self.assertEqual(result["directories"], 0)
        self.assertEqual(result["reparseEntries"], 1)
        self.assertEqual(result["outsideOwnedRootTargets"], 1)
        self.assert_review(result)

    def test_external_file_link_requires_review_without_reading_file(self):
        target = self.base / "external.bin"
        target.write_bytes(b"synthetic outside-support fixture")
        self.symlink(self.root / "alias.bin", target)
        with patch.object(Path, "open", side_effect=AssertionError("inventory opened target content")):
            result = self.inventory()
        self.assertEqual(result["regularFiles"], 0)
        self.assertEqual(result["outsideOwnedRootTargets"], 1)
        self.assert_review(result)

    def test_internal_link_chain_ending_outside_stays_review_required(self):
        outside = self.base / "outside.bin"
        outside.write_bytes(b"synthetic outside-support fixture")
        first = self.root / "first"
        second = self.root / "second"
        self.symlink(first, second)
        self.symlink(second, outside)
        result = self.inventory()
        self.assertEqual(result["reparseEntries"], 2)
        self.assertEqual(result["withinOwnedRootTargets"], 0)
        self.assertEqual(result["outsideOwnedRootTargets"], 2)
        self.assert_review(result)

    def test_parent_component_does_not_hide_an_intermediate_outside_link(self):
        outside = self.base / "outside"
        (outside / "nested").mkdir(parents=True)
        (outside / "owned.bin").write_bytes(b"synthetic outside-support fixture")
        (self.root / "owned.bin").write_bytes(b"synthetic local fixture")
        intermediate = self.root / "intermediate"
        self.symlink(intermediate, outside / "nested", directory=True)
        obscured = self.root / "obscured"
        self.symlink(obscured, Path("intermediate") / ".." / "owned.bin")
        # POSIX traverses the link before '..'; Windows may normalize '..' first. The inventory deliberately
        # leaves either platform's ambiguous compound target review-required instead of trusting that collapse.
        if os.name != "nt":
            self.assertEqual(obscured.resolve(), outside / "owned.bin")
        result = self.inventory()
        self.assertEqual(result["reparseEntries"], 2)
        self.assertEqual(result["withinOwnedRootTargets"], 0)
        self.assertEqual(result["outsideOwnedRootTargets"] + result["unresolvedTargets"], 2)
        self.assert_review(result)

    def test_relative_parent_target_inside_root_is_counted_without_traversal(self):
        (self.root / "target.bin").write_bytes(b"synthetic local fixture")
        nested = self.root / "nested"
        nested.mkdir()
        self.symlink(nested / "alias", Path("..") / "target.bin")
        result = self.inventory()
        self.assertEqual(result["regularFiles"], 1)
        self.assertEqual(result["reparseEntries"], 1)
        self.assertEqual(result["withinOwnedRootTargets"], 1)
        self.assertIs(result["requiresManualReview"], False)

    def test_dangling_link_is_unresolved_and_requires_review(self):
        self.symlink(self.root / "dangling", self.root / "missing")
        result = self.inventory()
        self.assertEqual(result["reparseEntries"], 1)
        self.assertEqual(result["unresolvedTargets"], 1)
        self.assert_review(result)

    def test_self_link_cycle_is_unresolved_without_traversal(self):
        link = self.root / "cycle"
        self.symlink(link, link, directory=True)
        result = self.inventory()
        self.assertEqual(result["entriesVisited"], 1)
        self.assertEqual(result["reparseEntries"], 1)
        self.assertEqual(result["unresolvedTargets"], 1)
        self.assert_review(result)

    def test_two_link_cycle_is_unresolved_without_traversal(self):
        first, second = self.root / "first", self.root / "second"
        self.symlink(first, second, directory=True)
        self.symlink(second, first, directory=True)
        result = self.inventory()
        self.assertEqual(result["entriesVisited"], 2)
        self.assertEqual(result["reparseEntries"], 2)
        self.assertEqual(result["unresolvedTargets"], 2)
        self.assert_review(result)

    def test_link_hop_limit_keeps_unresolved_targets_visible(self):
        target = self.root / "target.bin"
        target.write_bytes(b"synthetic local fixture")
        first, second = self.root / "first", self.root / "second"
        self.symlink(first, second)
        self.symlink(second, target)
        result = self.inventory(max_link_hops=1)
        self.assertEqual(result["reparseEntries"], 2)
        self.assertGreaterEqual(result["unresolvedTargets"], 1)
        self.assert_review(result)

    def test_depth_zero_lists_root_but_does_not_descend(self):
        (self.root / "one.bin").write_bytes(b"synthetic local fixture")
        child = self.root / "nested"
        child.mkdir()
        (child / "unvisited.bin").write_bytes(b"synthetic local fixture")
        result = self.inventory(max_depth=0)
        self.assertEqual(result["regularFiles"], 1)
        self.assertEqual(result["directories"], 1)
        self.assertEqual(result["entriesVisited"], 2)
        self.assert_review(result, complete=False)

    def test_entry_limit_returns_bounded_partial_inventory(self):
        for index in range(5):
            (self.root / str(index)).write_bytes(b"synthetic local fixture")
        result = self.inventory(max_entries=2)
        self.assertEqual(result["entriesVisited"], 2)
        self.assertEqual(result["regularFiles"], 2)
        self.assert_review(result, complete=False)

    def test_missing_root_returns_review_instead_of_throwing(self):
        result = self.inventory(self.base / "missing")
        self.assertEqual(result["entriesVisited"], 0)
        self.assert_review(result, complete=False)

    def test_non_directory_root_returns_review_instead_of_reading_file(self):
        path = self.base / "file.bin"
        path.write_bytes(b"synthetic local fixture")
        with patch.object(Path, "open", side_effect=AssertionError("inventory opened root file")):
            result = self.inventory(path)
        self.assertEqual(result["entriesVisited"], 0)
        self.assert_review(result, complete=False)

    def test_link_root_is_not_resolved_and_traversed(self):
        alias = self.base / "linked-root"
        self.symlink(alias, self.root, directory=True)
        (self.root / "unvisited.bin").write_bytes(b"synthetic local fixture")
        with patch("os.scandir", side_effect=AssertionError("inventory traversed a linked root")):
            result = self.inventory(alias)
        self.assertEqual(result["entriesVisited"], 0)
        self.assert_review(result, complete=False)

    def test_root_beneath_linked_parent_is_not_traversed(self):
        target_parent = self.base / "target-parent"
        target = target_parent / "support"
        target.mkdir(parents=True)
        (target / "unvisited.bin").write_bytes(b"synthetic local fixture")
        parent_alias = self.base / "parent-alias"
        self.symlink(parent_alias, target_parent, directory=True)
        with patch("os.scandir", side_effect=AssertionError("inventory traversed a linked root ancestor")):
            result = self.inventory(parent_alias / "support")
        self.assertEqual(result["entriesVisited"], 0)
        self.assert_review(result, complete=False)

    @unittest.skipUnless(os.name == "nt", "Windows path metadata forms require Windows")
    def test_windows_rooted_and_drive_relative_targets_never_inspect_outside_metadata(self):
        placeholder = self.root / "target.bin"
        placeholder.write_bytes(b"synthetic local fixture")
        self.symlink(self.root / "alias", placeholder)
        outside = self.base / "outside"
        other_drive = "Z:" if self.root.drive.upper() != "Z:" else "Y:"
        targets = [str(outside)[len(outside.drive):], other_drive + "outside"]
        original_lstat = Path.lstat
        for target in targets:
            with self.subTest(form="rooted" if target.startswith("\\") else "drive-relative"):
                inspecting_target = False

                def readlink(path):
                    nonlocal inspecting_target
                    inspecting_target = True
                    return target

                def lstat(path, *args, **kwargs):
                    if inspecting_target:
                        self.assertTrue(Path(path).is_relative_to(self.root), "inventory inspected outside target metadata")
                    return original_lstat(path, *args, **kwargs)

                with patch("paired_runner.os.readlink", side_effect=readlink), \
                     patch.object(Path, "lstat", lstat):
                    result = self.inventory()
                self.assertEqual(result["reparseEntries"], 1)
                self.assertEqual(result["withinOwnedRootTargets"], 0)
                self.assert_review(result)

    @unittest.skipUnless(os.name == "nt", "Windows device namespace metadata requires Windows")
    def test_windows_device_namespaces_are_not_reinterpreted_as_owned_relative_paths(self):
        placeholder = self.root / "target.bin"
        placeholder.write_bytes(b"synthetic local fixture")
        self.symlink(self.root / "alias", placeholder)
        for relative in [Path("GLOBALROOT") / "Device" / "fixture", Path("Volume{synthetic}") / "fixture"]:
            (self.root / relative).mkdir(parents=True)
            with self.subTest(namespace=relative.parts[0]):
                with patch("paired_runner.os.readlink", return_value="\\\\?\\" + str(relative)):
                    result = self.inventory()
                self.assertEqual(result["withinOwnedRootTargets"], 0)
                self.assertEqual(result["unresolvedTargets"] + result["outsideOwnedRootTargets"], 1)
                self.assert_review(result)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO fixtures are unavailable on this platform")
    def test_special_file_is_counted_as_unexpected_without_opening(self):
        os.mkfifo(self.root / "pipe")
        with patch.object(Path, "open", side_effect=AssertionError("inventory opened special file")):
            result = self.inventory()
        self.assertEqual(result["unexpectedEntries"], 1)
        self.assertEqual(result["regularFiles"], 0)
        self.assert_review(result)

    @unittest.skipUnless(os.name == "nt", "Windows junction fixture requires Windows")
    def test_windows_junction_is_counted_without_traversing_target(self):
        target = self.root / "target"
        target.mkdir()
        (target / "one.bin").write_bytes(b"synthetic local fixture")
        junction = self.root / "junction"
        process = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(target)],
                                 capture_output=True, text=True, check=False)
        if process.returncode != 0:
            self.skipTest("Windows junction creation is unavailable")
        self.addCleanup(lambda: os.rmdir(junction) if junction.is_junction() else None)
        original_scandir = os.scandir

        def scandir(path):
            self.assertNotEqual(Path(path), junction, "inventory descended a Windows junction")
            return original_scandir(path)

        with patch("os.scandir", side_effect=scandir):
            result = self.inventory()
        self.assertEqual(result["regularFiles"], 1)
        self.assertEqual(result["directories"], 1)
        self.assertEqual(result["reparseEntries"], 1)
        self.assertEqual(result["withinOwnedRootTargets"], 1)
        self.assertIs(result["requiresManualReview"], False)


if __name__ == "__main__":
    unittest.main()
