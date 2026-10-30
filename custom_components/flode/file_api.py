"""Administrator-only WebSocket commands for the read-only file source."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
import yaml
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .file_source import CONF_DIRECTORY, FileSource


def _directory(hass: HomeAssistant) -> str:
    entry = hass.data.get(DOMAIN)
    if entry is None:
        raise ValueError("FLODE is not loaded")
    return entry.options.get(CONF_DIRECTORY, entry.data.get(CONF_DIRECTORY, ""))


def _read(directory: str, message: dict[str, Any]) -> dict[str, Any]:
    source = FileSource(directory)
    if message["type"] == "flode/files/list":
        return source.list()
    return source.read(message["file"], message["automation_id"])


@callback
def async_register_file_commands(hass: HomeAssistant) -> None:
    """Register handlers once; they resolve current integration settings per read."""
    websocket_api.async_register_command(hass, list_files)
    websocket_api.async_register_command(hass, read_automation)


async def _respond(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    try:
        directory = _directory(hass)
        result = await hass.async_add_executor_job(_read, directory, message)
    except (OSError, ValueError, TypeError, yaml.YAMLError) as error:
        connection.send_error(message["id"], "file_source_error", str(error))
    else:
        connection.send_result(message["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "flode/files/list"})
@websocket_api.require_admin
@websocket_api.async_response
async def list_files(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """List only automations from the configured directory."""
    await _respond(hass, connection, message)


@websocket_api.websocket_command({
    vol.Required("type"): "flode/files/read",
    vol.Required("file"): str,
    vol.Required("automation_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def read_automation(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Read an individual automation without exposing a write command."""
    await _respond(hass, connection, message)
