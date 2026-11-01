"""Version-checked edits of existing YAML automations, without HA config writes."""
from __future__ import annotations

import json
import os
import tempfile
from hashlib import sha256
from io import StringIO
from pathlib import Path
from typing import Any

import yaml
from ruamel.yaml import YAML

from .file_source import FileSource
from .git_source import require_prod_for_writes
from .project_lock import project_lock

# Keys represented by the visual automation graph; future HA keys remain intact.
_EDITABLE_KEYS = {
    "id", "alias", "description", "trigger", "triggers", "condition", "conditions",
    "action", "actions", "variables", "trigger_variables", "mode", "max",
    "max_exceeded", "initial_state", "trace",
}


def _check_editable_values(value: Any) -> None:
    """Reject values the browser transport cannot represent without data loss."""
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("Editing YAML with non-string mapping keys is not supported")
        for child in value.values():
            _check_editable_values(child)
    elif isinstance(value, list):
        for child in value:
            _check_editable_values(child)
    elif type(value) is int and abs(value) > 2**53 - 1:
        raise ValueError("An integer exceeds the browser's lossless range; the file was not changed")


def _file_bytes(path: Path) -> bytes:
    with path.open("rb") as handle:
        content = handle.read(2 * 1024 * 1024 + 1)
    if len(content) > 2 * 1024 * 1024:
        raise ValueError("YAML files must be smaller than 2 MiB")
    return content


def open_automation(directory: str, file: str, automation_id: str) -> dict[str, Any]:
    """Return the entry and a revision of the entire source file together."""
    source = FileSource(directory)
    with project_lock(str(source.root)):
        path = source._path(file)
        before = _file_bytes(path)
        config = source.read(file, automation_id)
        if _file_bytes(path) != before:
            raise ValueError("The file changed while opening; try again")
        return {"config": config, "version": sha256(before).hexdigest(), "directory": str(source.root)}


def _merge(old: Any, new: Any) -> Any:
    """Keep unchanged round-trip nodes, including their comments and quotes."""
    if old == new:
        return old
    if isinstance(old, dict) and isinstance(new, dict):
        for key in list(old):
            if key not in new:
                del old[key]
        for key, value in new.items():
            old[key] = _merge(old.get(key), value)
        return old
    if isinstance(old, list) and isinstance(new, list):
        for index, value in enumerate(new):
            if index < len(old):
                old[index] = _merge(old[index], value)
            else:
                old.append(value)
        del old[len(new):]
        return old
    return new


def save_automation(
    directory: str, file: str, automation_id: str, version: str,
    expected_directory: str, config: dict[str, Any],
) -> dict[str, Any]:
    """Replace only an existing ID, under the same lock used by Git and tests."""
    source = FileSource(directory)
    if str(source.root) != expected_directory:
        raise ValueError("The configured project changed; reopen the automation")
    lock = project_lock(str(source.root))
    if not lock.acquire(timeout=1):
        raise ValueError("Another project operation is running; try again when it finishes")
    try:
        require_prod_for_writes(source.root)
        relative = Path(file)
        if any((source.root / Path(*relative.parts[:i])).is_symlink() for i in range(1, len(relative.parts) + 1)):
            raise ValueError("Symlinked automation paths cannot be edited")
        path = source._path(file)
        original = _file_bytes(path)
        if sha256(original).hexdigest() != version:
            raise ValueError("The YAML file changed on disk. Reopen it before saving; your edits have not been written")
        entries = source._entries(file)
        index = next((i for i, entry in enumerate(entries) if str(entry["id"]) == automation_id), None)
        if index is None:
            raise ValueError("Only existing automations can be edited")
        _check_editable_values(entries[index])
        if "use_blueprint" in entries[index] or "use_blueprint" in config:
            raise ValueError("Editing file-based blueprint automations is not supported")
        if "id" in config and str(config["id"]) != automation_id:
            raise ValueError("An existing automation ID cannot be changed")
        config = {
            **{key: value for key, value in entries[index].items() if key not in _EDITABLE_KEYS},
            **config, "id": entries[index]["id"],
        }
        for legacy, modern in (("trigger", "triggers"), ("condition", "conditions"), ("action", "actions")):
            if legacy in entries[index] and modern in config and legacy not in config:
                config[legacy] = config.pop(modern)
        json.dumps(config, allow_nan=False)
        text = original.decode("utf-8")
        if any(isinstance(token, (yaml.AliasToken, yaml.AnchorToken)) for token in yaml.scan(text)):
            raise ValueError("Files with YAML anchors or aliases are view-only")
        document = YAML()
        document.preserve_quotes = True
        document.width = 4096
        if b"\r\n" in original:
            document.line_break = "\r\n"
        data = document.load(text)
        data[index] = _merge(data[index], config)
        stream = StringIO()
        document.dump(data, stream)
        updated = stream.getvalue().encode("utf-8")
        if len(updated) > 2 * 1024 * 1024:
            raise ValueError("YAML files must be smaller than 2 MiB")
        expected = [*entries]
        expected[index] = config
        if yaml.safe_load(updated) != expected:
            raise ValueError("The YAML round trip changed data; the original file was preserved")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".flode-", delete=False) as handle:
                temporary = Path(handle.name)
                original_stat = path.stat()
                os.fchown(handle.fileno(), original_stat.st_uid, original_stat.st_gid)
                os.fchmod(handle.fileno(), original_stat.st_mode & 0o777)
                handle.write(updated)
                handle.flush()
                os.fsync(handle.fileno())
            if source._path(file) != path or _file_bytes(path) != original:
                raise ValueError("The file changed during saving; reopen it and try again")
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return {"config": config, "version": sha256(updated).hexdigest(), "directory": str(source.root)}
    finally:
        lock.release()
