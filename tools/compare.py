"""Compare two crawl.py outputs: python3 compare.py before.json after.json. Prints views whose custom-element counts or error cards differ."""
import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2])); bad = 0
for k in a:
    x, y = a[k], b.get(k)
    if not y: print("MISSING", k); bad += 1; continue
    d = {t: (x["cnt"].get(t, 0), y["cnt"].get(t, 0)) for t in set(x["cnt"]) | set(y["cnt"]) if x["cnt"].get(t, 0) != y["cnt"].get(t, 0)}
    if d or len(y["errs"]) > len(x["errs"]):
        bad += 1; print(f"DIFF {k}: counts {d} | errors {len(x['errs'])} -> {len(y['errs'])} {y['errs'][:3]}")
    else: print(f"same {k}: {sum(y['cnt'].values())} els, scripts {x['scripts']} -> {y['scripts']}")
print("views differing:", bad)

# elements that exist but never got hass (only meaningful for cards that keep hass in .hass/_hass)
for k in b:
    pass
