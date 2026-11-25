import asyncio, json, aiohttp, os, sys, time
TOKEN = os.environ["HA_TOKEN"].replace("Bearer ", "")
BASE = os.environ.get("BASE", "http://127.0.0.1:8123")
class B:
    async def __aenter__(self):
        self.s = aiohttp.ClientSession()
        r = await (await self.s.put("http://127.0.0.1:9333/json/new?about:blank")).json()
        self.ws = await self.s.ws_connect(r["webSocketDebuggerUrl"], max_msg_size=0)
        self.n = 0; self.events = []; self.id = r["id"]
        self.task = asyncio.create_task(self._pump()); self.waiters = {}
        return self
    async def _pump(self):
        async for m in self.ws:
            d = json.loads(m.data)
            if "id" in d and d["id"] in self.waiters: self.waiters.pop(d["id"]).set_result(d)
            else: self.events.append(d)
    async def call(self, method, params=None, t=120):
        self.n += 1; i = self.n; f = asyncio.get_event_loop().create_future(); self.waiters[i] = f
        await self.ws.send_json({"id": i, "method": method, "params": params or {}})
        return (await asyncio.wait_for(f, t)).get("result", {})
    async def ev(self, expr, t=60):
        r = await self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, t)
        if "exceptionDetails" in r: return "EXC:" + json.dumps(r["exceptionDetails"])[:300]
        return r.get("result", {}).get("value")
    async def login(self, init_script=None):
        await self.call("Page.enable"); await self.call("Runtime.enable")
        await self.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 2000, "deviceScaleFactor": 1, "mobile": False})
        await self.call("Page.navigate", {"url": BASE + "/manifest.json"}); await asyncio.sleep(1)
        tok = json.dumps({"access_token": TOKEN, "token_type": "Bearer", "expires_in": 1800, "hassUrl": BASE, "clientId": BASE + "/", "expires": 4102444800000, "refresh_token": "x"})
        await self.ev("localStorage.setItem('hassTokens', %s); localStorage.setItem('selectedLanguage','\"en\"')" % json.dumps(tok))
        if init_script: await self.call("Page.addScriptToEvaluateOnNewDocument", {"source": init_script})
    async def goto(self, path, wait=20):
        await self.call("Page.navigate", {"url": BASE + path}); await asyncio.sleep(wait)
    async def __aexit__(self, *a):
        try: await self.s.get("http://127.0.0.1:9333/json/close/" + self.id)
        except Exception: pass
        await self.s.close()
