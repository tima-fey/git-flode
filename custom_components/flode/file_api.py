"""Administrator-only reads and saves of existing file automations."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
import yaml
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from ruamel.yaml.error import YAMLError as RoundTripError

from .const import DOMAIN
from .file_source import CONF_DIRECTORY, FileSource


def _directory(hass: HomeAssistant) -> str:
    entry = hass.data.get(DOMAIN)
    if entry is None:
        raise ValueError("FLODE is not loaded")
    return entry.options.get(CONF_DIRECTORY, entry.data.get(CONF_DIRECTORY, ""))


def _list_files(directory: str) -> dict[str, Any]:
    return FileSource(directory).list()


@callback
def async_register_file_commands(hass: HomeAssistant) -> None:
    """Register handlers once; they resolve current integration settings per read."""
    websocket_api.async_register_command(hass, list_files)
    websocket_api.async_register_command(hass, open_file)
    websocket_api.async_register_command(hass, save_file)


async def _respond(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    try:
        directory = _directory(hass)
        result = await hass.async_add_executor_job(_list_files, directory)
    except (OSError, ValueError, TypeError, yaml.YAMLError, RoundTripError) as error:
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
    vol.Required("type"): "flode/files/open",
    vol.Required("file"): str,
    vol.Required("automation_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def open_file(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Open an existing entry with a file revision for conflict detection."""
    from .file_writer import open_automation

    try:
        result = await hass.async_add_executor_job(
            open_automation, _directory(hass), message["file"], message["automation_id"]
        )
    except (OSError, ValueError, TypeError, yaml.YAMLError, RoundTripError) as error:
        connection.send_error(message["id"], "file_source_error", str(error))
    else:
        connection.send_result(message["id"], result)


@websocket_api.websocket_command({
    vol.Required("type"): "flode/files/save",
    vol.Required("file"): str,
    vol.Required("automation_id"): str,
    vol.Required("version"): str,
    vol.Required("directory"): str,
    vol.Required("config"): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
async def save_file(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Save an existing automation without creating files or calling HA services."""
    from .file_writer import save_automation

    try:
        result = await hass.async_add_executor_job(
            save_automation, _directory(hass), message["file"], message["automation_id"],
            message["version"], message["directory"], message["config"],
        )
    except (OSError, ValueError, TypeError, yaml.YAMLError, RoundTripError) as error:
        connection.send_error(message["id"], "file_save_error", str(error))
    else:
        connection.send_result(message["id"], result)
