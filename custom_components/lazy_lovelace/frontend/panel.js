/*
 * Lazy Lovelace panel: every Lovelace script with its size, the cards it provides, where they are used, and a hint
 * whether lazy loading is a good idea. One click makes a script lazy (its resource is taken out and the loader
 * imports it on demand) or eager again (the resource is put back as it was).
 */
const TAG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

// Scripts that must stay eager whatever the heuristics say: plugins and libraries nothing asks for by name, and
// containers that hold other cards (a lazy container makes its children wait for it).
const KEEP_EAGER = [
  /custom-sidebar/, /uix/, /card-mod/, /browser_mod/, /wallpanel/, /swipe-navigation/, /card-tools/, /layout-card/,
  /button-card/, /decluttering/, /tabbed-card/, /stack-in-card/, /auto-entities/, /collapsable/, /config-template/,
  /state-switch/, /hui-element/, /swipe-card/, /fold-entity-row/, /template-entity-row/, /lovelace-text-input-row/,
  /slider-entity-row/, /paper-buttons-row/,
];
const BIG = 60 * 1024;
const SMALL = 40 * 1024;

const pathOf = (url) => String(url).split('?')[0].split('#')[0];
const kb = (n) => (n == null ? '?' : n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class LazyLovelacePanel extends HTMLElement {
  constructor() {
    super();
    this._data = null;
    this._filter = 'all';
    this._busy = false;
    this._msg = '';
    this.attachShadow({ mode: 'open' });
  }

  set hass(h) {
    const first = !this._hass;
    this._hass = h;
    if (first) this._load();
  }
  set narrow(n) { this._narrow = n; }
  set panel(p) { this._panel = p; }
  set route(r) { this._route = r; }
  connectedCallback() { this._render(); }

  // ---- data ------------------------------------------------------------------------------------------------
  async _head(url) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      const n = parseInt(r.headers.get('content-length') || '', 10);
      return Number.isFinite(n) ? n : null;
    } catch (e) { return null; }
  }

  async _dashboards() {
    const out = [];
    const list = await this._hass.callWS({ type: 'lovelace/dashboards/list' }).catch(() => []);
    const targets = [{ url_path: null, title: 'Overview' }, ...list];
    await Promise.all(targets.map(async (d) => {
      const cfg = await this._hass.callWS({ type: 'lovelace/config', url_path: d.url_path, force: false }).catch(() => null);
      if (cfg) out.push({ title: d.title || d.url_path || 'Overview', cfg });
    }));
    return out;
  }

  /** tag -> {views:Set, dashboards:Set, count, container, viewType} from `type: custom:<tag>` in every dashboard. */
  _usage(dashboards) {
    const used = new Map();
    const rec = (tag, dash, view, flags) => {
      if (!used.has(tag)) used.set(tag, { views: new Set(), dashboards: new Set(), count: 0, container: false, viewType: false, nested: new Set() });
      const u = used.get(tag);
      if (flags.parent) u.nested.add(flags.parent);
      u.views.add(`${dash} / ${view}`);
      u.dashboards.add(dash);
      u.count++;
      if (flags.container) u.container = true;
      if (flags.viewType) u.viewType = true;
    };
    const walk = (node, dash, view, parent) => {
      if (Array.isArray(node)) { node.forEach((n) => walk(n, dash, view, parent)); return; }
      if (!node || typeof node !== 'object') return;
      let next = parent;
      if (typeof node.type === 'string' && node.type.startsWith('custom:')) {
        const container = ['cards', 'card', 'tabs', 'elements', 'entities'].some((k) => node[k] && typeof node[k] === 'object' && JSON.stringify(node[k]).includes('"type"'));
        rec(node.type.slice(7), dash, view, { container, parent });
        if (container) next = node.type.slice(7);
      }
      for (const v of Object.values(node)) walk(v, dash, view, next);
    };
    for (const { title, cfg } of dashboards) {
      for (const v of cfg.views || []) {
        const name = v.title || v.path || '#';
        if (typeof v.type === 'string' && v.type.startsWith('custom:')) rec(v.type.slice(7), title, name, { viewType: true });
        walk(v, title, name);
      }
      for (const k of Object.keys(cfg)) if (k !== 'views') walk(cfg[k], title, '(templates)');
    }
    return used;
  }

  async _load() {
    this._busy = true; this._render();
    try {
      const [resources, state, dashboards] = await Promise.all([
        this._hass.callWS({ type: 'lovelace/resources' }),
        this._hass.callWS({ type: 'lazy_lovelace/get' }),
        this._dashboards(),
      ]);
      const used = this._usage(dashboards);
      const defs = (window.lazyLovelace && window.lazyLovelace.defs()) || {};
      const rows = [];
      const known = new Set();
      for (const r of resources) {
        const p = pathOf(r.url);
        if (p.includes('/lazy_lovelace_static/')) continue;
        known.add(p);
        rows.push({ path: p, url: r.url, type: r.type, lazy: false, tags: [], inline: String(r.url).startsWith('data:') });
      }
      for (const [p, e] of Object.entries(state.lazy)) {
        known.add(p);
        rows.push({ path: p, url: (e.resource && e.resource.url) || p, type: (e.resource && e.resource.type) || 'module', lazy: true, tags: e.tags });
      }
      // tags: from what the loader saw defined; chunks of a split card (same folder, not a resource) belong to the entry script
      const byDir = new Map();
      for (const r of rows) { const d = r.path.slice(0, r.path.lastIndexOf('/')); (byDir.get(d) || byDir.set(d, []).get(d)).push(r); }
      for (const r of rows) {
        if (r.lazy) continue;
        r.tags = [...(defs[r.path] || [])];
      }
      for (const [src, tags] of Object.entries(defs)) {
        if (known.has(src)) continue;
        const d = src.slice(0, src.lastIndexOf('/'));
        const owners = (byDir.get(d) || []).filter((r) => !r.lazy);
        if (owners.length === 1) owners[0].tags.push(...tags);
      }
      await Promise.all(rows.map(async (r) => {
        if (r.inline) r.size = Math.round(String(r.url).length * 0.75);
        else r.size = r.path.startsWith('/') ? await this._head(pathOf(r.url)) : null;
      }));
      for (const r of rows) this._classify(r, used, state.editable);
      rows.sort((a, b) => (b.size || 0) - (a.size || 0));
      this._data = { rows, used, editable: state.editable, dashboards: dashboards.length };
      this._msg = this._msg || '';
    } catch (e) {
      this._data = null;
      this._msg = 'Could not load: ' + (e && e.message ? e.message : JSON.stringify(e));
    }
    this._busy = false; this._render();
  }

  // ---- hints -----------------------------------------------------------------------------------------------
  _classify(r, used, editable) {
    const tags = [...new Set(r.tags)].sort();
    r.tags = tags;
    const usedTags = tags.filter((t) => used.has(t));
    const places = new Set(usedTags.flatMap((t) => [...used.get(t).views]));
    r.places = [...places];
    r.mapTags = [...new Set([
      ...usedTags,
      ...tags.filter((t) => /-(card|row|badge|element)$/.test(t)),
      ...usedTags.map((t) => t + '-editor').filter((t) => tags.includes(t)),
    ])].filter((t) => TAG_RE.test(t));
    const set = (hint, text, can) => { r.hint = hint; r.reason = text; r.can = can; };
    const integration = !r.path.startsWith('/local/') && !r.path.startsWith('/hacsfiles/');
    const note = integration ? ' It is served by an integration, which may register its resource again at start: Lazy Lovelace removes it again each time.' : '';
    if (r.lazy) return set('lazy', 'Lazy: imported when a card of this type is created. Not loaded on pages that do not use it.', true);
    if (!editable) return set('keep', 'Lovelace resources are managed in YAML mode: they cannot be changed here.', false);
    if (r.inline) return set('keep', 'An inline script stored in the resource itself: nothing to load lazily.', false);
    if (r.type !== 'module' && r.type !== 'js') return set('keep', 'Not a script (stylesheet or other): nothing to load lazily.', false);
    if (!r.path.startsWith('/')) return set('keep', 'An external URL: leave it.', false);
    if (KEEP_EAGER.some((re) => re.test(r.path))) {
      return set('keep', 'A plugin, library or container card: Home Assistant or other scripts need it before any card asks for it, or its children would have to wait for it.', true);
    }
    if (!tags.length) return set('unknown', 'No custom element was seen being defined by this script (it may load before the loader, or define nothing): cannot be made lazy safely.', false);
    if (usedTags.length === 0) {
      const cardLike = tags.some((t) => /-(card|row|panel|chart)$/.test(t));
      return cardLike ? set('unused', 'No dashboard uses its cards: making it lazy costs nothing (or remove the card).' + note, true)
        : set('keep', 'Defines helper elements only, no card is used from it: probably a library for other scripts.', true);
    }
    if (usedTags.some((t) => used.get(t).viewType)) return set('keep', 'Used as a view layout: needed when the view is built.', true);
    if (usedTags.some((t) => used.get(t).container)) return set('keep', 'A card that contains other cards: lazy children inside it can miss their data, and every view using it would wait for it.', true);
    const nested = [...new Set(usedTags.flatMap((t) => [...used.get(t).nested]))];
    if (r.size != null && r.size < SMALL) return set('small', 'Small: a lazy load costs an extra request and saves almost nothing.' + note, true);
    if (integration) return set('advanced', `${kb(r.size)} used in ${places.size} view(s).` + note + ' Try it, then open those views.', true);
    if (nested.length) {
      return set('caution', `${kb(r.size)} used in ${places.size} view(s), but inside ${nested.join(', ')}. Lazy cards nested in custom containers usually work; one case lost its data (tabbed-card): open those views after switching.`, true);
    }
    if (r.size != null && r.size >= BIG) return set('recommended', `Recommended: ${kb(r.size)} used in ${places.size} view(s), a plain card that nothing else depends on.`, true);
    return set('maybe', 'Medium size: a modest saving.', true);
  }

  // ---- actions ---------------------------------------------------------------------------------------------
  async _set(r, lazy) {
    await this._hass.callWS({ type: 'lazy_lovelace/set', path: r.path, lazy, tags: r.mapTags });
  }

  async _toggle(r) {
    if (r.lazy) {
      this._msg = '';
      await this._set(r, false);
      this._msg = `${r.path.split('/').pop()} is eager again. Reload the page.`;
    } else {
      if (['keep', 'caution', 'advanced'].includes(r.hint) && !confirm(`${r.reason}\n\nMake it lazy anyway?`)) return;
      this._msg = '';
      await this._set(r, true);
      this._msg = `${r.path.split('/').pop()} is lazy now (${r.mapTags.length} tags). Reload the page; the script loads when a card needs it.`;
    }
    await this._load();
  }

  async _applyRecommended() {
    const todo = this._data.rows.filter((r) => r.hint === 'recommended');
    if (!todo.length) return;
    const total = todo.reduce((a, r) => a + (r.size || 0), 0);
    if (!confirm(`Make ${todo.length} scripts lazy (${kb(total)} no longer loaded on every page)?\nYou can make any of them eager again from this list.`)) return;
    for (const r of todo) await this._set(r, true);
    this._msg = `${todo.length} scripts are lazy now. Reload the page.`;
    await this._load();
  }

  // ---- view ------------------------------------------------------------------------------------------------
  _render() {
    const css = `
      :host { display:block; background: var(--primary-background-color); color: var(--primary-text-color); min-height:100vh; font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
      header { display:flex; align-items:center; gap:12px; padding: 12px 16px; background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff); position:sticky; top:0; z-index:2; }
      header h1 { font-size:20px; font-weight:400; margin:0; flex:1; }
      main { max-width: 1200px; margin: 0 auto; padding: 16px; }
      .card { background: var(--card-background-color); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; box-shadow: var(--ha-card-box-shadow, none); border: 1px solid var(--divider-color); }
      .summary { display:flex; flex-wrap:wrap; gap: 24px; align-items:center; }
      .summary b { font-size: 22px; display:block; }
      .muted { color: var(--secondary-text-color); font-size: 13px; }
      .bar { display:flex; flex-wrap:wrap; gap:8px; margin: 10px 0; align-items:center; }
      button { font: inherit; cursor:pointer; border:1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); border-radius: 18px; padding: 6px 14px; }
      button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
      button.on { background: var(--primary-color); color: var(--text-primary-color,#fff); border-color: transparent; }
      button:disabled { opacity:.45; cursor:default; }
      .row { display:grid; grid-template-columns: minmax(150px,1.3fr) 70px minmax(160px,2fr) minmax(150px,1.6fr) 120px; gap: 12px; padding: 10px 6px; border-top: 1px solid var(--divider-color); align-items:start; }
      .row > * { min-width:0; }
      .row.head { font-size:12px; text-transform: uppercase; color: var(--secondary-text-color); border-top:none; }
      .name { font-weight:500; word-break: break-all; }
      .tags { font-size:12px; color: var(--secondary-text-color); word-break: break-word; }
      .pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:10px; color:#fff; margin-bottom:4px; }
      .recommended { background:#2e7d32; } .lazy { background: var(--primary-color); } .maybe { background:#7b8c3a; }
      .small { background:#8d8d8d; } .caution { background:#c47f17; } .advanced { background:#6a5acd; } .unused { background:#b58900; } .keep { background:#c0392b; } .unknown { background:#6b6b6b; }
      .why { font-size:12px; color: var(--secondary-text-color); }
      .msg { padding:10px 14px; border-radius:8px; background: var(--primary-color); color: var(--text-primary-color,#fff); margin-bottom:14px; }
      .warn { background:#b58900; }
      @media (max-width: 800px) { .row { grid-template-columns: 1fr 70px; } .row > :nth-child(n+3) { grid-column: 1 / -1; } .row.head { display:none; } }
    `;
    const d = this._data;
    let body = '';
    if (!window.lazyLovelace) body += `<div class="msg warn">The loader is not running in this page. Reload; if it persists, restart Home Assistant.</div>`;
    if (this._msg) body += `<div class="msg ${this._msg.startsWith('Could not') ? 'warn' : ''}">${esc(this._msg)}</div>`;
    if (this._busy && !d) body += `<div class="card">Reading resources, dashboards and file sizes…</div>`;
    if (d) {
      const eager = d.rows.filter((r) => !r.lazy), lazy = d.rows.filter((r) => r.lazy);
      const sum = (a) => a.reduce((s, r) => s + (r.size || 0), 0);
      const rec = d.rows.filter((r) => r.hint === 'recommended');
      const filters = { all: 'All', recommended: 'Recommended', lazy: 'Lazy', eager: 'Eager', keep: 'Keep eager', unused: 'Unused' };
      const shown = d.rows.filter((r) => ({ all: true, recommended: r.hint === 'recommended', lazy: r.lazy, eager: !r.lazy, keep: r.hint === 'keep', unused: r.hint === 'unused' }[this._filter]));
      body += `<div class="card"><div class="summary">
          <div><b>${eager.length}</b><span class="muted">eager scripts · ${kb(sum(eager))} on every page</span></div>
          <div><b>${lazy.length}</b><span class="muted">lazy scripts · ${kb(sum(lazy))} only when needed</span></div>
          <div><b>${rec.length}</b><span class="muted">recommended · ${kb(sum(rec))}</span></div>
          <div style="flex:1"></div>
          <button class="primary" id="applyrec" ${rec.length && d.editable ? '' : 'disabled'}>Make recommended lazy</button>
        </div>
        <div class="muted" style="margin-top:8px">Sizes are what the browser downloads (compressed when the file is served compressed). A change takes effect after a page reload.
        ${d.editable ? '' : '<br><b>Lovelace resources are in YAML mode: nothing can be changed here.</b>'}</div></div>`;
      body += `<div class="bar">${Object.entries(filters).map(([k, v]) => `<button data-f="${k}" class="${this._filter === k ? 'on' : ''}">${v}</button>`).join('')}
        <span style="flex:1"></span><button id="reload">Refresh</button></div>`;
      body += `<div class="card" style="padding:6px 10px"><div class="row head"><div>Script</div><div>Size</div><div>Cards</div><div>Used in</div><div></div></div>`;
      shown.forEach((r, i) => {
        const places = r.places && r.places.length ? r.places.slice(0, 4).map(esc).join('<br>') + (r.places.length > 4 ? `<br>+${r.places.length - 4} more` : '') : '<span class="muted">nowhere</span>';
        const tags = r.tags.length ? r.tags.slice(0, 8).map(esc).join(', ') + (r.tags.length > 8 ? ` +${r.tags.length - 8}` : '') : '—';
        const loaded = r.lazy && window.lazyLovelace && window.lazyLovelace.loaded().includes(r.path) ? ' · loaded in this page' : '';
        const label = r.lazy ? 'Make eager' : ['keep', 'caution', 'advanced'].includes(r.hint) ? 'Make lazy…' : 'Make lazy';
        body += `<div class="row"><div><div class="name">${esc(r.path.split('/').pop())}</div><div class="muted">${esc(r.path.replace(/\/[^/]*$/, ''))}</div></div>
          <div>${kb(r.size)}</div>
          <div class="tags">${tags}${r.lazy ? '' : ''}</div>
          <div class="tags">${places}</div>
          <div><span class="pill ${r.hint}">${{ recommended: 'recommended', lazy: 'lazy' + loaded, maybe: 'medium', small: 'small', unused: 'unused', keep: 'keep eager', unknown: 'unknown', caution: 'check after', advanced: 'advanced' }[r.hint]}</span>
            <div><button data-i="${i}" ${r.can && d.editable ? '' : 'disabled'}>${label}</button></div></div>
          <div class="why" style="grid-column:1/-1">${esc(r.reason)}</div></div>`;
      });
      body += `</div>`;
      this._shown = shown;
    }
    this.shadowRoot.innerHTML = `<style>${css}</style><header><h1>Lazy loading</h1></header><main>${body}</main>`;
    const q = (s) => this.shadowRoot.querySelector(s);
    this.shadowRoot.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { this._filter = b.dataset.f; this._render(); }));
    this.shadowRoot.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', async () => {
      const r = this._shown[Number(b.dataset.i)];
      try { await this._toggle(r); } catch (e) { this._msg = 'Could not change: ' + (e.message || JSON.stringify(e)); this._render(); }
    }));
    if (q('#reload')) q('#reload').addEventListener('click', () => this._load());
    if (q('#applyrec')) q('#applyrec').addEventListener('click', () => this._applyRecommended().catch((e) => { this._msg = 'Could not change: ' + (e.message || JSON.stringify(e)); this._render(); }));
  }
}

customElements.define('lazy-lovelace-panel', LazyLovelacePanel);
