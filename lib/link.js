// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// The debug link over a byte stream (a SerialStream in the browser, the fake radio in tests): a request, its reply,
// and the radio's state as key=value text. Only what this page needs of docs/spec/debuglink.md.
import { concat, sleep, u32le, text } from "./bytes.js";
import { frame, parseFrames } from "./frame.js";

export const CMD = { PING: 0x01, VERSION: 0x02, GET_VIEW: 0x09, CRASH: 0x1B, SAT: 0x20 };
// GET_VIEW's section numbers (tools/rfoundry_debug.py VIEW_SECTIONS); the page asks for these by name
export const SECTIONS = { features: 7, tasks: 20, crash: 21, reset: 23, cps: 27, sat: 28 };
export const ST_UNAVAILABLE = 4;

export class LinkError extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
	}
}

export function parseKv(s) {
	const out = {};
	for (const line of s.split("\n")) {
		const k = line.indexOf("=");
		if (k > 0) out[line.slice(0, k).trim()] = line.slice(k + 1).trim();
	}
	return out;
}

export class Link {
	constructor(stream, { timeout = 1500 } = {}) {
		this.s = stream;
		this.timeout = timeout;
		this.seq = 0x40;
		this.busy = Promise.resolve();
	}

	async waitFor(test, timeout = this.timeout) {
		const until = Date.now() + timeout;
		for (;;) {
			const r = test(this.s.buf);
			if (r !== undefined) return r;
			if (Date.now() > until) return undefined;
			await sleep(2);
		}
	}

	// One request at a time: the page's buttons can't interleave two. Resolves to the reply after its status byte;
	// a non-zero status throws a LinkError carrying it
	request(cmd, payload = new Uint8Array(0)) {
		const run = this.busy.then(() => this.#request(cmd, payload));
		this.busy = run.catch(() => {});
		return run;
	}

	async #request(cmd, payload) {
		this.seq = (this.seq + 1) & 0xFF;
		const seq = this.seq;
		this.s.clear();
		await this.s.write(frame(cmd, seq, payload));
		const reply = await this.waitFor((buf) => parseFrames(buf).find((f) => f.seq === seq && (f.cmd === (cmd | 0x80) || f.cmd === 0xFF)));
		if (!reply) throw new LinkError(`no answer to command 0x${cmd.toString(16)}`);
		this.s.take(reply.end);
		if (!reply.payload.length || reply.payload[0] !== 0) throw new LinkError(`command 0x${cmd.toString(16)}: status ${reply.payload[0]}`, reply.payload[0]);
		return reply.payload.subarray(1);
	}

	async version() {
		return parseKv(text(await this.request(CMD.VERSION)));
	}

	// One view section by name: {ms, next, kv}
	async view(section) {
		const r = await this.request(CMD.GET_VIEW, new Uint8Array([SECTIONS[section]]));
		const kv = parseKv(text(r.subarray(5)));
		delete kv.section;
		return { ms: u32le(r, 0), next: r[4], kv };
	}
}
