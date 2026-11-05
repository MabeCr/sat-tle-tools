// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// The radio's SAT command (docs/spec/debuglink.md 3.24) and the update loop of tools/rfoundry_debug.py (sat_update):
// the same rules, so a refresh never changes what a satellite is set up to do. link is a Link (lib/link.js).
import { concat, le16, le32, i16le, i32le, u16le, u32le, ascii, text } from "./bytes.js";
import { CMD, LinkError, ST_UNAVAILABLE } from "./link.js";
import { compare, SGP4_ERRORS, TLE_ERRORS } from "./tle.js";

export const OP = { TLE: 0, LOAD: 1, OBSERVER: 2, OBSERVER_GPS: 3, TIME: 4, LOOK: 5, PASS: 6, BENCH: 7, SAVE: 8, STORED: 9, RECALL: 10,
	DELETE: 11, CLEAR: 12 };
export const TLE_CHUNK = 35;		// a line goes in two requests (a request holds 64 bytes)
const NAME_MAX = 11;

const op = (link, code, ...args) => link.request(CMD.SAT, concat(new Uint8Array([code]), ...args));

// Set the radio's UTC (until its next NMEA sentence, or the battery-backed clock where there is one)
export const setTime = (link, unixSeconds) => op(link, OP.TIME, le32(Math.floor(unixSeconds)));

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
// has no profile for it.
export async function update(link, tles, { add = [], dryRun = false, choose = null, now = Date.now() / 1000, onResult = () => {} } = {}) {
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
		if (rec && compare(set, rec) !== "newer" && compare(set, rec) !== "new") {
			done({ norad, label, outcome: "current", detail: `already current (${((now - rec.epoch) / 86400).toFixed(1)} days old)`, age_days: (now - rec.epoch) / 86400 });
			continue;
		}
		if (dryRun) { done({ norad, label, outcome: "would", detail: `would update: new set ${age.toFixed(1)} days old`, age_days: age }); continue; }
		const l = await load(link, set.l1, set.l2);
		if (l.tle || l.sgp4 || l.norad !== norad) {
			done({ norad, label, outcome: "failed", detail: `not loaded: ${why(l)}` });
			continue;
		}
		if (rec) {
			await save(link, rec);
		} else if (((await link.view("sat")).kv["sat.profile"] ?? "-") !== "-") {
			await save(link);
		} else {
			await save(link, { up_hz: 0, down_hz: 0, up_tone: 0, arm_tone: 0, arm_ms: 0, armed_s: 0, name: set.name });
		}
		done({ norad, label, outcome: rec ? "updated" : "stored", detail: `${rec ? "updated" : "stored"}: new set ${age.toFixed(1)} days old`, age_days: age });
	}
	return results;
}
