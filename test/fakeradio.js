// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// A radio's debug link in memory, enough of it for the page's tests: VERSION, GET_VIEW (sat, tasks, crash) and the SAT
// command with a store of 32 slots. It is a stream (buf, write, clear, take) the Link talks to, so the page's own
// code runs against it unchanged. Where the firmware refuses (a bad line, a full store) it answers with the same
// status and error bytes (core/debuglink/debuglink_sat.c).
import { concat, le16, le32, u16le, u32le, text, ascii } from "../lib/bytes.js";
import { frame, parseFrames } from "../lib/frame.js";
import { checksum, catalog, epoch } from "../lib/tle.js";

const PROFILES = {	// the radio's own profiles (core/sat/sat_profile.c): the ones it stores with `save()` and no arguments
	25544: { up_hz: 145990000, down_hz: 437800000, up_tone: 670, arm_tone: 0, arm_ms: 0, armed_s: 0, name: "ISS" },
	27607: { up_hz: 145850000, down_hz: 436795000, up_tone: 670, arm_tone: 744, arm_ms: 2000, armed_s: 600, name: "SO-50" },
	43017: { up_hz: 145880000, down_hz: 145960000, up_tone: 670, arm_tone: 0, arm_ms: 0, armed_s: 0, name: "AO-91" },
};

export class FakeRadio {
	constructor({ slots = 32, sat = true, store = [], clock = 1793196300 } = {}) {
		this.buf = new Uint8Array(0);
		this.slots = slots;
		this.sat = sat;
		this.rows = Array(slots).fill(null);
		store.forEach((r, i) => { this.rows[i] = { ...r }; });
		this.lines = { 1: Array(69).fill(" "), 2: Array(69).fill(" ") };
		this.loaded = null;
		this.clock = clock;
		this.calls = [];	// every SAT request, for the tests: {op, ...}
		this.crash = null;
		this.stuck = false;	// answer nothing
	}

	clear() { this.buf = new Uint8Array(0); }
	take(n) { const o = this.buf.slice(0, n); this.buf = this.buf.slice(n); return o; }

	async write(data) {
		this.in = concat(this.in || new Uint8Array(0), data);
		for (const f of parseFrames(this.in)) {
			this.in = this.in.slice(f.end);
			if (!this.stuck) this.buf = concat(this.buf, frame(f.cmd | 0x80, f.seq, this.answer(f.cmd, f.payload)));
		}
	}

	ok(...parts) { return concat(new Uint8Array([0]), ...parts); }
	status(n) { return new Uint8Array([n]); }

	answer(cmd, p) {
		if (cmd === 0x02) return this.ok(ascii(`board=FAKE\nrelease=test\nfeatures=HOSTLINK DEBUGLINK${this.sat ? " SAT" : ""}\n`));
		if (cmd === 0x09) return this.viewAnswer(p[0]);
		if (cmd === 0x20) return this.sat ? this.satAnswer(p) : this.status(4);
		return this.status(4);
	}

	viewAnswer(i) {
		const kv = i === 28 && !this.sat ? "section=sat\nsat.built=0\n" : i === 28 ? `section=sat\nsat.built=1\nsat.store=ours\nsat.slots=${this.slots}\nsat.stored=${this.rows.filter(Boolean).length}\nsat.profile=${this.loaded && PROFILES[this.loaded.norad] ? this.loaded.norad : "-"}\n`
			: i === 20 ? "section=tasks\ntasks.count=10\ntasks.min_free=452\ntasks.min_task=IDLE\ntasks.heap_free=15416\ntasks.heap_min_free=15416\n"
			: i === 21 ? (this.crash ? "section=crash\ncrash.built=1\ncrash.valid=1\ncrash.kind=5\ncrash.task=ui\n" : "section=crash\ncrash.built=1\ncrash.valid=0\n")
			: `section=x${i}\n`;
		return this.ok(le32(1234), new Uint8Array([0xFF]), ascii(kv));
	}

	satAnswer(p) {
		const op = p[0];
		this.calls.push({ op, args: p.slice(1) });
		switch (op) {
		case 0: {	// TLE: line, offset, text
			const line = this.lines[p[1]];
			if (!line || p[2] + p.length - 3 > 69) return this.status(5);
			for (let i = 3; i < p.length; i++) line[p[2] + i - 3] = String.fromCharCode(p[i]);
			return this.ok();
		}
		case 1: {	// LOAD: tle error, sgp4 error, catalog
			const l1 = this.lines[1].join(""), l2 = this.lines[2].join("");
			let err = 0;
			if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) err = 1;
			else if (checksum(l1) !== Number(l1[68]) || checksum(l2) !== Number(l2[68])) err = 2;
			else if (Number.isNaN(catalog(l1)) || Number.isNaN(epoch(l1))) err = 3;
			else if (catalog(l1) !== catalog(l2)) err = 4;
			if (err) return this.ok(new Uint8Array([err, 0]), le32(0));
			this.loaded = { norad: catalog(l1), epoch: Math.round(epoch(l1)), name: "" };
			return this.ok(new Uint8Array([0, 0]), le32(this.loaded.norad));
		}
		case 4:
			this.clock = u32le(p, 1);
			return this.ok();
		case 7:
			return this.ok(le16(u16le(p, 1)), le32(3760 * u16le(p, 1)));
		case 8: {	// SAVE: [up, down, up tone, arm tone, arm ms, armed s, name], or none for the loaded satellite's own profile
			if (!this.loaded) return this.status(4);
			const prof = p.length === 1 ? PROFILES[this.loaded.norad] || { up_hz: 0, down_hz: 0, up_tone: 0, arm_tone: 0, arm_ms: 0, armed_s: 0, name: "" }
				: { up_hz: u32le(p, 1), down_hz: u32le(p, 5), up_tone: u16le(p, 9), arm_tone: u16le(p, 11), arm_ms: u16le(p, 13), armed_s: u16le(p, 15), name: text(p.subarray(17)) };
			const row = { norad: this.loaded.norad, elements: true, epoch: this.loaded.epoch, ...prof };
			let at = this.rows.findIndex((r) => r && r.norad === row.norad);
			if (at < 0) at = this.rows.indexOf(null);
			if (at < 0) return this.status(7);
			this.rows[at] = row;
			return this.ok();
		}
		case 9: {	// STORED: slot -> found, catalog, elements, epoch, profile, name
			const slot = u16le(p, 1), r = this.rows[slot];
			if (!r) return this.ok(new Uint8Array([0]));
			return this.ok(new Uint8Array([1]), le32(r.norad), new Uint8Array([r.elements ? 1 : 0]), le32(r.epoch), le32(r.up_hz), le32(r.down_hz),
				le16(r.up_tone), le16(r.arm_tone), le16(r.arm_ms), le16(r.armed_s), ascii(r.name));
		}
		case 11: {
			const at = this.rows.findIndex((r) => r && r.norad === u32le(p, 1));
			if (at < 0) return this.status(4);
			this.rows[at] = null;
			return this.ok();
		}
		case 12:
			if (u32le(p, 1) !== 0x43544153) return this.status(7);
			this.rows.fill(null);
			return this.ok();
		default:
			return this.status(4);
		}
	}
}
