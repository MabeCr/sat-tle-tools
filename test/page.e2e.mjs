// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// The page in a real browser (Playwright's Chromium) with a Web Serial stand-in wired to the fake radio, at a phone's
// size. Not part of `node --test` (it needs Playwright and a browser): run `node test/page.e2e.mjs [screenshot.png]`.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const server = createServer(async (req, res) => {
	try {
		const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
		const file = path.endsWith("/") ? path + "index.html" : path;
		const body = await readFile(join(ROOT, file));
		res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
		res.end(body);
	} catch {
		res.writeHead(404).end();
	}
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
// the stand-in: a port whose streams talk to a FakeRadio in the page
await page.addInitScript(() => {
	window.__ready = (async () => {
		const { FakeRadio } = await import("/test/fakeradio.js");
		const V = await (await fetch("/test/vectors.json")).json();
		const radio = new FakeRadio({ store: V.store, clock: 0 });
		window.__radio = radio;
		window.__vectors = V;
		const port = {
			getInfo: () => ({ usbVendorId: 0x0403 }),
			open: async () => {},
			close: async () => {},
			readable: new ReadableStream({
				async pull(c) {
					for (;;) {
						if (radio.buf.length) { c.enqueue(radio.take(radio.buf.length)); return; }
						await new Promise((r) => setTimeout(r, 5));
					}
				},
			}),
			writable: new WritableStream({ write: (d) => radio.write(d) }),
		};
		Object.defineProperty(navigator, "serial", { value: { getPorts: async () => [], requestPort: async () => port, addEventListener() {} }, configurable: true });
	})();
});
await page.goto(url);
await page.evaluate(() => window.__ready);
const text = (sel) => page.locator(sel).innerText();

assert.equal(await page.locator("#unsupported").isHidden(), true);
await page.click("#connect-btn");
await page.waitForSelector("#stored-list .item");
assert.match(await text("#radio-info"), /Connected: FAKE/);
assert.equal(await page.locator("#stored-list .item").count(), 3);
assert.match(await text("#clock-radio"), /no time yet|has a time/);

// the clock
await page.click("#clock-btn");
await page.waitForFunction(() => window.__radio.clock > 1.7e9 && document.getElementById("clock-msg").textContent !== "");
assert.match(await text("#clock-msg"), /Radio clock set to 20\d\d-/);

// paste the sets and update
await page.click('.tabs button[data-src="paste"]');
await page.fill("#paste-text", await page.evaluate(() => window.__vectors.text));
await page.click("#paste-btn");
await page.waitForSelector("#sets-list .item");
assert.match(await text("#src-msg"), /3 element sets read/);
await page.fill("#add-norad", "44909");
await page.click("#add-btn");
assert.equal(await page.locator("#sets-list .item").count(), 4);
await page.click("#update-btn");
await page.waitForFunction(() => document.querySelectorAll("#progress li").length >= 4);
const progress = await text("#progress");
assert.match(progress, /ISS.*updated/);
assert.match(progress, /RS-44.*stored/);
assert.match(progress, /SO-50.*already current/);
assert.equal(await page.evaluate(() => window.__radio.rows.filter(Boolean).length), 4);
await page.screenshot({ path: process.argv[2] || "/tmp/sat-web-page.png", fullPage: true });

// delete one (the page asks first)
page.once("dialog", (d) => d.accept());
await page.locator("#stored-list .item button").first().click();
await page.waitForFunction(() => document.querySelectorAll("#stored-list .item").length === 3);

// diagnostics
await page.click("#diag-btn");
await page.waitForSelector("#diag-out:not([hidden])");
assert.match(await text("#diag-out"), /heap_min_free=15416/);
assert.match(await text("#diag-out"), /crash.valid=0/);

// a bad paste says so
await page.fill("#paste-text", "nothing here");
await page.click("#paste-btn");
assert.match(await text("#src-msg"), /No valid element sets/);

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log("page.e2e: ok");
