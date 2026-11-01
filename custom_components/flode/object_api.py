"""Explicit administrator-only export of HA object metadata."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import voluptuous as vol
import yaml
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .file_api import _directory
from .object_catalog import async_collect_catalog
from .object_source import export_catalog


@websocket_api.websocket_command({
    vol.Required("type"): "flode/objects/export",
    vol.Required("directory"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def export_objects(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Nothing is collected or written until this command is requested."""
    try:
        directory = _directory(hass)
        if str(Path(directory).resolve()) != message["directory"]:
            raise ValueError("The configured project changed; refresh before exporting")
        catalog = await async_collect_catalog(hass)
        if _directory(hass) != directory:
            raise ValueError("The configured project changed during export; try again")
        result = await hass.async_add_executor_job(export_catalog, directory, message["directory"], catalog)
    except (OSError, ValueError, TypeError, yaml.YAMLError) as error:
        connection.send_error(message["id"], "object_export_error", str(error))
    else:
        connection.send_result(message["id"], result)
