// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAUD, GAP_MS, LEAD_MS, MARK_HZ, PREAMBLE_FLAGS, SPACE_HZ, buildFrame, cleanName, encode, fcs, frameTones, framesFor, hex, seconds, tleOk, tonesPacked, toWav } from "../lib/sound.js";

const V = JSON.parse(readFileSync(new URL("./sound_vectors.json", import.meta.url)));
const ISS = { name: "ISS (ZARYA)", l1: V.good[0].line1, l2: V.good[0].line2 };
const SO50 = { name: "SO-50", l1: V.good[1].line1, l2: V.good[1].line2 };

test("frames and their HDLC tone bits are the ones the firmware's C code and the Python sender make", () => {
	for (const g of V.good) {
		const f = buildFrame(g.id, g.index, g.count, g.name, g.line1, g.line2);
		assert.equal(hex(f), g.frame_hex, g.name);
		const tones = frameTones(f, 4, 2);
		assert.equal(tones.length, g.tone_bits);
		assert.equal(hex(tonesPacked(tones)), g.tones_hex);
	}
});

test("what no encoder may build a frame for is refused", () => {
	for (const r of V.refused) assert.equal(buildFrame(r.id, r.index, r.count, r.name, r.line1, r.line2), null, r.why);
	assert.equal(buildFrame(1, 0, 1, "café", ISS.l1, ISS.l2), null, "a name outside printable ASCII");
});

test("the FCS is the HDLC one", () => {
	// the standard check value of CRC-16/X.25 for "123456789"
	assert.equal(fcs(new TextEncoder().encode("123456789")), 0x906E);
});

test("a name is cleaned to what a frame carries", () => {
	assert.equal(cleanName("café SAT"), "caf? SAT");
	assert.equal(cleanName("  x  "), "x");
	assert.equal(cleanName(undefined), "");
	assert.equal(cleanName("N".repeat(40)).length, 24);
});

test("the chosen sets become frames in order, and what can't be sent is said", () => {
	const fs = framesFor([ISS, SO50], 9);
	assert.equal(fs.length, 2);
	assert.deepEqual([fs[0][2], fs[0][3], fs[0][4], fs[1][3]], [9, 0, 2, 1]);
	assert.throws(() => framesFor([], 0), /No satellites/);
	assert.throws(() => framesFor(Array(33).fill(ISS), 0), /32/);
	assert.throws(() => framesFor([{ name: "bad", l1: ISS.l1, l2: SO50.l2 }], 0), /can't be sent/);
	assert.ok(tleOk(ISS.l1, ISS.l2) && !tleOk(ISS.l1, SO50.l2) && !tleOk(ISS.l1.slice(0, 68), ISS.l2));
});

// A receiver for the test: for each bit window, the tone whose quadrature correlation is larger
function bitsOf(samples, start, nbits, rate) {
	const out = [];
	for (let k = 0; k < nbits; k++) {
		const s0 = start + Math.round((k * rate) / BAUD), s1 = start + Math.round(((k + 1) * rate) / BAUD);
		const e = (hz) => {
			let c = 0, s = 0;
			for (let i = s0; i < s1; i++) {
				const w = (2 * Math.PI * hz * (i - start)) / rate;
				c += samples[i] * Math.cos(w);
				s += samples[i] * Math.sin(w);
			}
			return c * c + s * s;
		};
		out.push(e(MARK_HZ) > e(SPACE_HZ) ? 1 : 0);
	}
	return out;
}

for (const rate of [48000, 44100, 8000]) {
	test(`the audio at ${rate} Hz carries the frames' tones, in the right places`, () => {
		const { samples, frames, seconds: secs } = encode([ISS, SO50], { id: 3, passes: 2, rate });
		assert.equal(frames, 4);
		assert.equal(samples.length, Math.round(secs * rate));
		const lead = Math.round((LEAD_MS * rate) / 1000);
		assert.ok(samples.slice(0, lead).every((x) => x === 0), "silence first");
		const fs = framesFor([ISS, SO50], 3);
		let at = lead;
		for (let p = 0; p < 2; p++) {
			if (p) at += Math.round(1000 * rate / 1000);
			for (const f of fs) {
				const want = frameTones(f);
				assert.deepEqual(bitsOf(samples, at, want.length, rate), want, `pass ${p} index ${f[3]}`);
				at += Math.round((want.length * rate) / BAUD) + Math.round((GAP_MS * rate) / 1000);
			}
		}
		assert.equal(at, samples.length, "the plan adds up to the whole audio");
		assert.ok(samples.every((x) => Math.abs(x) <= 0.6 + 1e-6), "no sample above the level");
	});
}

test("a frame fades in and out, and the baud rate is exact at 44.1 kHz", () => {
	const rate = 44100;
	const { samples } = encode([ISS], { id: 1, passes: 1, rate });
	const lead = Math.round((LEAD_MS * rate) / 1000);
	assert.ok(Math.abs(samples[lead]) < 0.01 && Math.abs(samples[lead + 5]) < 0.05, "starts quiet");
	const n = Math.round((frameTones(framesFor([ISS], 1)[0]).length * rate) / BAUD);
	assert.ok(Math.abs(samples[lead + n - 1]) < 0.05, "ends quiet");
	assert.ok(Math.max(...samples.slice(lead + 1000, lead + 2000).map(Math.abs)) > 0.5, "full level between");
	// the exact length: bits * rate / 1200, not bits * round(rate / 1200)
	assert.equal(n, Math.round((frameTones(framesFor([ISS], 1)[0]).length * 44100) / 1200));
});

test("the playing time is what the audio is, and 32 satellites take about 90 seconds", () => {
	assert.equal(seconds([ISS, SO50]), encode([ISS, SO50], { id: 0 }).seconds);
	const long = seconds(Array(32).fill({ name: "N".repeat(24), l1: ISS.l1, l2: ISS.l2 }));
	const short = seconds(Array(32).fill({ name: "SAT", l1: ISS.l1, l2: ISS.l2 }));
	assert.ok(short > 80 && short < 100 && long > short && long < 125, `${short.toFixed(0)} to ${long.toFixed(0)} seconds`);
	assert.ok(PREAMBLE_FLAGS === 30 && SPACE_HZ === 2200);
});

test("a WAV file holds the audio as 16 bit mono", () => {
	const { samples, rate } = encode([ISS], { id: 1, passes: 1, rate: 8000 });
	const w = toWav(samples, rate), v = new DataView(w.buffer);
	assert.equal(new TextDecoder().decode(w.slice(0, 4)) + new TextDecoder().decode(w.slice(8, 16)), "RIFFWAVEfmt ");
	assert.equal(w.length, 44 + samples.length * 2);
	assert.equal(v.getUint32(4, true), w.length - 8);
	assert.deepEqual([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)], [1, 1, 8000, 16]);
	assert.equal(v.getUint32(40, true), samples.length * 2);
	let peak = 0;
	for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(v.getInt16(44 + i * 2, true)));
	assert.ok(Math.abs(peak - 0.6 * 32767) < 40, `peak ${peak}`);
});
