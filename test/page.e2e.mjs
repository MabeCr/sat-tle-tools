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
const SETS = JSON.parse(await readFile(join(ROOT, "test/vectors.json"), "utf8")).text;
const celestrak = (route) => route.fulfill({ status: 200, contentType: "text/plain", body: SETS });
await page.route("https://celestrak.org/**", celestrak);
await page.goto(url);
await page.evaluate(() => window.__ready);
const text = (sel) => page.locator(sel).innerText();

assert.equal(await page.locator("#unsupported").isHidden(), true);

// 1 and 2 need no radio: the sets download when the page opens and every one is listed to choose from
await page.waitForSelector("#sets-list .item");
assert.match(await text("#src-msg"), /3 element sets read/);
assert.equal(await page.locator("#sets-list .item").count(), 3);
assert.equal(await page.locator("#sets-list input:checked").count(), 0);
assert.equal(await page.locator("#connect-btn").isVisible(), true);
assert.equal(await page.locator("#write").isHidden(), true);
// search and choose
await page.fill("#filter", "so-50");
assert.equal(await page.locator("#sets-list .item").count(), 1);
await page.fill("#filter", "44909");
assert.equal(await page.locator("#sets-list .item").count(), 1);
await page.check("#sets-list input");
assert.match(await text("#count"), /1 chosen/);
await page.fill("#filter", "");
await page.check("#only-picked");
assert.equal(await page.locator("#sets-list .item").count(), 1);
await page.uncheck("#only-picked");
// the preview, before any radio
await page.click("#preview summary");
assert.match(await text("#preview-list"), /RS-44.*inclination 82\.5°, period 113\.4 min, height about 13\d\d km.*stored, with no frequencies/s);

// 3: connect; the radio's satellites are listed (step 4) before anything is written, and its ISS (older data) starts ticked
await page.click("#connect-btn");
await page.waitForSelector("#stored-list .item");
assert.match(await text("#radio-info"), /Connected: FAKE/);
assert.equal(await page.locator("#stored-list .item").count(), 3);
assert.match(await text("#clock-radio"), /no time yet|has a time/);
assert.equal(await page.evaluate(() => window.__radio.rows.filter(Boolean).length), 3);
assert.match(await text("#count"), /\d+ of 32 places/);
const ticked = await page.locator("#sets-list .item:has(input:checked) .name").allInnerTexts();
assert.ok(ticked.some((t) => /ISS/.test(t)) && ticked.some((t) => /RS-44/.test(t)), ticked.join("|"));
assert.ok(!ticked.some((t) => /SO-50/.test(t)));

// write: the clock goes too (the box is ticked), then the chosen sets
await page.click("#update-btn");
await page.waitForFunction(() => /Done:|Nothing needed|failed/.test(document.getElementById("progress").textContent));
const progress = await text("#progress");
assert.match(progress, /Radio clock set to 20\d\d-/);
// the device's time zone went with the clock (the browser's own: whatever it is here)
assert.equal(await page.evaluate(() => window.__radio.zone), await page.evaluate(() => Math.round(-new Date().getTimezoneOffset() / 15) * 15 + 0));
assert.match(progress, /time zone UTC/);
assert.match(progress, /ISS.*updated/);
assert.match(progress, /RS-44.*stored/);
assert.doesNotMatch(progress, /SO-50/);
assert.match(progress, /Done: 2 written/);
assert.ok(await page.evaluate(() => window.__radio.clock) > 1.7e9);
assert.equal(await page.evaluate(() => window.__radio.rows.filter(Boolean).length), 4);
assert.equal(await page.locator("#stored-list .item").count(), 4);
await page.screenshot({ path: process.argv[2] || "/tmp/sat-web-page.png", fullPage: true });

// the clock alone, with nothing chosen
await page.click("#clear-btn");
assert.match(await text("#count"), /0 chosen/);
await page.uncheck("#clock-too");
assert.equal(await page.locator("#update-btn").isDisabled(), true);
await page.check("#clock-too");
await page.click("#clock-btn");
await page.waitForFunction(() => document.getElementById("clock-msg").textContent.startsWith("Radio clock set"));

// delete one (the page asks first)
page.once("dialog", (d) => d.accept());
await page.locator("#stored-list .item button").first().click();
await page.waitForFunction(() => document.querySelectorAll("#stored-list .item").length === 3);

// the advanced part: diagnostics
await page.click("#advanced summary");
await page.click("#diag-btn");
await page.waitForSelector("#diag-out:not([hidden])");
assert.match(await text("#diag-out"), /heap_min_free=15416/);
assert.match(await text("#diag-out"), /crash.valid=0/);

// the retune test, with a frequency of the user's choosing
await page.fill("#rt-freq", "162.475");
await page.fill("#rt-count", "3");
await page.fill("#rt-gap", "30");
await page.click("#rt-btn");
await page.waitForSelector("#rt-out:not([hidden])");
assert.match(await text("#rt-msg"), /Settled in/);
assert.match(await text("#rt-out"), /162\.475 MHz, step 2 kHz, 3 retunes 30 ms apart, 25 kHz wide/);
assert.equal(await page.evaluate(() => [...window.__radio.calls.find((c) => c.op === 13).args.slice(0, 4)].reduce((a, b, i) => a + b * 2 ** (8 * i), 0)), 162475000);
await page.fill("#rt-count", "40");
await page.click("#rt-btn");
assert.match(await text("#rt-msg"), /Retunes: 1 to 32/);

// a bad paste says so
await page.click('.tabs button[data-src="paste"]');
await page.fill("#paste-text", "nothing here");
await page.click("#paste-btn");
assert.match(await text("#src-msg"), /No valid element sets/);

assert.deepEqual(errors, []);

// On an Android phone: Web Serial doesn't list an FTDI cable, so the first button is the WebUSB one
{
	const phone = await browser.newPage({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36", viewport: { width: 390, height: 844 } });
	const phoneErrors = [];
	phone.on("pageerror", (e) => phoneErrors.push(e.message));
	await phone.addInitScript(() => {
		window.__ready = (async () => {
			const { FakeRadio } = await import("/test/fakeradio.js");
			const { FakeFtdi } = await import("/test/fakeftdi.js");
			const V = await (await fetch("/test/vectors.json")).json();
			const radio = new FakeRadio({ store: V.store, clock: 0 });
			const dev = new FakeFtdi(radio);
			window.__radio = radio;
			window.__dev = dev;
			const usb = new EventTarget();
			usb.getDevices = async () => [];
			usb.requestDevice = async (o) => { window.__filters = o.filters; return dev; };
			Object.defineProperty(navigator, "usb", { value: usb, configurable: true });
			Object.defineProperty(navigator, "serial", { value: { getPorts: async () => [], requestPort: async () => { throw new DOMException("no port", "NotFoundError"); }, addEventListener() {} }, configurable: true });
		})();
	});
	await phone.route("https://celestrak.org/**", celestrak);
	await phone.goto(url);
	await phone.evaluate(() => window.__ready);
	assert.equal(await phone.locator("#connect-btn").innerText(), "Connect radio (USB cable)");
	assert.equal(await phone.locator("#connect-alt-btn").innerText(), "Other serial port");
	await phone.click("#connect-btn");
	await phone.waitForSelector("#stored-list .item");
	assert.match(await phone.locator("#radio-info").innerText(), /Connected: FAKE/);
	assert.deepEqual(await phone.evaluate(() => window.__filters), [{ vendorId: 0x0403 }]);
	assert.equal(await phone.evaluate(() => window.__dev.controls.length), 7);
	// no cable chosen: the hint appears
	await phone.click("#disconnect-btn");
	await phone.evaluate(() => { navigator.usb.requestDevice = async () => { throw new DOMException("none", "NotFoundError"); }; });
	await phone.click("#connect-btn");
	await phone.waitForSelector("#connect-help:not([hidden])");
	assert.deepEqual(phoneErrors, []);
	await phone.close();
}
// CelesTrak down: this site's copy stands in, with its age; and with both down the message says what to do
{
	const fb = await browser.newPage({ viewport: { width: 390, height: 844 } });
	await fb.route("https://celestrak.org/**", (r) => r.abort());
	await fb.route("**/tle/amateur.txt", celestrak);
	await fb.route("**/tle/mirror.json", (r) => r.fulfill({ status: 200, contentType: "application/json",
		body: JSON.stringify({ fetched: new Date(Date.now() - 3 * 3600e3).toISOString(), source: "AMSAT" }) }));
	await fb.goto(url);
	await fb.waitForSelector("#sets-list .item");
	assert.match(await fb.locator("#src-msg").innerText(), /3 element sets read \(CelesTrak could not be reached: this site's copy from AMSAT, taken 3 hours ago\)/);
	await fb.close();
	const none = await browser.newPage({ viewport: { width: 390, height: 844 } });
	await none.route("https://celestrak.org/**", (r) => r.abort());
	await none.route("**/tle/amateur.txt", (r) => r.fulfill({ status: 404, body: "not found" }));
	await none.goto(url);
	await none.waitForFunction(() => /Couldn't download/.test(document.getElementById("src-msg").textContent));
	const msg = await none.locator("#src-msg").innerText();
	assert.match(msg, /CelesTrak: .*; this site's copy: the server answered 404/);
	assert.match(msg, /Paste the text or choose a file/);
	assert.equal(await none.locator("#choose").isHidden(), true);
	await none.close();
}
await browser.close();
server.close();
console.log("page.e2e: ok");
