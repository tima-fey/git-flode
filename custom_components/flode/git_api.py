"""Administrator-only Git controls; all subprocess work runs off the event loop."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .file_api import _directory
from .git_source import GitRepository


async def _respond(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    try:
        directory = _directory(hass)
        result = await hass.async_add_executor_job(_execute, directory, message)
    except (OSError, ValueError) as error:
        connection.send_error(message["id"], "git_error", str(error))
    else:
        connection.send_result(message["id"], result)


def _execute(directory: str, message: dict[str, Any]) -> dict[str, Any]:
    action = message["type"].rsplit("/", 1)[-1]
    return GitRepository(directory).request(
        message["action"] if action == "action" else action,
        expected_head=message.get("expected_head", ""),
        revision=message.get("revision", ""), offset=message.get("offset", 0),
        expected_changes=message.get("expected_changes", ""), message=message.get("message", ""),
        expected_directory=message.get("expected_directory", ""),
    )


@websocket_api.websocket_command({vol.Required("type"): "flode/git/status"})
@websocket_api.require_admin
@websocket_api.async_response
async def git_status(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Read the current checkout without contacting the remote."""
    await _respond(hass, connection, message)


@websocket_api.websocket_command({
    vol.Required("type"): "flode/git/history",
    vol.Optional("offset", default=0): vol.All(int, vol.Range(min=0, max=100000)),
})
@websocket_api.require_admin
@websocket_api.async_response
async def git_history(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Read a bounded page of local/fetched main history."""
    await _respond(hass, connection, message)


@websocket_api.websocket_command({
    vol.Required("type"): "flode/git/action",
    vol.Required("action"): vol.In(("fetch", "pull", "main", "checkout", "commit", "push")),
    vol.Required("expected_head"): str,
    vol.Optional("revision", default=""): str,
    vol.Optional("expected_changes", default=""): str,
    vol.Optional("expected_directory", default=""): str,
    vol.Optional("message", default=""): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def git_action(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Perform an explicit Git action; never execute or reload automations."""
    await _respond(hass, connection, message)


@callback
def async_register_git_commands(hass: HomeAssistant) -> None:
    """Register the explicit main-branch Git surface."""
    for command in (git_status, git_history, git_changes, git_action):
        websocket_api.async_register_command(hass, command)


@websocket_api.websocket_command({vol.Required("type"): "flode/git/changes"})
@websocket_api.require_admin
@websocket_api.async_response
async def git_changes(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Review pending changes without staging or committing them."""
    await _respond(hass, connection, message)
