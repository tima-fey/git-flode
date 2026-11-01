"""Shared fixtures for checking that file edits stay inside their target file."""
from pathlib import Path

import pytest


@pytest.fixture
def seed_isolation_project():
    def seed(root: Path) -> Path:
        files = {
            'automations/climate/heating.yaml': b'''# Heating file
- id: first
  alias: "Heating"
  actions: [{delay: '00:00:01'}]
- id: neighbor
  alias: "Same-file neighbor"
  actions: []
''',
            'automations/climate/ventilation.yaml': b"# Keep CRLF\r\n- id: first\r\n  alias: 'Ventilation'\r\n  actions: []\r\n",
            'automations/security/heating.yaml': b"# Same basename, different folder\n- id: first\n  alias: 'Alarm'\n  action: []\n",
            'automations/security/nested/other.yml': b'- id: first\n  alias: "Nested" # Keep comment\n  actions: []\n',
            'automations/unrelated-invalid.yaml': b'not: [valid YAML\n',
            'objects/device.yaml': b'# Reserved objects\r\nvalue: "unchanged"\r\n',
            'objects/opaque.bin': b'\x00\xff\x80binary fixture\x00',
            'tests/test_example.py': b'# Unrelated Python test\n',
            'README.md': 'Unrelated project documentation: café\n'.encode(),
        }
        for relative, content in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        return root
    return seed


@pytest.fixture
def snapshot_project_files():
    def snapshot(root: Path):
        result = {}
        for path in root.rglob('*'):
            relative = path.relative_to(root)
            if relative.parts[0] == '.git' or not path.is_file():
                continue
            content = path.read_bytes()
            info = path.stat()
            result[relative.as_posix()] = (content, info.st_mtime_ns, info.st_mode & 0o777)
        return result
    return snapshot
