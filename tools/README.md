# Test rig

Headless Chrome (remote debugging on 127.0.0.1:9333) driven from Python (`aiohttp`).

```
chrome-headless-shell --no-sandbox --remote-debugging-port=9333 --window-size=1280,800 --user-data-dir=/tmp/rig about:blank &
HA_TOKEN=<long-lived token> BASE=http://127.0.0.1:8123 HA_CONFIG=/config python3 crawl.py before.json 5
# ... make scripts lazy ...
HA_TOKEN=... python3 crawl.py after.json 5
python3 compare.py before.json after.json
```

`crawl.py` logs in with the token, loads the first view, then switches views inside the app (fast) and records, per view, how many
custom elements of each type are on the page and any error cards. `compare.py` lists the views whose counts changed.
The scripts read the dashboards from `HA_CONFIG/.storage/lovelace*` and expect to run on the host (or in the Home Assistant container).
