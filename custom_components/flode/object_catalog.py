"""Capture non-secret HA registry metadata for offline automation checks."""
from __future__ import annotations

import json
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    area_registry,
    device_registry,
    entity_platform,
    entity_registry,
    label_registry,
)
from homeassistant.loader import async_get_integrations


def _optional(value: Any) -> str | None:
    return str(value) if value is not None else None


def _device_entries(device: Any) -> list[str]:
    # HA 2026.10 uses a single owner; older versions allow several entries.
    if getattr(device, "config_entry_id", None) and not getattr(device, "is_composite_device", False):
        return [device.config_entry_id]
    return sorted(device.config_entries)


def _capture(hass: HomeAssistant) -> dict[str, Any]:
    """Copy registry values on the event loop before any asynchronous work."""
    entries = [{
        "id": entry.entry_id, "domain": entry.domain, "title": entry.title,
        "state": str(entry.state), "disabled_by": _optional(entry.disabled_by),
    } for entry in hass.config_entries.async_entries()]
    entry_domains = {entry["id"]: entry["domain"] for entry in entries}
    devices = []
    for device in device_registry.async_get(hass).devices.values():
        owners = _device_entries(device)
        primary = owners[0] if len(owners) == 1 else getattr(device, "primary_config_entry", None)
        owner = primary if primary in owners else next(iter(owners), None)
        devices.append({
            "id": device.id, "config_entry_ids": owners, "config_entry_id": owner,
            "integration_domain": entry_domains.get(owner, "unknown"),
            "name": device.name, "name_by_user": device.name_by_user,
            "manufacturer": getattr(device, "manufacturer", None), "model": getattr(device, "model", None),
            "model_id": getattr(device, "model_id", None), "area_id": device.area_id,
            "via_device_id": getattr(device, "via_device_id", None),
            "disabled_by": _optional(device.disabled_by), "labels": sorted(device.labels),
            "identifiers": [list(pair) for pair in sorted(device.identifiers)],
        })
    states = {state.entity_id: state for state in hass.states.async_all()}
    registered = entity_registry.async_get(hass).entities
    domains = {entry["domain"] for entry in entries} | {entry.platform for entry in registered.values()}
    domains |= {component.split(".")[-1] for component in hass.config.components}
    domains |= {entity_id.split(".")[0] for entity_id in states}
    platforms = {}
    for domain in domains:
        for platform in entity_platform.async_get_platforms(hass, domain):
            for entity_id in platform.entities:
                platforms[entity_id] = (platform.platform_name, platform.config_entry.entry_id if platform.config_entry else None)
    entities = []
    for entry in registered.values():
        state = states.get(entry.entity_id)
        entities.append({
            "entity_id": entry.entity_id, "registry_id": entry.id, "unique_id": entry.unique_id,
            "platform": entry.platform, "integration_domain": entry_domains.get(entry.config_entry_id, entry.platform),
            "config_entry_id": entry.config_entry_id, "config_subentry_id": getattr(entry, "config_subentry_id", None),
            "device_id": entry.device_id, "area_id": entry.area_id,
            "name": entry.name, "original_name": entry.original_name,
            "friendly_name": state.attributes.get("friendly_name") if state else None,
            "device_class": entry.original_device_class, "unit_of_measurement": entry.unit_of_measurement,
            "entity_category": _optional(entry.entity_category), "disabled_by": _optional(entry.disabled_by),
            "hidden_by": _optional(entry.hidden_by), "labels": sorted(entry.labels), "registered": True,
        })
    known = {entry["entity_id"] for entry in entities}
    for entity_id, state in states.items():
        if entity_id in known:
            continue
        platform, owner = platforms.get(entity_id, (entity_id.split(".")[0], None))
        entities.append({
            "entity_id": entity_id, "registry_id": None, "unique_id": None,
            "platform": platform, "integration_domain": entry_domains.get(owner, platform),
            "config_entry_id": owner, "config_subentry_id": None, "device_id": None,
            "area_id": None, "name": None, "original_name": None,
            "friendly_name": state.attributes.get("friendly_name"),
            "device_class": state.attributes.get("device_class"),
            "unit_of_measurement": state.attributes.get("unit_of_measurement"),
            "entity_category": None, "disabled_by": None, "hidden_by": None,
            "labels": [], "registered": False,
        })
    areas = {area.id: {"name": area.name, "floor_id": getattr(area, "floor_id", None)}
             for area in area_registry.async_get(hass).areas.values()}
    labels = {label.label_id: {"name": label.name} for label in label_registry.async_get(hass).labels.values()}
    return json.loads(json.dumps({"integrations": entries, "devices": devices, "entities": entities, "areas": areas, "labels": labels}, allow_nan=False))


async def async_collect_catalog(hass: HomeAssistant) -> dict[str, Any]:
    """Include registry-only disabled entities and live YAML-only helpers."""
    catalog = _capture(hass)
    domains = {entry["domain"] for entry in catalog["integrations"]}
    domains |= {entry["integration_domain"] for entry in catalog["entities"]}
    domains |= {entry["platform"] for entry in catalog["entities"]}
    integrations = await async_get_integrations(hass, sorted(domains))
    helpers = {domain for domain, integration in integrations.items()
               if not isinstance(integration, Exception) and integration.integration_type == "helper"}
    catalog["warnings"] = [f"Integration metadata unavailable: {domain}"
                           for domain, value in sorted(integrations.items()) if isinstance(value, Exception)]
    for entry in catalog["entities"]:
        entry["is_helper"] = entry["integration_domain"] in helpers or entry["platform"] in helpers
    return catalog
