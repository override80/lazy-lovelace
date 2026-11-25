"""Lazy Lovelace: load heavy dashboard card scripts only when a card needs them.

Home Assistant loads every registered Lovelace resource on every page of every device. This integration lets you
take a resource out of that list and keep it in a small table (tag -> script). A loader script, served to every page,
imports the real script the first time a card of one of those types is created. A sidebar panel shows every script
with its size, the cards it provides, where they are used, and a hint whether lazy loading is a good idea.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from aiohttp import web
import voluptuous as vol

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.collection import CHANGE_ADDED, CHANGE_UPDATED
from homeassistant.helpers.storage import Store

from .const import (
    CONFIG_URL,
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_URL_PATH,
    STATIC_URL,
    STORAGE_KEY,
    STORAGE_VERSION,
    TAG_PATTERN,
    VERSION,
)

_LOGGER = logging.getLogger(__name__)
_TAG = re.compile(TAG_PATTERN)
_FRONTEND = Path(__file__).parent / "frontend"


def _script_path(url: str) -> str:
    """The URL without its ?version / #fragment: how a script is identified."""
    return url.split("?", 1)[0].split("#", 1)[0]


class LazyState:
    """What is lazy: {script path: {"tags": [...], "resource": {"type": ..., "url": ...}}}.

    `resource` is the Lovelace resource that was taken out, kept so "make eager" can put it back unchanged.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.lazy: dict[str, dict[str, Any]] = {}
        self.stopped = False

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.lazy = {
            str(path): {
                "tags": sorted({str(t) for t in entry.get("tags", []) if _TAG.fullmatch(str(t))}),
                "resource": entry.get("resource"),
            }
            for path, entry in (data.get("lazy") or {}).items()
            if isinstance(entry, dict)
        }

    async def async_save(self) -> None:
        await self._store.async_save({"lazy": self.lazy})

    def table(self) -> dict[str, list[str]]:
        """What the loader needs: script path -> tags."""
        return {path: entry["tags"] for path, entry in self.lazy.items() if entry["tags"]}


class LazyConfigView(HomeAssistantView):
    """The table for the loader. No authentication: it is read by a script that runs before anything else and holds
    only public static file paths and card tag names."""

    url = CONFIG_URL
    name = "api:lazy_lovelace:config"
    requires_auth = False

    def __init__(self, state: LazyState) -> None:
        self._state = state

    async def get(self, request: web.Request) -> web.Response:
        return web.json_response({"lazy": self._state.table()}, headers={"Cache-Control": "no-store"})


def _resources(hass: HomeAssistant):
    """The Lovelace resource collection and whether it can be edited (storage mode)."""
    data = hass.data[LOVELACE_DATA]
    return data.resources, data.resource_mode == "storage"


@websocket_api.websocket_command({vol.Required("type"): "lazy_lovelace/get"})
@websocket_api.require_admin
@callback
def ws_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The lazy table (with the saved resources) and whether resources are editable."""
    resources, editable = _resources(hass)
    connection.send_result(msg["id"], {"lazy": hass.data[DOMAIN].lazy, "editable": editable})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "lazy_lovelace/set",
        vol.Required("path"): str,
        vol.Required("lazy"): bool,
        vol.Optional("tags", default=[]): [str],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Make a script lazy (take its resource out, remember its tags) or eager again (put the resource back)."""
    state: LazyState = hass.data[DOMAIN]
    resources, editable = _resources(hass)
    if not editable:
        connection.send_error(msg["id"], "not_editable", "Lovelace resources are managed in YAML mode")
        return
    path = _script_path(msg["path"])
    items = [i for i in resources.async_items() if _script_path(i["url"]) == path]

    if msg["lazy"]:
        tags = sorted({t for t in msg["tags"] if _TAG.fullmatch(t)})
        if not tags:
            connection.send_error(msg["id"], "no_tags", "No valid custom element tags given")
            return
        if path.startswith(STATIC_URL):
            connection.send_error(msg["id"], "self", "The loader itself cannot be lazy")
            return
        original = state.lazy.get(path, {}).get("resource")
        if items:
            original = {"type": items[0].get("type", "module"), "url": items[0]["url"]}
        if original is None:
            connection.send_error(msg["id"], "not_found", "No Lovelace resource for that script")
            return
        for item in items:
            await resources.async_delete_item(item["id"])
        state.lazy[path] = {"tags": tags, "resource": original}
    else:
        entry = state.lazy.pop(path, None)
        if entry and not items and entry.get("resource"):
            res = entry["resource"]
            await resources.async_create_item({"res_type": res.get("type", "module"), "url": res["url"]})
    await state.async_save()
    connection.send_result(msg["id"], {"lazy": state.lazy})


async def _async_guard(hass: HomeAssistant, state: LazyState) -> None:
    """Keep lazy scripts out of the resource list.

    A Marketplace/HACS update, or an integration that registers its own card, adds the resource again. When that
    happens the new URL (with its new version) replaces the saved one and the resource is removed again, so "make
    eager" restores the latest file. Also done once at start for anything that is already back.
    """
    resources, editable = _resources(hass)
    if not editable:
        return

    async def purge(item: dict[str, Any]) -> None:
        path = _script_path(item["url"])
        if path in state.lazy:
            state.lazy[path]["resource"] = {"type": item.get("type", "module"), "url": item["url"]}
            await state.async_save()
            hass.async_create_task(resources.async_delete_item(item["id"]))

    async def listener(change_type: str, item_id: str, item: dict[str, Any]) -> None:
        if state.stopped or change_type not in (CHANGE_ADDED, CHANGE_UPDATED):
            return
        await purge(item)

    await resources.async_get_info()   # makes sure the collection is loaded
    for item in list(resources.async_items()):
        await purge(item)
    resources.async_add_listener(listener)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Serve the loader and the panel, and open the websocket API."""
    state = LazyState(hass)
    await state.async_load()
    hass.data[DOMAIN] = state

    version = VERSION
    await hass.http.async_register_static_paths([StaticPathConfig(STATIC_URL, str(_FRONTEND), False)])
    hass.http.register_view(LazyConfigView(state))
    frontend.add_extra_js_url(hass, f"{STATIC_URL}/loader.js?v={version}")
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title="Lazy loading",
        sidebar_icon="mdi:timer-sand",
        module_url=f"{STATIC_URL}/panel.js?v={version}",
        require_admin=True,
        config={},
    )
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_set)
    await _async_guard(hass, state)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the panel. The loader and the table stay served until the next restart (static paths cannot be removed)."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    state = hass.data.pop(DOMAIN, None)
    if state is not None:
        state.stopped = True
    return True
