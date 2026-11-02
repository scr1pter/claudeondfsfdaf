"""Pure controls only: no Bun, model, install, HTTP server or browser execution."""
import io
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "controls"))
import test_controls


def main():
    output = io.StringIO()
    suite = unittest.defaultTestLoader.loadTestsFromModule(test_controls)
    result = unittest.TextTestRunner(stream=output, verbosity=2).run(suite)
    print(json.dumps({"status": "passed" if result.wasSuccessful() else "failed", "draftOnly": True,
                      "controls": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                      "bunExecuted": False, "serversStarted": False, "browsersStarted": False, "modelCalls": 0,
                      "details": output.getvalue()}, indent=2))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
