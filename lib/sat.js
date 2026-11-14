// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// The radio's SAT command (docs/spec/debuglink.md 3.24) and the update loop of tools/rfoundry_debug.py (sat_update):
// the same rules, so a refresh never changes what a satellite is set up to do. link is a Link (lib/link.js).
import { concat, le16, le32, i16le, i32le, u16le, u32le, ascii, text, sleep } from "./bytes.js";
import { CMD, LinkError, ST_UNAVAILABLE } from "./link.js";
import { compare, SGP4_ERRORS, TLE_ERRORS } from "./tle.js";

export const OP = { TLE: 0, LOAD: 1, OBSERVER: 2, OBSERVER_GPS: 3, TIME: 4, LOOK: 5, PASS: 6, BENCH: 7, SAVE: 8, STORED: 9, RECALL: 10,
	DELETE: 11, CLEAR: 12, RETUNE_TEST: 13, RETUNE_RESULT: 14 };
export const TLE_CHUNK = 35;		// a line goes in two requests (a request holds 64 bytes)
const NAME_MAX = 11;

const op = (link, code, ...args) => link.request(CMD.SAT, concat(new Uint8Array([code]), ...args));

// Set the radio's UTC (until its next NMEA sentence, or the battery-backed clock where there is one), and with zoneMin
// (minutes from UTC, -720..+840 in steps of 15) its Time zone setting
export const setTime = (link, unixSeconds, zoneMin) => op(link, OP.TIME, le32(Math.floor(unixSeconds)), ...(zoneMin === undefined ? [] : [le16(zoneMin)]));

// This device's offset from UTC now, daylight saving included, in minutes to the nearest 15 (the radio keeps steps of 15);
// null when the radio's range doesn't hold it
export function zoneMinutes(date = new Date()) {
	const m = Math.round(-date.getTimezoneOffset() / 15) * 15 + 0;	// + 0: no negative zero
	return m >= -720 && m <= 840 ? m : null;
}

// "UTC-6", "UTC+5:45", "UTC": a zone as the radio shows it
export function zoneName(min) {
	if (min === 0) return "UTC";
	const a = Math.abs(min);
	return `UTC${min < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}

// The clock, and the zone when the device has one the radio can hold. A firmware from before the zone answers a bad
// argument (status 2) to the longer request: then the clock alone. Resolves to whether the zone was set
export async function setClock(link, unixSeconds, zoneMin = null) {
	if (zoneMin === null) {
		await setTime(link, unixSeconds);
		return false;
	}
	try {
		await setTime(link, unixSeconds, zoneMin);
		return true;
	} catch (e) {
		if (!(e instanceof LinkError) || e.status !== 2) throw e;
		await setTime(link, unixSeconds);
		return false;
	}
}

export async function load(link, l1, l2) {
	for (const [n, line] of [[1, l1], [2, l2]]) {
		if (line.length < 69) throw new LinkError(`TLE line ${n} is ${line.length} columns, not 69`);
		for (let off = 0; off < 69; off += TLE_CHUNK) await op(link, OP.TLE, new Uint8Array([n, off]), ascii(line.slice(off, Math.min(off + TLE_CHUNK, 69))));
	}
	const r = await op(link, OP.LOAD);
	return { tle: r[0], sgp4: r[1], norad: u32le(r, 2) };
}

// The loaded satellite into the store: with its own profile (p undefined), or with this one
export function save(link, p) {
	if (!p) return op(link, OP.SAVE);
	return op(link, OP.SAVE, le32(p.up_hz), le32(p.down_hz), le16(p.up_tone), le16(p.arm_tone), le16(p.arm_ms), le16(p.armed_s),
		ascii((p.name || "").slice(0, NAME_MAX)));
}

// The stored satellite with this catalog number as the loaded one (its elements; save() then writes it back with a profile)
export const recall = (link, norad) => op(link, OP.RECALL, le32(norad));

export const remove = (link, norad) => op(link, OP.DELETE, le32(norad));
export const clearAll = (link) => op(link, OP.CLEAR, le32(0x43544153));	// 'SATC'

export function decodeStored(r) {
	if (!r[0]) return null;
	return { norad: u32le(r, 1), elements: !!r[5], epoch: u32le(r, 6), up_hz: u32le(r, 10), down_hz: u32le(r, 14), up_tone: u16le(r, 18),
		arm_tone: u16le(r, 20), arm_ms: u16le(r, 22), armed_s: u16le(r, 24), name: text(r.subarray(26)) };
}

// Every stored satellite: [{slot, ...record}]
export async function list(link) {
	let slots;
	try {
		slots = Number((await link.view("sat")).kv["sat.slots"] || 0);
	} catch (e) {
		if (e instanceof LinkError && e.status === ST_UNAVAILABLE) return [];
		throw e;
	}
	const out = [];
	for (let slot = 0; slot < slots; slot++) {
		const rec = decodeStored(await op(link, OP.STORED, le16(slot)));
		if (rec) out.push({ slot, ...rec });
	}
	return out;
}

export async function bench(link, runs = 200) {
	const r = await op(link, OP.BENCH, le16(runs));
	return { runs: u16le(r, 0), us: u32le(r, 2) };
}

export function decodeLook(r) {
	return { az: u16le(r, 0) / 100, el: i16le(r, 2) / 100, range_km: u32le(r, 4) / 1000, range_rate: i32le(r, 8) / 1e6, rx_hz: u32le(r, 12),
		tx_hz: u32le(r, 16), us: u32le(r, 20) };
}

const why = (l) => (l.tle ? TLE_ERRORS[l.tle] : SGP4_ERRORS[l.sgp4]) ?? `error ${l.tle || l.sgp4}`;

// Bring the radio's stored satellites up to date from `tles` (tle.js parse): each stored one with a newer element set
// gets it, keeping its profile; the catalog numbers in `add` are stored if they aren't yet. Returns one result per
// satellite, in the order the Python tool lists them: {norad, label, outcome, detail, age_days} with outcome
// "updated", "stored", "current", "missing" (not in the data), "would" (dry run) or "failed". `choose`, when given,
// is a Set of catalog numbers: the rest are left as they are ("skipped"). `profile(norad)` gives the radio's own
// profile for a satellite that isn't stored (the page asks the radio's `sat.profile` key once a satellite is
// loaded): by default a new one is stored by its name with no frequencies, as the Python tool does when the radio
// has no profile for it. `profile(norad)`, when given, gives the profile the page has for a satellite (lib/profiles.js): it is
// written for a satellite that is new on the radio (ahead of the radio's own), and fills in one the radio holds with no frequencies
// at all; a profile with any frequency is the owner's, and is never replaced.
export async function update(link, tles, { add = [], dryRun = false, choose = null, now = Date.now() / 1000, profile = () => null, onResult = () => {} } = {}) {
	const stored = new Map((await list(link)).map((r) => [r.norad, r]));
	const todo = [...stored.values()].sort((a, b) => a.slot - b.slot).map((r) => ({ norad: r.norad, rec: r }));
	for (const n of add) if (!stored.has(n)) todo.push({ norad: n, rec: null });
	const results = [];
	const done = (r) => { results.push(r); onResult(r); };
	for (const { norad, rec } of todo) {
		const set = tles.get(norad);
		const label = (rec ? rec.name : (set?.name || "").slice(0, NAME_MAX)) || String(norad);
		if (!set) { done({ norad, label, outcome: "missing", detail: "not in the data: left as it is" }); continue; }
		if (choose && !choose.has(norad)) { done({ norad, label, outcome: "skipped", detail: "not chosen" }); continue; }
		const age = (now - set.epoch) / 86400;
		const prof = profile(norad);
		const fill = !!prof && !!rec && rec.up_hz === 0 && rec.down_hz === 0;	// held with no frequencies at all
		const newer = !rec || compare(set, rec) === "newer" || compare(set, rec) === "new";
		if (rec && !newer && !fill) {
			done({ norad, label, outcome: "current", detail: `already current (${((now - rec.epoch) / 86400).toFixed(1)} days old)`, age_days: (now - rec.epoch) / 86400 });
			continue;
		}
		if (dryRun) {
			done({ norad, label, outcome: "would", detail: newer ? `would update: new set ${age.toFixed(1)} days old` : "would fill in its frequencies", age_days: newer ? age : (now - rec.epoch) / 86400 });
			continue;
		}
		if (!newer) {	// the set the radio has is as good or better: only the frequencies go in, on its own elements
			try {
				await recall(link, norad);
				await save(link, { ...prof, name: rec.name || prof.name });
			} catch (e) {
				done({ norad, label, outcome: "failed", detail: `frequencies not written: ${e.message}` });
				continue;
			}
			done({ norad, label, outcome: "updated", detail: "frequencies filled in (its element set was current)", age_days: (now - rec.epoch) / 86400 });
			continue;
		}
		const l = await load(link, set.l1, set.l2);
		if (l.tle || l.sgp4 || l.norad !== norad) {
			done({ norad, label, outcome: "failed", detail: `not loaded: ${why(l)}` });
			continue;
		}
		if (rec) {
			await save(link, fill ? { ...prof, name: rec.name || prof.name } : rec);
		} else if (prof) {
			await save(link, prof);
		} else if (((await link.view("sat")).kv["sat.profile"] ?? "-") !== "-") {
			await save(link);
		} else {
			await save(link, { up_hz: 0, down_hz: 0, up_tone: 0, arm_tone: 0, arm_ms: 0, armed_s: 0, name: set.name });
		}
		done({ norad, label, outcome: rec ? "updated" : "stored", detail: `${rec ? "updated" : "stored"}: new set ${age.toFixed(1)} days old${prof && (!rec || fill) ? ", with its frequencies" : ""}`, age_days: age });
	}
	return results;
}

// --- the retune test (docs/dev/satellite-doppler-plan.md): receive only ---

export const RETUNE_STATES = ["none", "queued", "running", "done", "refused"];
export const RETUNE_WHY = ["", "the radio is busy (transmitting, or a hotspot)", "scanning or dual watch is on",
	"the radio is not on an FM channel or the VFO", "AM or broadcast receive is on", "a frequency the receiver won't take"];
const NEVER = 0xFFFFFFFF;

// Start it: base and step in Hz, count 1-32 retunes alternating base + step and base, gap_ms apart, 25 or 12.5 kHz
export function retuneStart(link, { base_hz, step_hz, count = 12, gap_ms = 150, wide = true }) {
	return op(link, OP.RETUNE_TEST, le32(base_hz), le32(step_hz | 0), new Uint8Array([count]), le16(gap_ms), new Uint8Array([wide ? 1 : 0]));
}

// {state, reason, count, ref_base, ref_step, noise_base, hops: [{call_us, settle_us (null: never), min_rssi, max_noise, lost}]}
export async function retuneResult(link) {
	const r = await op(link, OP.RETUNE_RESULT);
	const out = { state: RETUNE_STATES[r[0]] ?? String(r[0]), hops: [] };
	if (r.length > 1) {
		out.reason = r[1];
		out.count = r[2];
		out.ref_base = i16le(r, 3);
		out.ref_step = i16le(r, 5);
		out.noise_base = r[7];
		for (let i = 0; i < out.count; i++) {
			const o = 8 + i * 10, settle = u32le(r, o + 2);
			out.hops.push({ call_us: u16le(r, o), settle_us: settle === NEVER ? null : settle, min_rssi: i16le(r, o + 6), max_noise: r[o + 8], lost: r[o + 9] });
		}
	}
	return out;
}

// Start it and wait for the result: calls onState(state) while it runs. Throws a LinkError when it can't be started
export async function retuneTest(link, params, { onState = () => {}, timeout = 60000, poll = 300 } = {}) {
	await retuneStart(link, params);
	const until = Date.now() + timeout;
	for (;;) {
		await sleep(poll);
		const res = await retuneResult(link);
		onState(res.state);
		if (res.state === "done" || res.state === "refused") return res;
		if (Date.now() > until) throw new LinkError("the radio gave no result in time");
	}
}

// What a result says, for a person: {text, settled, never, min, max, median}
export function retuneSummary(res) {
	if (res.state === "refused") return { text: `Refused: ${RETUNE_WHY[res.reason] ?? res.reason}.` };
	const settled = res.hops.map((h) => h.settle_us).filter((x) => x !== null).sort((a, b) => a - b);
	const never = res.hops.length - settled.length;
	const dropped = res.hops.filter((h) => h.lost > 0 || h.min_rssi < Math.min(res.ref_base, res.ref_step) - 6).length;
	const ms = (us) => (us / 1000).toFixed(2);
	let text;
	if (!settled.length) text = `None of ${res.hops.length} retunes settled within the timeout.`;
	else {
		const median = settled[settled.length >> 1];
		text = `Settled in ${ms(settled[0])} to ${ms(settled.at(-1))} ms (median ${ms(median)} ms)` +
			`${never ? `; ${never} of ${res.hops.length} never did` : ""}. The signal dipped in ${dropped} of ${res.hops.length}.`;
	}
	return { text, settled: settled.length, never, dropped, min: settled[0], max: settled.at(-1), median: settled[settled.length >> 1] };
}
