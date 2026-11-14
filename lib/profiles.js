// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// What picking an FM satellite sets on the radio: uplink and downlink, the uplink's CTCSS tone, and the arming carrier of a
// repeater that sleeps until one wakes it. The same fields as the firmware's sat_profile_t (docs/spec/satellite.md 6) and the
// profile block of a version 2 sound frame. The page writes them with a satellite that is new on the radio, or held with no
// frequencies at all; the radio never replaces a profile that has any (what the owner set stays).
//
// The values are AMSAT's FM satellite list (https://www.amsat.org/live-fm-satellites/, updated October 31, 2026), each checked
// against SatNOGS DB's transmitter entries (https://db.satnogs.org, 2026-11-14). Satellites fail and new ones launch: check a
// row against both before trusting it, and change the date below with it. Not here: RS95S (QMR-KWT-2), whose catalog number is
// not confirmed; CAS-3H, IO-86 and the TEVEL2 satellites are as AMSAT and SatNOGS list them, working or not.
import { profileOk } from "./sound.js";

export const PROFILES_SOURCE = { list: "AMSAT FM satellite list, October 31, 2026", checked: "SatNOGS DB, 2026-11-14" };

// up_hz, down_hz in Hz; tones in Hz x 10 (670 = 67.0 Hz); arm_ms the arming carrier's length, armed_s how long the repeater stays awake
const row = (norad, name, up_hz, down_hz, up_tone = 0, arm_tone = 0, arm_ms = 0, armed_s = 0) =>
	({ norad, name, up_hz, down_hz, up_tone, arm_tone, arm_ms, armed_s });

export const PROFILES = [
	row(25544, "ISS", 145990000, 437800000, 670),
	row(27607, "SO-50", 145850000, 436795000, 670, 744, 2000, 600),	// sleeps until a 2 s carrier with 74.4 Hz wakes it for 10 minutes
	row(43017, "AO-91", 435250000, 145960000),			// no CTCSS any longer; in sunlight only
	row(61781, "AO-123", 145850000, 435400000, 670),		// ASRTU-1
	row(40908, "CAS-3H", 144350000, 437200000),			// LilacSat-2; its FM transponder has no set schedule
	row(40931, "IO-86", 145880000, 435880000, 885),			// LAPAN-A2
	row(43678, "PO-101", 437500000, 145900000, 1413),		// Diwata-2; the uplink is on 70 cm
	row(63217, "TEVEL2-1", 145970000, 436400000),
	row(63219, "TEVEL2-2", 145970000, 436400000),
	row(63218, "TEVEL2-3", 145970000, 436400000),
	row(63213, "TEVEL2-4", 145970000, 436400000),
	row(63214, "TEVEL2-5", 145970000, 436400000),
	row(63215, "TEVEL2-6", 145970000, 436400000),
	row(63238, "TEVEL2-7", 145970000, 436400000),
	row(63239, "TEVEL2-8", 145970000, 436400000),
	row(63237, "TEVEL2-9", 145970000, 436400000),
];

const byNorad = new Map(PROFILES.map((p) => [p.norad, p]));

// The profile for a catalog number, or null
export function profileFor(norad) {
	return byNorad.get(norad) ?? null;
}

export function checkTable() {
	const errors = [];
	const seen = new Set();
	for (const p of PROFILES) {
		if (seen.has(p.norad)) errors.push(`${p.name}: catalog number ${p.norad} twice`);
		seen.add(p.norad);
		if (!p.name || p.name.length > 11 || /[^ -~]/.test(p.name)) errors.push(`${p.name}: a name of 1 to 11 printable characters`);
		if (!profileOk(p)) errors.push(`${p.name}: a value out of range`);
		if (!p.up_hz && !p.down_hz) errors.push(`${p.name}: no frequency`);
		if (p.arm_tone ? !(p.arm_ms && p.armed_s) : (p.arm_ms || p.armed_s)) errors.push(`${p.name}: the arming tone, carrier time and awake time go together`);
	}
	return errors;
}

const mhz = (hz) => (hz / 1e6).toFixed(3);
const tone = (t) => (t / 10).toFixed(1);

// "up 145.990 MHz (67.0 Hz), down 437.800 MHz, arm 74.4 Hz for 2 s, awake 10 min"
export function describe(p) {
	const parts = [];
	if (p.up_hz) parts.push(`up ${mhz(p.up_hz)} MHz${p.up_tone ? ` (${tone(p.up_tone)} Hz)` : ""}`);
	if (p.down_hz) parts.push(`down ${mhz(p.down_hz)} MHz`);
	if (p.arm_tone) parts.push(`arm ${tone(p.arm_tone)} Hz for ${p.arm_ms / 1000} s, awake ${Math.round(p.armed_s / 60)} min`);
	return parts.join(", ");
}
