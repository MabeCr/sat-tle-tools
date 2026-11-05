// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Keeps the page's own files so it opens with no coverage. The element set download is not cached here: the page
// keeps the last one itself (app.js). Change CACHE when any file changes.
const CACHE = "sat-web-4";
const FILES = ["./", "index.html", "style.css", "app.js", "lib/bytes.js", "lib/frame.js", "lib/ftdi.js", "lib/link.js", "lib/sat.js", "lib/serial.js",
	"lib/tle.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
	if (new URL(e.request.url).origin !== location.origin) return;
	// the network first, so an update shows at once; the cache when there is none
	e.respondWith(fetch(e.request).then((r) => {
		const copy = r.clone();
		caches.open(CACHE).then((c) => c.put(e.request, copy));
		return r;
	}).catch(() => caches.match(e.request)));
});
