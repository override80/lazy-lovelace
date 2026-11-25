# Lazy Lovelace

Load the heavy JavaScript of your dashboard cards **only when a view actually uses them**.

Home Assistant loads every Lovelace resource (every custom card's script) on every page of every device, whether or
not that page uses it. With a lot of custom cards that is tens of megabytes parsed on each load, which an old tablet
or phone feels badly. Lazy Lovelace adds a **Lazy loading** panel to the sidebar that shows every script, its size, the
cards it provides, where those cards are used, and a hint whether making it lazy is a good idea. One click takes the
script out of the always-loaded list; a tiny loader imports it the first time a card of that type is created.

On the author's instance (116 resources) it removed 50 scripts (**21 MB raw, 5.6 MB transferred**) from every page load.

## Install

**HACS / Marketplace:** add this repository as a custom repository (category *Integration*), install *Lazy Lovelace*,
restart Home Assistant, then *Settings → Devices & services → Add integration → Lazy Lovelace*.

**Manual:** copy `custom_components/lazy_lovelace` to your `config/custom_components/`, restart, add the integration.

Requires Lovelace resources in **storage mode** (the default). In YAML mode the panel is read-only.

## Use

Open **Lazy loading** in the sidebar (admins only). Hints:

| hint | meaning |
|---|---|
| **recommended** | a plain card, at least 60 KB, nothing else depends on it |
| **medium / small** | a modest or negligible saving: a lazy load costs an extra request |
| **check after** | used *inside* another custom card (`tabbed-card`, `vertical-stack-in-card`, ...). Usually fine, but one case lost its data: open those views afterwards |
| **unused** | no dashboard uses its cards: lazy costs nothing (or remove the card) |
| **advanced** | served by an integration, which may register its resource again at start; Lazy Lovelace removes it again |
| **keep eager** | plugins, libraries, containers and view layouts: other scripts or Home Assistant need them before any card asks for them |
| **unknown** | no custom element was seen being defined by the script, so its tags are not known |

*Make recommended lazy* converts every "recommended" row at once. *Make eager* puts the original resource back unchanged.
A change applies after a page reload.

## How it works

1. The integration serves `loader.js` to every page (`frontend.add_extra_js_url`) and a table *script → card tags*
   at `/api/lazy_lovelace/config` (public, only static file paths and tag names). Making a script lazy deletes its
   Lovelace resource and stores the tags (and the original resource, for the way back).
2. When a dashboard asks for `type: custom:<tag>`, Home Assistant's frontend calls `customElements.get(tag)`; for an unknown tag it
   creates a hidden error card, waits up to 2 s on `customElements.whenDefined(tag)`, and rebuilds the card when the element
   appears. The loader hooks `customElements.get`, `whenDefined` and `document.createElement`, so the first question about a
   lazy tag `import()`s the script. Cards created before the loader ran are caught by a short scan for their error cards.
3. The import URL carries the file's ETag (from a revalidating `HEAD`), so an updated file is picked up without cache problems.
4. The loader records which script defines which element (from the stack of `customElements.define`). The panel uses that to
   list the tags of each script; nothing leaves your browser.
5. A guard in the integration removes a lazy script's resource again when something re-adds it (a HACS update,
   an integration that registers its own card).

## Limits worth knowing

* A lazy card appears after one script download, the first time a view needs it. On a slow device the hidden error card can flash for a
  moment (Home Assistant shows it after 2 s).
* A lazy card is not in the card picker until it has loaded (type its YAML, or run `lazyLovelace.loadAll()` in the browser console).
* Plugins and libraries nothing asks for by name (custom sidebar, UIX/card-mod, browser_mod, WallPanel, layout/tabbed/stack/decluttering/auto-entities cards...) must stay eager.
* Entity rows, picture-element custom elements, tile features and badges go through other creation paths in Home Assistant; the hooks cover cards
  (and the error-card catch-up covers rows). Test those views after switching.
* Making *everything* lazy is not worth it: each lazy script costs an extra request and small scripts save almost nothing. Stick to the big ones.

## Testing a change

`tools/` holds a headless-Chrome rig (needs Chrome/Chromium with remote debugging and Python with `aiohttp` where Home Assistant can reach it): `crawl.py`
opens every view of every dashboard and records which custom elements render and any error cards; `compare.py` shows what differs between two runs.
Run it before and after making scripts lazy.

## Uninstall

*Make eager* every lazy row first (it restores the resources), then remove the integration.

## License

MIT
