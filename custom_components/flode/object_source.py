"""Replace the managed objects/ tree with a complete offline registry snapshot."""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

import yaml

from .git_source import require_prod_for_writes
from .project_lock import project_lock


def _segment(value: str) -> str:
    if not value:
        raise ValueError("Object IDs must not be empty")
    encoded = quote(value, safe="")
    return encoded.replace(".", "%2E") if encoded in (".", "..") else encoded


def _files(catalog: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    files: dict[str, Any] = {}
    index: dict[str, Any] = {"schema_version": 1, "integrations": {}, "devices": {}, "entities": {}, "helpers": {},
                             "areas": catalog["areas"], "labels": catalog["labels"], "warnings": catalog["warnings"]}
    owners = {entry["id"]: entry for entry in catalog["integrations"]}
    owner_domains = {entry["id"]: entry["domain"] for entry in catalog["integrations"]}
    for entity in sorted(catalog["entities"], key=lambda row: row["entity_id"]):
        if entity["config_entry_id"] is not None:
            owner_domains.setdefault(entity["config_entry_id"], entity["integration_domain"])

    def integration_path(domain: str, owner: str | None) -> str:
        domain = owner_domains.get(owner, domain) if owner is not None else domain
        key = owner if owner is not None else f"standalone:{domain}"
        path = f"integrations/{_segment(domain)}/{_segment(owner) if owner is not None else '_standalone'}"
        if key not in index["integrations"]:
            record = owners.get(owner, {"id": owner, "domain": domain, "title": domain, "state": "unregistered", "disabled_by": None})
            files[f"{path}/integration.yaml"] = record
            index["integrations"][key] = f"{path}/integration.yaml"
        return path

    for entry in sorted(catalog["integrations"], key=lambda row: row["id"]):
        integration_path(entry["domain"], entry["id"])
    device_paths = {}
    for device in sorted(catalog["devices"], key=lambda row: row["id"]):
        parent = integration_path(device["integration_domain"], device["config_entry_id"])
        path = f"{parent}/devices/{_segment(device['id'])}"
        files[f"{path}/device.yaml"] = device
        device_paths[device["id"]] = path
        index["devices"][device["id"]] = f"{path}/device.yaml"
    for entity in sorted(catalog["entities"], key=lambda row: row["entity_id"]):
        parent = device_paths.get(entity["device_id"])
        if parent is None:
            parent = integration_path(entity["integration_domain"], entity["config_entry_id"])
        path = f"{parent}/entities/{_segment(entity['entity_id'])}.yaml"
        if path in files or entity["entity_id"] in index["entities"]:
            raise ValueError("Duplicate entity ID in object snapshot")
        files[path] = entity
        index["entities"][entity["entity_id"]] = path
        if entity["is_helper"]:
            index["helpers"][entity["entity_id"]] = path
    files["helpers/index.yaml"] = index["helpers"]
    files["index.yaml"] = index
    return files, index


def export_catalog(directory: str, expected_directory: str, catalog: dict[str, Any]) -> dict[str, Any]:
    """Build fully before replacing objects; never touch automations or tests."""
    root = Path(directory)
    if not directory or not root.is_absolute():
        raise ValueError("Configure an absolute FLODE project root first")
    root = root.resolve(strict=True)
    if not root.is_dir() or str(root) != expected_directory:
        raise ValueError("The configured project changed; refresh before exporting")
    lock = project_lock(str(root))
    if not lock.acquire(timeout=1):
        raise ValueError("Another project operation is running; try again when it finishes")
    stage = backup = None
    published = False
    target = root / "objects"
    try:
        require_prod_for_writes(root)
        if target.is_symlink() or (target.exists() and not target.is_dir()):
            raise ValueError("objects/ must be a real directory inside the project root")
        ownership = target.stat() if target.exists() else root.stat()
        files, index = _files(catalog)
        stage = Path(tempfile.mkdtemp(prefix=".flode-objects-", dir=root))
        for relative, record in sorted(files.items()):
            path = stage / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(yaml.safe_dump(record, allow_unicode=True, sort_keys=True, width=120), encoding="utf-8")
        for path in [stage, *stage.rglob("*")]:
            info = path.stat()
            if (info.st_uid, info.st_gid) != (ownership.st_uid, ownership.st_gid):
                os.chown(path, ownership.st_uid, ownership.st_gid)
            path.chmod((ownership.st_mode & 0o777) if path.is_dir() else (ownership.st_mode & 0o666))
        if target.exists():
            backup = Path(tempfile.mkdtemp(prefix=".flode-objects-old-", dir=root))
            backup.rmdir()
            os.replace(target, backup)
        try:
            os.replace(stage, target)
            published = True
        except OSError:
            if backup is not None:
                os.replace(backup, target)
                backup = None
            raise
        if backup is not None:
            shutil.rmtree(backup)
            backup = None
        return {"directory": str(target), "integrations": len(index["integrations"]), "devices": len(index["devices"]),
                "entities": len(index["entities"]), "helpers": len(index["helpers"]), "files": len(files), "warnings": catalog["warnings"]}
    finally:
        try:
            if stage is not None and stage.exists():
                shutil.rmtree(stage)
            # Retain a backup on a cleanup error instead of deleting recoverable data.
            if backup is not None and not published and not target.exists():
                os.replace(backup, target)
        finally:
            lock.release()
