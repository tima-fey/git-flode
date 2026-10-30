"""Read independent automations from a configured FLODE directory."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

CONF_DIRECTORY = "config_directory"


class FileSource:
    """Read-only storage; paths supplied by clients are relative to the root."""

    def __init__(self, directory: str) -> None:
        root = Path(directory)
        if not directory or not root.is_absolute():
            raise ValueError("Configure an absolute FLODE configuration directory in FLODE settings")
        self.root = root.resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("The configured FLODE directory is not a directory")
        automations = self.root / "automations"
        if automations.is_symlink():
            raise ValueError("automations/ must be a real directory inside the configured FLODE root")
        self.automations = automations.resolve(strict=True)
        if not self.automations.is_relative_to(self.root) or not self.automations.is_dir():
            raise ValueError("automations/ must be a directory inside the configured FLODE root")

    def _path(self, file: str) -> Path:
        relative = Path(file)
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or not relative.parts
            or relative.parts[0] != "automations"
        ):
            raise ValueError("Only files under automations/ may be read")
        path = (self.root / relative).resolve(strict=True)
        if not path.is_relative_to(self.automations) or path.suffix.lower() not in (".yaml", ".yml"):
            raise ValueError("Only YAML files inside automations/ are allowed")
        return path

    def _entries(self, file: str) -> list[dict[str, Any]]:
        path = self._path(file)
        if path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("YAML files must be smaller than 2 MiB")
        entries = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(entries, list):
            raise TypeError("Expected a YAML list of independent automations")
        ids: set[str] = set()
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise TypeError(f"Entry {index + 1} must be an automation mapping")
            automation_id = entry.get("id")
            if type(automation_id) not in (str, int) or not str(automation_id).strip():
                raise ValueError(f"Entry {index + 1} needs a non-empty automation id")
            key = str(automation_id)
            if key in ids:
                raise ValueError(f"Duplicate automation id: {key}")
            ids.add(key)
            # Reject recursive aliases and values the transport cannot represent.
            json.dumps(entry, allow_nan=False)
        return entries

    def list(self) -> dict[str, Any]:
        """List entries and report errors per file without hiding valid groups."""
        items = []
        errors = []
        for path in sorted(self.automations.rglob("*")):
            if path.suffix.lower() not in (".yaml", ".yml"):
                continue
            file = path.relative_to(self.root).as_posix()
            try:
                entries = self._entries(file)
                for entry in entries:
                    key = str(entry["id"])
                    name = entry.get("alias")
                    items.append({
                        "file": file,
                        "id": key,
                        "name": name if isinstance(name, str) and name else key,
                    })
            except (OSError, ValueError, TypeError, yaml.YAMLError) as error:
                errors.append({"file": file, "error": str(error)})
        return {"directory": str(self.root), "items": items, "errors": errors}

    def read(self, file: str, automation_id: str) -> dict[str, Any]:
        """Read one entry afresh; never consult Home Assistant's config API."""
        for entry in self._entries(file):
            if str(entry["id"]) == automation_id:
                return entry
        raise ValueError(f"Automation {automation_id} was not found in {file}")
