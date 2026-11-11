// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Where the element sets come from (lib/source.js): the first source that answers with usable sets wins, a failure
// falls through to the next, and a page that is not element sets, a bad status or silence all count as failures
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchSets, SAT_TLE_SOURCES } from "../lib/source.js";

const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url)));
const GOOD = V.text;	// three valid sets: the tests lower the minimum to match
const opts = (fetchFn) => ({ fetchFn, minSets: 3, timeoutMs: 50 });
const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
const status = (code) => ({ ok: false, status: code, text: async () => "", json: async () => ({}) });
const srcs = [{ id: "a", name: "A", url: "https://a/x" }, { id: "b", name: "B", url: "https://b/x", meta: "https://b/meta.json" }];

test("the first source that answers wins, and the second is not asked", async () => {
	const asked = [];
	const r = await fetchSets(srcs, opts(async (u) => { asked.push(u); return ok(GOOD); }));
	assert.equal(r.source.id, "a");
	assert.equal(r.text, GOOD);
	assert.deepEqual(asked, ["https://a/x"]);
	assert.equal(r.fetched, null);
});

test("a source that fails hands over to the next, and a mirror's date is read from its meta file", async () => {
	const r = await fetchSets(srcs, opts(async (u) => {
		if (u === "https://a/x") throw new TypeError("Failed to fetch");
		if (u === "https://b/x") return ok(GOOD);
		return ok(JSON.stringify({ fetched: "2026-11-11T06:23:00Z" }));
	}));
	assert.equal(r.source.id, "b");
	assert.equal(r.fetched, Date.UTC(2026, 10, 11, 6, 23, 0) / 1000);
});

test("a bad status, and an answer that is not element sets, fall through too", async () => {
	let r = await fetchSets(srcs, opts(async (u) => (u === "https://a/x" ? status(503) : ok(GOOD))));
	assert.equal(r.source.id, "b");
	r = await fetchSets(srcs, opts(async (u) => (u === "https://a/x" ? ok("<html>maintenance</html>") : ok(GOOD))));
	assert.equal(r.source.id, "b");
	assert.equal(r.fetched, null);	// no meta file: no date
});

test("silence is given up on after the timeout", async () => {
	const never = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted"))));
	const r = await fetchSets(srcs, opts(async (u, o) => (u === "https://a/x" ? never(u, o) : ok(GOOD))));
	assert.equal(r.source.id, "b");
});

test("when none works the error names each", async () => {
	await assert.rejects(fetchSets(srcs, opts(async (u) => { if (u === "https://a/x") throw new TypeError("Failed to fetch"); return status(404); })),
		/A: Failed to fetch; B: the server answered 404/);
});

test("the real list: CelesTrak, then this site's copy", () => {
	assert.deepEqual(SAT_TLE_SOURCES.map((s) => s.id), ["celestrak", "mirror"]);
	assert.ok(!/^https?:/.test(SAT_TLE_SOURCES[1].url));	// same origin: no cross-origin rules
});
