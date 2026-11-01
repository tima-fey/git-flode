"""Config flow for git-flode."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.config_entries import ConfigFlowResult
from homeassistant.core import callback

from .const import DOMAIN
from .file_source import CONF_DIRECTORY, FileSource


def directory_schema(default: str) -> vol.Schema:
    """Share the directory setting between initial setup and options."""
    return vol.Schema({vol.Required(CONF_DIRECTORY, default=default): str})


class FlodeConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for git-flode."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        """Allow changing the directory without recreating the integration."""
        return FlodeOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        errors = {}
        if user_input is not None:
            try:
                await self.hass.async_add_executor_job(FileSource, user_input[CONF_DIRECTORY])
            except (OSError, ValueError):
                errors[CONF_DIRECTORY] = "invalid_directory"
        if user_input is not None and not errors:
            await self.async_set_unique_id(DOMAIN)
            self._abort_if_unique_id_configured()

            return self.async_create_entry(
                title="git-flode",
                data=user_input
            )

        return self.async_show_form(
            step_id="user",
            data_schema=directory_schema(
                user_input[CONF_DIRECTORY] if user_input else self.hass.config.path("flode-config")
            ),
            errors=errors,
        )


class FlodeOptionsFlow(config_entries.OptionsFlow):
    """Configure the shared project root for automations, objects, tests, and Git."""

    async def async_step_init(self, user_input=None) -> ConfigFlowResult:
        """Validate and save an absolute directory path."""
        errors = {}
        if user_input is not None:
            try:
                await self.hass.async_add_executor_job(FileSource, user_input[CONF_DIRECTORY])
            except (OSError, ValueError):
                errors[CONF_DIRECTORY] = "invalid_directory"
            else:
                return self.async_create_entry(title="", data=user_input)
        default = self.config_entry.options.get(
            CONF_DIRECTORY, self.config_entry.data.get(CONF_DIRECTORY, self.hass.config.path("flode-config"))
        )
        return self.async_show_form(
            step_id="init",
            data_schema=directory_schema(user_input[CONF_DIRECTORY] if user_input else default),
            errors=errors,
        )
