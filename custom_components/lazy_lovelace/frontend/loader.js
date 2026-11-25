/*
 * Lazy Lovelace loader.
 *
 * Home Assistant loads every Lovelace resource on every page of every device. Scripts that you made "lazy" in the
 * Lazy loading panel are not registered as resources any more; this file (served to every page by the integration)
 * holds the table "script -> card tags" and imports a script the first time something asks for one of its tags.
 *
 * How the frontend asks: for `type: custom:<tag>` it calls customElements.get(tag); when the tag is unknown it creates
 * a hidden error card ("Custom element doesn't exist"), waits up to 2 s for customElements.whenDefined(tag), and
 * rebuilds the card when the element appears. We hook customElements.get, whenDefined and document.createElement, so
 * the first question about a lazy tag starts the import. A catch-up scan covers cards that were created before this
 * file ran (their error cards carry the tag in `_config.message`).
 *
 * It also records which script defines which custom element (from the stack of customElements.define), which the
 * panel uses to show the tags of each script. Nothing is sent anywhere.
 */
(() => {
  if (window.lazyLovelace) return;

  const CONFIG_URL = '/api/lazy_lovelace/config';
  const CACHE_KEY = 'lazy_lovelace_table_v1';
  const CORE = /\/frontend_latest\/|\/frontend_es5\/|\/static\//;
  const SELF = /lazy_lovelace_static\/loader\.js/;

  const TAG = new Map();          // tag -> script path
  const LAZY = {};                // script path -> [tags]
  const loading = new Map();      // script path -> promise
  const pending = new Set();      // tags asked for before the table was known
  const defs = new Map();         // script path -> Set(tags it defined), from customElements.define
  let tableReady = false;

  const nativeGet = customElements.get.bind(customElements);
  const nativeWhen = customElements.whenDefined.bind(customElements);
  const nativeDefine = customElements.define.bind(customElements);

  // ---- which script defines which tag -------------------------------------------------------------------------
  customElements.define = function (name, ctor, options) {
    try {
      const old = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      const stack = new Error().stack || '';
      Error.stackTraceLimit = old;
      const urls = (stack.match(/https?:\/\/[^\s)]+?\.js/g) || []).filter((u) => !CORE.test(u) && !SELF.test(u));
      // the outermost frame is the module that called define (wrappers of define sit closer to the top)
      if (urls.length) {
        const src = new URL(urls[urls.length - 1]).pathname;
        if (!defs.has(src)) defs.set(src, new Set());
        defs.get(src).add(name);
      }
    } catch (e) { /* recording is best effort */ }
    return nativeDefine(name, ctor, options);
  };

  // ---- the table ----------------------------------------------------------------------------------------------
  const setTable = (table) => {
    for (const k of Object.keys(LAZY)) delete LAZY[k];
    TAG.clear();
    for (const [path, tags] of Object.entries(table || {})) {
      LAZY[path] = tags;
      for (const t of tags) TAG.set(t, path);
    }
  };
  try {   // the last table seen: no race on repeat visits
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached) setTable(cached);
  } catch (e) { /* storage may be blocked */ }

  // ---- loading ------------------------------------------------------------------------------------------------
  const version = async (url) => {   // the revalidated ETag keeps the ?v= cache buster right after a script update
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
      return (r.headers.get('etag') || r.headers.get('last-modified') || '').replace(/[^A-Za-z0-9]/g, '');
    } catch (e) { return ''; }
  };

  const load = (path) => {
    if (!loading.has(path)) {
      const p = (async () => {
        if ((LAZY[path] || []).some((t) => nativeGet(t))) return;   // already registered some other way
        const v = await version(path);
        await import(v ? `${path}?v=${v}` : path);
      })().catch((e) => { console.error('[lazy-lovelace] failed to load', path, e); loading.delete(path); });
      loading.set(path, p);
    }
    return loading.get(path);
  };

  const want = (tag) => {
    if (typeof tag !== 'string') return;
    const name = tag.toLowerCase();
    const path = TAG.get(name);
    if (path) { if (!loading.has(path) && !nativeGet(name)) load(path); }
    else if (!tableReady) pending.add(name);
  };

  customElements.get = function (name) {
    const r = nativeGet(name);
    if (r === undefined) want(name);
    return r;
  };
  customElements.whenDefined = function (name) { want(name); return nativeWhen(name); };
  const nativeCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (tag) { want(tag); return nativeCreate.apply(this, arguments); };

  // ---- catch-up: cards created before this file (or the table) was ready -------------------------------------
  const scan = (root) => {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.localName === 'hui-error-card' || n.localName === 'hui-error-entity-row') {
        const msg = (n._config && n._config.message) || (n.config && n.config.message) || (n.shadowRoot && n.shadowRoot.textContent) || '';
        const m = /Custom element doesn't exist: ([a-z0-9-]+)/.exec(msg);
        if (m) want(m[1]);
      }
      if (n.shadowRoot) stack.push(n.shadowRoot);
      for (const c of n.children || []) stack.push(c);
    }
  };
  const CATCH_UP_MS = [0, 300, 800, 1500, 3000, 6000];
  const catchUp = (i) => {
    const ha = document.querySelector('home-assistant');
    if (ha) scan(ha);
    if (i + 1 < CATCH_UP_MS.length) setTimeout(() => catchUp(i + 1), CATCH_UP_MS[i + 1] - CATCH_UP_MS[i]);
  };

  const ready = fetch(CONFIG_URL, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j && j.lazy) {
        setTable(j.lazy);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(j.lazy)); } catch (e) { /* ignore */ }
      }
    })
    .catch(() => { /* keep the cached table */ })
    .then(() => {
      tableReady = true;
      for (const t of pending) want(t);
      pending.clear();
      setTimeout(() => catchUp(0), 0);
    });

  window.lazyLovelace = {
    ready,
    table: () => JSON.parse(JSON.stringify(LAZY)),
    defs: () => Object.fromEntries([...defs].map(([k, v]) => [k, [...v]])),
    loaded: () => [...loading.keys()],
    load,
    loadAll: () => Promise.all(Object.keys(LAZY).map(load)),
  };
})();
