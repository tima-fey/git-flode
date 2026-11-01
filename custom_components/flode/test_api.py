"""Administrator-only manual project test command."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .file_api import _directory
from .test_source import run_tests


@websocket_api.websocket_command({vol.Required("type"): "flode/tests/run"})
@websocket_api.require_admin
@websocket_api.async_response
async def run_project_tests(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, message: dict[str, Any]
) -> None:
    """Run only tests from the currently configured project root."""
    try:
        result = await hass.async_add_executor_job(run_tests, _directory(hass))
    except (OSError, ValueError) as error:
        connection.send_error(message["id"], "project_test_error", str(error))
    else:
        connection.send_result(message["id"], result)
