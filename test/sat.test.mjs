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
	assert.ok((await l.version()).features.split(/[\s,]+/).includes("SAT"), "SAT is one of the comma separated features");
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

test("a profile the page has is written for a satellite that is new, ahead of the radio's own", async () => {
	const r = new FakeRadio();
	const tles = parse(V.text);
	const mine = { norad: 27607, name: "SO-50", up_hz: 145850000, down_hz: 436795000, up_tone: 670, arm_tone: 744, arm_ms: 2000, armed_s: 600 };
	const got = await sat.update(link(r), tles, { add: [27607, 25544], now: NOW, profile: (n) => (n === 27607 ? mine : null) });
	const so = rowsOf(r).find((x) => x.norad === 27607);
	assert.deepEqual([so.up_hz, so.down_hz, so.up_tone, so.arm_tone, so.arm_ms, so.armed_s, so.name], [145850000, 436795000, 670, 744, 2000, 600, "SO-50"]);
	assert.match(got.find((x) => x.norad === 27607).detail, /with its frequencies/);
	assert.equal(rowsOf(r).find((x) => x.norad === 25544).up_hz, 145990000, "one with no profile of the page's gets the radio's own");
});

test("a satellite held with no frequencies gets them, the elements as they are; one with frequencies keeps them", async () => {
	const tles = parse(V.text);
	const empty = { up_hz: 0, down_hz: 0, up_tone: 0, arm_tone: 0, arm_ms: 0, armed_s: 0 };
	const r = new FakeRadio({ store: [{ norad: 25544, elements: true, epoch: Math.round(tles.get(25544).epoch), ...empty, name: "ISS" },
		{ norad: 27607, elements: true, epoch: Math.round(tles.get(27607).epoch), up_hz: 145999000, down_hz: 436795000, up_tone: 0, arm_tone: 0, arm_ms: 0, armed_s: 0, name: "MINE" }] });
	const prof = (n) => ({ norad: n, name: n === 25544 ? "ISS" : "SO-50", up_hz: 145990000, down_hz: 437800000, up_tone: 670, arm_tone: 0, arm_ms: 0, armed_s: 0 });
	const got = await sat.update(link(r), tles, { now: NOW, profile: prof });
	const iss = rowsOf(r).find((x) => x.norad === 25544), so = rowsOf(r).find((x) => x.norad === 27607);
	assert.equal(got.find((x) => x.norad === 25544).outcome, "updated");
	assert.deepEqual([iss.up_hz, iss.down_hz, iss.up_tone, iss.name], [145990000, 437800000, 670, "ISS"]);
	assert.equal(iss.epoch, Math.round(tles.get(25544).epoch), "its elements are as they were");
	assert.equal(r.calls.filter((c) => c.op === 1).length, 0, "no set was loaded for it");
	assert.equal(got.find((x) => x.norad === 27607).outcome, "current");
	assert.deepEqual([so.up_hz, so.name], [145999000, "MINE"], "the owner's profile stays");
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

test("a zone with the clock: the setting is written, and a firmware from before it gets the clock alone", async () => {
	const r = new FakeRadio({ store: V.store });
	assert.equal(await sat.setClock(link(r), 1793196300, -360), true);
	assert.equal(r.clock, 1793196300);
	assert.equal(r.zone, -360);
	const old = new FakeRadio({ store: V.store, noZone: true });
	assert.equal(await sat.setClock(link(old), 1793196400, 330), false);
	assert.equal(old.clock, 1793196400);
	assert.equal(old.zone, null);
	assert.equal(await sat.setClock(link(r), 1793196500, null), false);	// no zone to send: the clock alone, the setting stays
	assert.equal(r.clock, 1793196500);
	assert.equal(r.zone, -360);
	// the radio refuses one off its grid (the page rounds to 15 minutes first): that is no reason to fall back, it is an error
	await assert.rejects(() => sat.setTime(link(r), 1793196600, 100), (e) => e.status === 2);
	assert.equal(r.zone, -360);
});

test("the device's zone: minutes to the nearest 15, daylight saving as the date says", () => {
	const at = (off) => ({ getTimezoneOffset: () => off });	// JS: minutes to add to local time to get UTC
	assert.equal(sat.zoneMinutes(at(360)), -360);	// UTC-6
	assert.equal(sat.zoneMinutes(at(300)), -300);	// UTC-5, the same place in summer
	assert.equal(sat.zoneMinutes(at(-345)), 345);	// Nepal
	assert.equal(sat.zoneMinutes(at(0)), 0);
	assert.equal(sat.zoneMinutes(at(-1000)), null);	// past +14:00
	assert.equal(sat.zoneName(-360), "UTC-6");
	assert.equal(sat.zoneName(345), "UTC+5:45");
	assert.equal(sat.zoneName(0), "UTC");
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

test("the retune test: started, polled and summarized", async () => {
	const r = new FakeRadio();
	const l = link(r);
	assert.deepEqual((await sat.retuneResult(l)).hops, []);
	assert.equal((await sat.retuneResult(l)).state, "none");
	const states = [];
	const res = await sat.retuneTest(l, { base_hz: 162400000, step_hz: 2000, count: 4, gap_ms: 100, wide: true }, { poll: 5, onState: (s) => states.push(s) });
	assert.equal(res.state, "done");
	assert.equal(res.count, 4);
	assert.equal(res.ref_base, -70);
	assert.equal(res.ref_step, -73);
	assert.equal(res.noise_base, 20);
	assert.deepEqual(res.hops.map((h) => h.settle_us), [600, 610, 620, 630]);
	assert.deepEqual(res.hops[0], { call_us: 40, settle_us: 600, min_rssi: -100, max_noise: 90, lost: 3 });
	const sum = sat.retuneSummary(res);
	assert.match(sum.text, /Settled in 0\.60 to 0\.63 ms \(median 0\.62 ms\)/);
	assert.match(sum.text, /dipped in 4 of 4/);
	assert.equal(sum.never, 0);
	const call = r.calls.find((c) => c.op === 13);
	assert.deepEqual([...call.args].slice(0, 8), [0, 7, 174, 9, 208, 7, 0, 0]);	// 162,400,000 and 2000, little endian
	assert.equal(call.args[8], 4);	// the count
});

test("the retune test: a retune that never settles, and a refusal", async () => {
	const r = new FakeRadio();
	r.retuneNeverAt = 1;
	const res = await sat.retuneTest(link(r), { base_hz: 162400000, step_hz: -1500, count: 3, gap_ms: 50, wide: false }, { poll: 5 });
	assert.deepEqual(res.hops.map((h) => h.settle_us), [600, null, 620]);
	assert.match(sat.retuneSummary(res).text, /1 of 3 never did/);
	const r2 = new FakeRadio();
	r2.retuneRefuse = true;
	r2.retuneWhy = 3;
	const ref = await sat.retuneTest(link(r2), { base_hz: 162400000, step_hz: 2000, count: 4, gap_ms: 100 }, { poll: 5 });
	assert.equal(ref.state, "refused");
	assert.equal(sat.retuneSummary(ref).text, "Refused: the radio is not on an FM channel or the VFO.");
});

test("the retune test: arguments the radio refuses are errors", async () => {
	const l = link(new FakeRadio());
	await assert.rejects(() => sat.retuneStart(l, { base_hz: 162400000, step_hz: 2000, count: 0, gap_ms: 100 }), (e) => e.status === 2);
	await assert.rejects(() => sat.retuneStart(l, { base_hz: 162400000, step_hz: 0, count: 4, gap_ms: 100 }), (e) => e.status === 2);
	await assert.rejects(() => sat.retuneStart(l, { base_hz: 162400000, step_hz: 2000, count: 32, gap_ms: 1000 }), (e) => e.status === 2);
});
