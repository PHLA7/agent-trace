"""Make the plugin's stdlib-only modules importable as top-level modules in tests.

``recorder.py`` and ``store.py`` use no relative imports, so they can be loaded directly. The
plugin root itself is not importable as a package because its name contains a hyphen, which is why
Hermes loads it through its own loader.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))