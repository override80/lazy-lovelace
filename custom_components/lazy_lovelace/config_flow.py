"""Config flow: nothing to ask, one instance."""

from __future__ import annotations

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN


class LazyLovelaceConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add the integration with one click."""

    VERSION = 1

    async def async_step_user(self, user_input=None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="Lazy Lovelace", data={})
        return self.async_show_form(step_id="user")
