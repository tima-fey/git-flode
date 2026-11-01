"""Reload HA while keeping the configured project stable."""
from __future__ import annotations

import asyncio
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .file_api import _directory
from .file_source import FileSource
from .git_source import require_prod_for_writes
from .project_lock import project_lock


async def _reload_project(hass: HomeAssistant, expected_directory: str) -> None:
    directory = _directory(hass)
    source = await hass.async_add_executor_job(FileSource, directory)
    if str(source.root) != expected_directory:
        raise ValueError("The configured project changed; refresh before reloading")
    # A disconnected browser must not release the lock while HA is still reading.
    await asyncio.shield(hass.async_create_task(_reload_locked(hass, directory, source)))


async def _reload_locked(hass: HomeAssistant, directory: str, source: FileSource) -> None:
    lock = project_lock(str(source.root))
    # A nonblocking acquisition cannot leave an executor holding an orphaned lock
    # if this request is cancelled while waiting for a worker thread.
    if not lock.acquire(blocking=False):
        raise ValueError("Another project operation is running; try again when it finishes")
    try:
        await hass.async_add_executor_job(require_prod_for_writes, source.root)
        if _directory(hass) != directory:
            raise ValueError("The configured project changed; refresh before reloading")
        await hass.services.async_call("homeassistant", "reload_all", {}, blocking=True)
    finally:
        lock.release()


@websocket_api.websocket_command({
    vol.Required("type"): "flode/ha/reload",
    vol.Required("directory"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def reload_project(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Run the native reload service under the same lock as Git and file saves."""
    try:
        await _reload_project(hass, message["directory"])
    except (OSError, ValueError, HomeAssistantError) as error:
        connection.send_error(message["id"], "project_reload_error", str(error))
    else:
        connection.send_result(message["id"], None)
