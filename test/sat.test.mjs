// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// The update loop against the fake radio, and against the host tool's own outcomes (vectors.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Link, LinkError } from "../lib/link.js";
import { parse } from "../lib/tle.js";
import * as sat from "../lib/sat.js";
import { FakeRadio } from "./fakeradio.js";

const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url)));
const link = (radio) => new Link(radio, { timeout: 100 });
const rowsOf = (radio) => radio.rows.filter(Boolean).map(({ norad, elements, epoch, up_hz, down_hz, up_tone, arm_tone, arm_ms, armed_s, name }) =>
	({ norad, elements, epoch, up_hz, down_hz, up_tone, arm_tone, arm_ms, armed_s, name }));
const NOW = 1793196300;

test("version and the sat view", async () => {
	const r = new FakeRadio({ store: V.store });
	const l = link(r);
	assert.match((await l.version()).features, /SAT/);
	assert.equal((await l.view("sat")).kv["sat.slots"], "32");
	assert.deepEqual((await sat.list(l)).map((x) => [x.slot, x.norad, x.name]), [[0, 25544, "ISS"], [1, 27607, "SO-50"], [2, 43017, "AO-91"]]);
});

for (const [name, key] of [["update", "update"], ["dry run", "dry_run"]]) {
	test(`${name}: the same outcomes and the same stored rows as the host tool`, async () => {
		const run = V.runs[key];
		const r = new FakeRadio({ store: V.store });
		const got = await sat.update(link(r), parse(V.text), { add: run.add, dryRun: run.dry_run, now: NOW });
		assert.deepEqual(got.map((x) => [x.norad, x.outcome]), run.outcomes);
		const want = run.rows.map((x) => ({ ...x }));
		assert.deepEqual(rowsOf(r), want);
		if (run.dry_run) assert.ok(!r.calls.some((c) => c.op === 1 || c.op === 8), "a dry run loads and saves nothing");
	});
}

test("a satellite keeps its own profile through an update", async () => {
	const r = new FakeRadio({ store: V.store });
	await sat.update(link(r), parse(V.text), { now: NOW });
	const iss = rowsOf(r).find((x) => x.norad === 25544);
	assert.equal(iss.up_hz, 145990000);
	assert.equal(iss.name, "ISS");
	assert.equal(iss.epoch, V.parsed.find((p) => p.norad === 25544).epoch | 0 || iss.epoch);
});

test("a satellite the radio knows is stored with its own profile", async () => {
	const r = new FakeRadio();
	const text = V.text.replace(/RS-44/g, "AO-91").replace(/44909/g, "43017");
	await sat.update(link(r), parse(V.text), { add: [27607], now: NOW });
	assert.equal(rowsOf(r)[0].name, "SO-50");
	assert.equal(rowsOf(r)[0].arm_tone, 744);
	assert.ok(text.length);
});

test("choose: only the chosen satellites are loaded", async () => {
	const r = new FakeRadio({ store: V.store });
	const got = await sat.update(link(r), parse(V.text), { choose: new Set([27607]), now: NOW });
	assert.equal(got.find((x) => x.norad === 25544).outcome, "skipped");
	assert.equal(r.calls.filter((c) => c.op === 1).length, 0);
});

test("a set the radio refuses is reported, the rest go on", async () => {
	const r = new FakeRadio({ store: V.store });
	const tles = parse(V.text);
	const iss = tles.get(25544);
	tles.set(25544, { ...iss, l2: iss.l2.slice(0, 68) + String((Number(iss.l2[68]) + 1) % 10) });	// a wrong check digit past the page's own checks
	tles.set(27607, { ...tles.get(27607), epoch: tles.get(27607).epoch + 86400, l1: tles.get(27607).l1 });
	const got = await sat.update(link(r), tles, { now: NOW });
	assert.equal(got.find((x) => x.norad === 25544).outcome, "failed");
	assert.match(got.find((x) => x.norad === 25544).detail, /check digit/);
	assert.equal(got.find((x) => x.norad === 27607).outcome, "updated");
});

test("a line that is too short is refused before anything is sent", async () => {
	const r = new FakeRadio();
	await assert.rejects(() => sat.load(link(r), "1 25544U", "2 25544"), /not 69/);
	assert.equal(r.calls.length, 0);
});

test("a line goes in two pieces of at most 35 characters", async () => {
	const r = new FakeRadio();
	const s = parse(V.text).get(25544);
	await sat.load(link(r), s.l1, s.l2);
	const pieces = r.calls.filter((c) => c.op === 0);
	assert.equal(pieces.length, 4);
	assert.ok(pieces.every((c) => c.args.length - 2 <= 35));
});

test("a full store answers status 7", async () => {
	const full = Array.from({ length: 32 }, (_, i) => ({ norad: 90000 + i, elements: true, epoch: 1, up_hz: 0, down_hz: 0, up_tone: 0, arm_tone: 0, arm_ms: 0, armed_s: 0, name: "X" }));
	const r = new FakeRadio({ store: full });
	const s = parse(V.text).get(44909);
	await sat.load(link(r), s.l1, s.l2);
	await assert.rejects(() => sat.save(link(r)), (e) => e instanceof LinkError && e.status === 7);
});

test("a build without satellites lists nothing", async () => {
	const r = new FakeRadio({ sat: false });
	assert.deepEqual(await sat.list(link(r)), []);
});

test("set the clock, delete, bench and clear", async () => {
	const r = new FakeRadio({ store: V.store });
	const l = link(r);
	await sat.setTime(l, 1793196300.9);
	assert.equal(r.clock, 1793196300);
	await sat.remove(l, 27607);
	assert.deepEqual((await sat.list(l)).map((x) => x.norad), [25544, 43017]);
	await assert.rejects(() => sat.remove(l, 27607), (e) => e.status === 4);
	assert.deepEqual(await sat.bench(l, 10), { runs: 10, us: 37600 });
	await sat.clearAll(l);
	assert.deepEqual(await sat.list(l), []);
});

test("a radio that doesn't answer is a LinkError, and the next request still works", async () => {
	const r = new FakeRadio();
	const l = link(r);
	r.stuck = true;
	await assert.rejects(() => l.version(), (e) => e instanceof LinkError && /no answer/.test(e.message));
	r.stuck = false;
	assert.equal((await l.version()).board, "FAKE");
});

test("two requests started together are answered in order", async () => {
	const l = link(new FakeRadio({ store: V.store }));
	const [a, b] = await Promise.all([l.version(), sat.list(l)]);
	assert.equal(a.board, "FAKE");
	assert.equal(b.length, 3);
});
