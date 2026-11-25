#!/usr/bin/env python3
"""iris-bom entry point. Run: python3 scripts/iris_bom.py --help"""

import sys
from pathlib import Path

if sys.version_info < (3, 9):
    sys.exit("iris-bom needs Python 3.9 or newer")
sys.path.insert(0, str(Path(__file__).resolve().parent))

from irisbom.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
