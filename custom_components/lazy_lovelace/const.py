"""Constants for Lazy Lovelace."""

DOMAIN = "lazy_lovelace"
VERSION = "0.1.0"  # keep in sync with manifest.json (it only busts the browser cache of the loader and the panel)
STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

STATIC_URL = "/lazy_lovelace_static"
CONFIG_URL = "/api/lazy_lovelace/config"
PANEL_URL_PATH = "lazy-lovelace"
PANEL_ELEMENT = "lazy-lovelace-panel"

# a custom element tag: lower case letters/digits, at least one dash
TAG_PATTERN = r"[a-z][a-z0-9]*(-[a-z0-9]+)+"
