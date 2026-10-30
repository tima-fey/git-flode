"""FLODE - Visual automation editor for Home Assistant."""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .file_api import async_register_file_commands
from .git_api import async_register_git_commands
from .panel import async_register_panel, async_unregister_panel

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up FLODE from a config entry."""
    await async_register_panel(hass, entry)
    hass.data[DOMAIN] = entry
    async_register_file_commands(hass)
    async_register_git_commands(hass)
    _LOGGER.info("FLODE integration set up successfully")
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    hass.data.pop(DOMAIN, None)
    async_unregister_panel(hass)
    return True
