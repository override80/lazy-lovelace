"""Render every view of every dashboard in headless Chrome and record which custom elements appear and any error cards.
Run inside the HA container (needs aiohttp): HA_TOKEN=... python3 crawl.py <out.json> [wait_seconds]
Needs a headless Chrome on 127.0.0.1:9333 (see README.md). Compare two runs with compare.py."""
import asyncio, json, sys, glob, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from br import B
OUT = sys.argv[1]; WAIT = float(sys.argv[2]) if len(sys.argv) > 2 else 9
CFG = os.environ.get("HA_CONFIG", "/config")   # the Home Assistant config directory
def dashboards():
    items = json.load(open(f"{CFG}/.storage/lovelace_dashboards"))["data"]["items"]
    out = [("lovelace", "lovelace")] + [(i["url_path"], "lovelace." + i["id"]) for i in items]
    res = []; seen = set()
    for url, f in out:
        if url in seen: continue
        seen.add(url)
        p = f"{CFG}/.storage/{f}"
        if not os.path.exists(p): continue
        cfg = json.load(open(p))["data"]["config"]
        for n, v in enumerate(cfg.get("views", [])):
            res.append((url, v.get("path") or str(n)))
    only = os.environ.get('VIEWS')
    if only: res = [r for r in res if f'{r[0]}/{r[1]}' in only.split(',')]
    return res
def used_tags():
    tags = set()
    def walk(o):
        if isinstance(o, dict):
            t = o.get("type")
            if isinstance(t, str) and t.startswith("custom:"): tags.add(t[7:])
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    for f in glob.glob(f"{CFG}/.storage/lovelace.*"):
        walk(json.load(open(f)).get("data", {}).get("config", {}))
    return sorted(tags)
SCAN = """((TAGS)=>{const x_has=n=>{try{return !!(n.hass||n._hass||n.__hass||n._hass_)}catch(e){return false}};const tags=new Set(TAGS);const cnt={};const nh={};const errs=[];const st=[document.querySelector('home-assistant')];
while(st.length){const n=st.pop();if(!n)continue;const ln=n.localName;
if(ln){if(tags.has(ln)){cnt[ln]=(cnt[ln]||0)+1;if(x_has(n))nh[ln]=(nh[ln]||0)+1}
if(ln==='hui-error-card'||ln==='hui-error-entity-row'||ln==='hui-warning'){errs.push(((n.shadowRoot&&n.shadowRoot.textContent)||n.textContent||'').trim().slice(0,110))}}
if(n.shadowRoot)st.push(n.shadowRoot);if(n.children)for(const c of n.children)st.push(c)}
return JSON.stringify({cnt,nh,errs,h:document.querySelector('home-assistant').shadowRoot?1:0})})(%s)"""
async def main():
    tags = used_tags(); out = {}; first = True
    async with B() as b:
        await b.login()
        await b.call("Network.enable")
        for url, view in dashboards():
            b.events.clear()
            t0 = time.time()
            if first:
                await b.goto(f"/{url}/{view}", 20); first = False
            else:
                await b.ev("history.pushState(null,'',%s);window.dispatchEvent(new CustomEvent('location-changed'));0" % json.dumps(f"/{url}/{view}"))
                await asyncio.sleep(WAIT)
            r = json.loads(await b.ev(SCAN % json.dumps(tags)))
            js = [e for e in b.events if e.get("method") == "Network.requestWillBeSent" and e["params"].get("type") == "Script"]
            r["scripts"] = len(js); r["path"] = await b.ev("location.pathname")
            out[f"{url}/{view}"] = r
            print(f"{url}/{view}: {sum(r['cnt'].values())} custom els, {len(r['errs'])} errors, {len(js)} script reqs", flush=True)
    json.dump(out, open(OUT, "w"), indent=1)
asyncio.run(main())
