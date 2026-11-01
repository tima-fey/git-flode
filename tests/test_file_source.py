"""File source and API boundary regressions; no real HA devices or files."""
import asyncio
import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from homeassistant.exceptions import Unauthorized

from custom_components.flode.file_api import (
    _directory,
    _respond,
    list_files,
)
from custom_components.flode.file_source import FileSource

VALID = """# Keep this comment unchanged.
- id: first
  alias: First
  mode: restart
  triggers: []
  actions:
    - delay: '00:00:01'
      future_key: '{{ states("sensor.test") }}'
- id: second
  alias: Second
  actions: []
"""


@pytest.fixture
def source(tmp_path):
    (tmp_path / "automations" / "climate").mkdir(parents=True)
    (tmp_path / "automations" / "climate" / "ventilation.yaml").write_text(VALID)
    return FileSource(str(tmp_path))


def test_lists_independent_entries_and_preserves_original_text(source):
    file = source.automations / "climate" / "ventilation.yaml"
    before = hashlib.sha256(file.read_bytes()).hexdigest()
    result = source.list()
    assert result["errors"] == []
    assert [item["id"] for item in result["items"]] == ["first", "second"]
    assert result["items"][0]["file"] == "automations/climate/ventilation.yaml"
    entry = source.read("automations/climate/ventilation.yaml", "first")
    assert entry["mode"] == "restart"
    assert entry["actions"][0]["future_key"] == '{{ states("sensor.test") }}'
    assert hashlib.sha256(file.read_bytes()).hexdigest() == before
    assert sorted(p.relative_to(source.root).as_posix() for p in source.root.rglob("*") if p.is_file()) == ["automations/climate/ventilation.yaml"]


@pytest.mark.parametrize("text", [
    "alias: not a list", "- [not, a, mapping]", "- alias: no id",
    "- id: ''", "- id: true", "- id: duplicate\n- id: duplicate",
    "- id: bad\n  actions: [", "- id: bad\n  secret: !secret token",
    "- id: bad\n  value: .nan",
])
def test_reports_bad_files_without_hiding_valid_groups(source, text):
    (source.automations / "bad.yaml").write_text(text)
    result = source.list()
    assert len(result["items"]) == 2
    assert len(result["errors"]) == 1
    assert result["errors"][0]["file"] == "automations/bad.yaml"


@pytest.mark.parametrize("file", ["../outside.yaml", "/etc/passwd", "climate/../outside.yaml"])
def test_rejects_paths_outside_the_root(source, file):
    with pytest.raises(ValueError):
        source.read(file, "first")


def test_rejects_symlink_escape(source, tmp_path):
    outside = tmp_path.parent / f"{tmp_path.name}-outside.yaml"
    outside.write_text(VALID)
    (source.automations / "escape.yaml").symlink_to(outside)
    with pytest.raises(ValueError):
        source.read("automations/escape.yaml", "first")
    assert source.list()["errors"][0]["file"] == "automations/escape.yaml"


def test_missing_entry_file_and_large_file(source):
    with pytest.raises(ValueError, match="not found"):
        source.read("automations/climate/ventilation.yaml", "missing")
    with pytest.raises(FileNotFoundError):
        source.read("automations/missing.yaml", "first")
    (source.automations / "large.yaml").write_bytes(b" " * (2 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match="2 MiB"):
        source.read("automations/large.yaml", "first")


def test_reads_fresh_file_and_orders_groups(source):
    (source.automations / "a.yml").write_text("- id: first\n  alias: Other group")
    assert source.list()["items"][0]["file"] == "automations/a.yml"
    path = source.automations / "climate" / "ventilation.yaml"
    path.write_text(VALID.replace("alias: First", "alias: Changed externally"))
    assert source.read("automations/climate/ventilation.yaml", "first")["alias"] == "Changed externally"


def test_objects_and_root_yaml_are_not_automation_sources(source):
    (source.root / "objects").mkdir()
    (source.root / "objects" / "entities.yaml").write_text(VALID)
    (source.root / "settings.yaml").write_text(VALID)
    assert len(source.list()["items"]) == 2
    assert source.list()["errors"] == []
    for file in ["objects/entities.yaml", "settings.yaml"]:
        with pytest.raises(ValueError, match="automations/"):
            source.read(file, "first")


def test_automation_symlink_cannot_read_objects(source):
    (source.root / "objects").mkdir()
    target = source.root / "objects" / "entities.yaml"
    target.write_text(VALID)
    (source.automations / "objects.yaml").symlink_to(target)
    with pytest.raises(ValueError):
        source.read("automations/objects.yaml", "first")


def test_requires_automations_directory_inside_root(tmp_path):
    with pytest.raises(OSError):
        FileSource(str(tmp_path))
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (tmp_path / "automations").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="inside"):
        FileSource(str(tmp_path))


def test_automations_directory_cannot_alias_objects(tmp_path):
    objects = tmp_path / "objects"
    objects.mkdir()
    (tmp_path / "automations").symlink_to(objects, target_is_directory=True)
    with pytest.raises(ValueError):
        FileSource(str(tmp_path))


@pytest.mark.parametrize("root", ["", "relative/path", "/does-not-exist-flode"])
def test_requires_an_existing_absolute_root(root):
    with pytest.raises((ValueError, OSError)):
        FileSource(root)


@pytest.mark.parametrize("handler", [list_files])
def test_file_commands_require_an_administrator(handler):
    connection = SimpleNamespace(user=SimpleNamespace(is_admin=False))
    with pytest.raises(Unauthorized):
        handler(None, connection, {"id": 1, "type": "flode/files/list"})


def test_unloaded_integration_has_no_file_access():
    with pytest.raises(ValueError, match="not loaded"):
        _directory(SimpleNamespace(data={}))


def test_file_api_surfaces_source_errors_without_a_fallback():
    errors = []
    connection = SimpleNamespace(send_error=lambda *args: errors.append(args))
    asyncio.run(_respond(SimpleNamespace(data={}), connection, {"id": 4}))
    assert errors == [(4, "file_source_error", "FLODE is not loaded")]


def test_climate_groups_are_read_without_modifying_files():
    root = Path(__file__).resolve().parents[1] / "dev" / "container" / "fixtures"
    source = FileSource(str(root))
    files = {"heating.yaml": 2, "ventilation.yaml": 2}
    before = {name: (source.automations / "climate" / name).read_bytes() for name in files}
    listed = source.list()
    assert listed["errors"] == []
    for name, count in files.items():
        file = f"automations/climate/{name}"
        items = [item for item in listed["items"] if item["file"] == file]
        assert len(items) == count
        for item in items:
            assert str(source.read(file, item["id"])["id"]) == item["id"]
        assert (source.automations / "climate" / name).read_bytes() == before[name]


def test_duplicate_ids_across_files_are_reported_without_hiding_repairable_entries(tmp_path):
    directory = tmp_path / "automations"
    directory.mkdir()
    for name in ("first.yaml", "second.yml"):
        (directory / name).write_text("- id: duplicate\n  alias: Repair me\n  actions: []\n")
    source = FileSource(str(tmp_path))
    result = source.list()
    assert len(result["items"]) == 2
    assert len(result["errors"]) == 1
    assert "Duplicate automation id: duplicate" in result["errors"][0]["error"]
    assert source.read("automations/second.yml", "duplicate")["alias"] == "Repair me"
