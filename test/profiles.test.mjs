// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
import test from "node:test";
import assert from "node:assert/strict";
import { PROFILES, checkTable, describe, profileFor } from "../lib/profiles.js";
import { buildFrame } from "../lib/sound.js";
import { readFileSync } from "node:fs";

test("the table is well formed: unique catalog numbers, names a frame and the store take, values the radio accepts", () => {
	assert.deepEqual(checkTable(), []);
});

test("the ISS, SO-50 and AO-91 are the radio's built-in values (core/sat/sat_profile.c), the arming of SO-50 included", () => {
	assert.deepEqual(profileFor(25544), { norad: 25544, name: "ISS", up_hz: 145990000, down_hz: 437800000, up_tone: 670, arm_tone: 0, arm_ms: 0, armed_s: 0 });
	assert.deepEqual(profileFor(27607), { norad: 27607, name: "SO-50", up_hz: 145850000, down_hz: 436795000, up_tone: 670, arm_tone: 744, arm_ms: 2000, armed_s: 600 });
	assert.deepEqual(profileFor(43017), { norad: 43017, name: "AO-91", up_hz: 435250000, down_hz: 145960000, up_tone: 0, arm_tone: 0, arm_ms: 0, armed_s: 0 });
	assert.equal(profileFor(99999), null);
});

test("a profile is described the way a person reads it", () => {
	assert.equal(describe(profileFor(25544)), "up 145.990 MHz (67.0 Hz), down 437.800 MHz");
	assert.equal(describe(profileFor(27607)), "up 145.850 MHz (67.0 Hz), down 436.795 MHz, arm 74.4 Hz for 2 s, awake 10 min");
	assert.equal(describe(profileFor(43017)), "up 435.250 MHz, down 145.960 MHz");
	assert.equal(describe(profileFor(43678)), "up 437.500 MHz (141.3 Hz), down 145.900 MHz");
});

test("every profile in the table fits in a sound frame", () => {
	const V = JSON.parse(readFileSync(new URL("./sound_vectors.json", import.meta.url)));
	const g = V.good[0];
	for (const p of PROFILES) assert.notEqual(buildFrame(1, 0, 1, p.name, g.line1, g.line2, p), null, p.name);
});
