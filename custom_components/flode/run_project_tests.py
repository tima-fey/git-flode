"""Standalone unittest worker; never imported into the HA event loop."""
import sys
import unittest
from pathlib import Path


def main() -> int:
    """Discover project tests and fail explicitly when none are found."""
    root = Path(sys.argv[1])
    sys.path.insert(0, str(root))
    suite = unittest.defaultTestLoader.discover(str(root / "tests"))
    if not suite.countTestCases():
        print("No unittest tests found in tests/ (expected test_*.py)", flush=True)
        return 5
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
