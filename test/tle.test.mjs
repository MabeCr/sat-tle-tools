// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checksum, catalog, epoch, parse, compare } from "../lib/tle.js";

const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url)));

test("check digits agree with the host tool", () => {
	for (const [line, want] of V.checksums) assert.equal(checksum(line), want, line);
});

test("catalog numbers, Alpha-5 included, agree with the host tool", () => {
	for (const [line, want] of V.catalogs) assert.equal(catalog(line), want, line.slice(0, 12));
	assert.ok(Number.isNaN(catalog("1 ?0001U" + " ".repeat(61))));
	assert.ok(Number.isNaN(catalog("1 2x001U" + " ".repeat(61))));
});

test("parse reads what the host tool reads", () => {
	const got = parse(V.text);
	assert.deepEqual([...got.keys()], V.parsed.map((p) => p.norad));
	for (const p of V.parsed) {
		const g = got.get(p.norad);
		assert.equal(g.name, p.name);
		assert.equal(g.l1, p.l1);
		assert.equal(g.l2, p.l2);
		assert.ok(Math.abs(g.epoch - p.epoch) < 1e-3, `epoch of ${p.norad}`);
	}
});

test("the newest set of a satellite wins, whichever comes first", () => {
	const got = parse(V.text);
	assert.equal(got.get(25544).l1, V.parsed.find((p) => p.norad === 25544).l1);
});

test("bad data gives nothing, as in the host tool", () => {
	for (const t of V.bad_texts) assert.equal(parse(t).size, 0, JSON.stringify(t.slice(0, 40)));
});

test("lines with CRLF endings and trailing spaces still parse", () => {
	assert.equal(parse(V.text.replace(/\n/g, "  \r\n")).size, V.parsed.length);
});

test("an epoch is the year's start plus the day of the year", () => {
	const l = V.parsed.find((p) => p.norad === 25544).l1;
	assert.ok(Math.abs(epoch(l) - (Date.UTC(2026, 0, 1) / 1000 + 306.51782528 * 86400)) < 1e-3);
	assert.ok(Number.isNaN(epoch("1 25544U 98067A   xx300.51782528")));
});

test("compare: new, newer, same, older, with the radio's one-second rounding", () => {
	const set = { epoch: 1000000 };
	assert.equal(compare(set, null), "new");
	assert.equal(compare(set, { elements: false, epoch: 0 }), "new");
	assert.equal(compare(set, { elements: true, epoch: 999000 }), "newer");
	assert.equal(compare(set, { elements: true, epoch: 1000000 }), "same");
	assert.equal(compare(set, { elements: true, epoch: 999999 }), "same");	// stored rounds down
	assert.equal(compare(set, { elements: true, epoch: 1000001 }), "same");
	assert.equal(compare(set, { elements: true, epoch: 1001000 }), "older");
});
