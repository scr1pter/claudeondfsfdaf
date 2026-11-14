"""Controls the actual Node module loader, without Bun, a browser or an app."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(shutil.which("node"), "Node is required for the loader-only control")
class LayoutLoaderControls(unittest.TestCase):
    def fixture(self, root, command="vite build"):
        app = root / "application with spaces"
        module = app / "node_modules/vite"
        module.mkdir(parents=True)
        (app / "package.json").write_text(json.dumps({"scripts": {"build": command}}), encoding="utf-8")
        (module / "package.json").write_text(json.dumps({"name": "vite", "type": "module", "main": "index.mjs"}), encoding="utf-8")
        (module / "index.mjs").write_text('export async function resolveConfig() { return {root: process.cwd(), build: {outDir: "dist", rollupOptions: {}}, publicDir: "public"} }', encoding="utf-8")
        return app

    def test_native_absolute_esm_path_with_spaces(self):
        # On Windows, importing a raw C: path fails with ERR_UNSUPPORTED_ESM_URL_SCHEME.
        # This executes the real probe against a local loader fixture; it is not
        # a real Vite build or evidence that an application passes acceptance.
        with tempfile.TemporaryDirectory() as directory:
            app = self.fixture(Path(directory))
            process = subprocess.run([shutil.which("node"), str(ROOT / "layout-probe.cjs"), str(app)], cwd=app, capture_output=True, text=True, timeout=15)
            self.assertEqual(process.returncode, 0, process.stderr)
            declaration = json.loads(process.stdout)
            self.assertEqual(Path(declaration["root"]), app)
            self.assertEqual(Path(declaration["output"]), app / "dist")
            self.assertEqual(declaration["inputs"], [str(app / "index.html")])

    def test_unknown_build_command_is_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.fixture(Path(directory), "vite build && echo mutation")
            process = subprocess.run([shutil.which("node"), str(ROOT / "layout-probe.cjs"), str(app)], cwd=app, capture_output=True, text=True, timeout=15)
            self.assertEqual(process.returncode, 2)
            self.assertIn("unrecognized build command", process.stderr)
            self.assertFalse(process.stdout)


if __name__ == "__main__":
    unittest.main()
