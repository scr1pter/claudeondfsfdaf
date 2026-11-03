"""Owned temporary transcript path controls; no native runtime or network."""
import os
from pathlib import Path
import tempfile
import unittest

from native_registry import owned_transcript_path
from native_team_policy import PolicyError


class TranscriptPathTests(unittest.TestCase):
    def test_normal_owned_file_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            path.write_text("synthetic-only\n", encoding="utf-8")
            self.assertEqual(owned_transcript_path(str(path), directory), path.resolve())

    @unittest.skipUnless(os.name == "nt", "Windows native extended DOS spelling")
    def test_extended_dos_spelling_is_the_same_owned_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            path.write_text("synthetic-only\n", encoding="utf-8")
            self.assertEqual(owned_transcript_path("\\\\?\\" + str(path.resolve()), directory), path.resolve())

    def test_device_globalroot_and_unc_paths_are_refused_before_resolution(self):
        for path in ("\\\\.\\PhysicalDrive0", "\\\\?\\GLOBALROOT\\Device\\synthetic", "\\\\?\\UNC\\synthetic\\share\\file", "\\??\\C:\\synthetic", "\\\\synthetic\\share\\file"):
            with self.subTest(path=path), self.assertRaises(PolicyError):
                owned_transcript_path(path, Path.cwd())

    def test_cross_home_file_is_refused_in_both_spellings(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "owned"
            home.mkdir()
            outside = Path(directory) / "outside.jsonl"
            outside.write_text("synthetic-only\n", encoding="utf-8")
            for value in (str(outside), "\\\\?\\" + str(outside.resolve())):
                with self.subTest(value=value), self.assertRaises(PolicyError):
                    owned_transcript_path(value, home)

    def test_missing_path_or_directory_is_not_a_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            for value in ("", None, str(Path(directory) / "missing.jsonl"), directory):
                with self.subTest(value=value), self.assertRaises(PolicyError):
                    owned_transcript_path(value, directory)


if __name__ == "__main__":
    unittest.main()
