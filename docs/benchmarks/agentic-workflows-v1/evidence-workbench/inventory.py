import json
from pathlib import Path

INVENTORY = json.loads(Path(__file__).with_name("inventory.json").read_text(encoding="utf-8"))
API_CHECKS = INVENTORY["api"]
BROWSER_CHECKS = INVENTORY["browser"]
CHECKS = API_CHECKS + BROWSER_CHECKS


def blank_checks():
    return [{"name": name, "status": "not_run"} for name in CHECKS]
