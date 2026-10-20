"""Admission rule 8 guard: the desktop half must stay inside the plugin SDK surface.

A ``desktop/plugin.js`` runs in the Desktop renderer with the app's full authority, so what protects
users is the SDK boundary plus review. This script enforces the mechanical half of that boundary —
the parts a linter can decide — so a violation fails here rather than at catalog admission:

- only ``@hermes/plugin-sdk``, ``react`` and ``react/jsx-runtime`` resolve as imports
- no ``eval`` / ``new Function`` / dynamic ``import()``
- no reaching into the app's own markup (``document.querySelector`` on ``data-*`` hooks, and no
  ``document.body`` MutationObserver)
- no hardcoded colours: panes already sit on the app background, so colours come from theme vars
- the file is written with ``jsx()`` calls, because it is loaded uncompiled

It cannot decide everything a reviewer can. It is a review aid, not a guarantee.

Run: python tests/check_desktop_surface.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "desktop" / "plugin.js"

ALLOWED_IMPORTS = ("@hermes/plugin-sdk", "react", "react/jsx-runtime")

# Surface areas the spec requires the plugin to contribute. Accept the exported constant or the
# literal area string, since the SDK exposes both spellings for `panes`.
REQUIRED_SURFACES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("panes", ("PANES_AREA", "'panes'", '"panes"')),
    ("routes", ("ROUTES_AREA",)),
    ("sidebar nav", ("SIDEBAR_NAV_AREA",)),
    ("palette", ("PALETTE_AREA",)),
    ("keybinds", ("KEYBINDS_AREA",)),
    ("settings page", ("registerSettingsPage",)),
)

_IMPORT_RE = re.compile(r"""^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']""", re.M)
_DYNAMIC_IMPORT_RE = re.compile(r"\bimport\s*\(")
_EVAL_RE = re.compile(r"\beval\s*\(|\bnew\s+Function\s*\(")
_DOM_CORE_RE = re.compile(r"""document\s*\.\s*querySelector(?:All)?\s*\(\s*["'][^"']*"""
                          r"""(?:data-slot|data-tour|data-sidebar|data-testid)""")
_BODY_MUTATION_RE = re.compile(r"""new\s+MutationObserver[\s\S]{0,200}?document\s*\.\s*body""")
_HEX_COLOR_RE = re.compile(r"""["'`]#[0-9a-fA-F]{3,8}["'`]""")
_RGB_RE = re.compile(r"\b(?:rgba?|hsla?)\s*\(")

_STRING_RE = re.compile(r"""("[^"\n]*"|'[^'\n]*'|`[^`]*`)""", re.S)
_LINE_COMMENT_RE = re.compile(r"//[^\n]*")
_BLOCK_COMMENT_RE = re.compile(r"/\*[\s\S]*?\*/")


def strip_noise(source: str) -> str:
    """Drop comments and string literals so colour/attribute checks do not match prose."""
    source = _BLOCK_COMMENT_RE.sub(" ", source)
    source = _LINE_COMMENT_RE.sub(" ", source)
    return _STRING_RE.sub('""', source)


def _sdk_export_names() -> set[str] | None:
    """Named exports of the Desktop plugin SDK, read from a Hermes checkout when one is present.

    Returns ``None`` when no checkout can be found, so the caller skips the check rather than
    guessing at the SDK surface. Point ``HERMES_AGENT_REPO`` at a checkout to check a specific one.
    """
    import os

    candidates = [Path(os.environ.get("HERMES_AGENT_REPO") or "/nonexistent"),
                  Path.home() / ".hermes" / "hermes-agent"]
    for root in candidates:
        sdk = root / "apps" / "desktop" / "src" / "sdk"
        if not sdk.is_dir():
            continue
        names: set[str] = set()
        for path in sdk.rglob("*.ts"):
            text = path.read_text(encoding="utf-8", errors="replace")
            for match in re.finditer(r"export\s*\{([^}]*)\}", text):
                for part in match.group(1).split(","):
                    part = part.strip()
                    if not part:
                        continue
                    if part.startswith("type "):
                        part = part[5:].strip()
                    if " as " in part:
                        part = part.split(" as ")[-1].strip()
                    names.add(part)
            for match in re.finditer(
                    r"export\s+(?:const|function|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)",
                    text):
                names.add(match.group(1))
        return names
    return None


def _missing_sdk_exports(specifiers: list[str], source: str) -> list[str]:
    """SDK symbols the plugin imports that the SDK does not export.

    An ESM module importing a non-existent named export throws at load, taking the whole plugin with
    it, so this is worth checking rather than discovering from a toast.
    """
    if "@hermes/plugin-sdk" not in specifiers:
        return []
    names = _sdk_export_names()
    if names is None:
        print("note: no Hermes checkout found; skipping the SDK export check")
        return []
    used: list[str] = []
    for block in re.findall(r"import\s*\{([^}]*)\}\s*from\s*'@hermes/plugin-sdk'", source):
        for part in block.split(","):
            part = part.strip()
            if part:
                used.append(part.split(" as ")[0].strip())
    return sorted(name for name in used if name not in names)


def main() -> int:
    if not PLUGIN.is_file():
        print(f"FAIL: {PLUGIN} does not exist")
        return 1

    source = PLUGIN.read_text(encoding="utf-8")
    code = strip_noise(source)
    failures: list[str] = []

    specifiers = _IMPORT_RE.findall(source)
    bad = [s for s in specifiers if s not in ALLOWED_IMPORTS]
    if bad:
        failures.append(f"imports outside the SDK allowlist: {bad}")

    if _DYNAMIC_IMPORT_RE.search(code):
        failures.append("dynamic import() present; only static SDK imports are permitted")
    if _EVAL_RE.search(code):
        failures.append("eval() or new Function() present")
    if _DOM_CORE_RE.search(source):
        failures.append("queries the app's own markup by data-* hook")
    if _BODY_MUTATION_RE.search(code):
        failures.append("observes document.body with a MutationObserver")
    if _HEX_COLOR_RE.search(code):
        failures.append("hardcoded hex colour; use a theme variable")
    if _RGB_RE.search(code):
        failures.append("hardcoded rgb()/hsl() colour; use a theme variable")

    if "react/jsx-runtime" not in specifiers:
        failures.append("does not import jsx/jsxs from react/jsx-runtime")
    if "jsx(" not in source and "jsxs(" not in source:
        failures.append("no jsx()/jsxs() calls: the file is loaded uncompiled, so JSX syntax cannot parse")

    missing = [label for label, tokens in REQUIRED_SURFACES
               if not any(token in source for token in tokens)]
    if missing:
        failures.append(f"does not register the required surfaces: {missing}")

    # `react` is an allowed import, so React hooks are legitimate; only CommonJS `require` is not
    # available in this environment.
    if "require(" in source:
        failures.append("contains require(), which is not available in this environment")

    # Every named import from the SDK must exist, or the module throws at load time.
    sdk_missing = _missing_sdk_exports(specifiers, source)
    if sdk_missing:
        failures.append(f"imports SDK symbols the SDK does not export: {sdk_missing}")

    print(f"desktop/plugin.js — {len(source.splitlines())} lines, "
          f"{len(specifiers)} import specifier(s)")
    for spec in specifiers:
        print(f"  import {spec}")

    if failures:
        print("\nFAIL:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("\nOK: desktop half is inside the plugin SDK surface on every check that can be automated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())