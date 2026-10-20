"""Admission rule 6 guard: the manifest's declared hooks must equal what the recorder registers.

Undeclared capability creep fails catalog admission, and maintaining the list in two places by hand
is exactly how it drifts. This script is the single check that keeps `plugin.yaml` honest. It parses
the manifest without a YAML dependency, because CI installs only pytest.

Run: python tests/check_declared_hooks.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import recorder  # noqa: E402  (needs the path insert above)

_ENTRY = re.compile(r"^\s*-\s+(\S+)\s*$")
_KEY = re.compile(r"^(\S+):")


def declared_hooks(manifest: Path) -> list[str]:
    """Every value under ``provides_hooks:`` in the manifest, in order."""
    lines = manifest.read_text(encoding="utf-8").splitlines()
    hooks: list[str] = []
    collecting = False
    for line in lines:
        if not collecting:
            if line.strip() == "provides_hooks:":
                collecting = True
            continue
        if (match := _ENTRY.match(line)):
            hooks.append(match.group(1))
            continue
        if _KEY.match(line) or (line.strip() and not line.startswith((" ", "\t"))):
            break  # the next top-level key ends the list
    return hooks


def main() -> int:
    declared = declared_hooks(ROOT / "plugin.yaml")
    registered = list(recorder.hook_names())

    if not declared:
        print("FAIL: plugin.yaml declares no provides_hooks, or the block could not be parsed")
        return 1

    missing = [h for h in registered if h not in declared]
    extra = [h for h in declared if h not in registered]

    if missing or extra:
        print("FAIL: plugin.yaml provides_hooks does not match recorder.hook_names()")
        if missing:
            print(f"  registered but not declared (rule 6 violation): {missing}")
        if extra:
            print(f"  declared but never registered: {extra}")
        return 1

    print(f"OK: {len(declared)} declared hooks match exactly what the recorder registers")
    for hook in declared:
        print(f"  - {hook}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())