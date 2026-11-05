// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// A byte stream over Web Serial (Chrome, Edge, Chrome on Android), with the receive buffer the Link reads. Adapted from
// the RadioFoundry web flasher's link.js: a cable that sees a break or a framing error (a radio switched on or off with
// it plugged in) ends only that reader, and reading goes on.
import { concat, sleep } from "./bytes.js";

// The USB serial chips of the programming cables, and the radios' own USB port
export const FILTERS = [{ usbVendorId: 0x1FC9, usbProductId: 0x0094 }, ...[0x0403, 0x1A86, 0x10C4, 0x067B].map((usbVendorId) => ({ usbVendorId }))];
export const serialSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

const SOFT = new Set(["FramingError", "ParityError", "BreakError", "BufferOverrunError"]);

// The words to show for the browser's own errors (a DOMException, by name)
export function errorText(e) {
	const raw = e?.message || String(e);
	switch (e?.name) {
	case "NotFoundError": return /disconnect/i.test(raw) ? "The cable was unplugged." : "No port was chosen.";
	case "InvalidStateError": return "The port is already open in another tab or program: close it and try again.";
	case "NetworkError": return /open serial port/i.test(raw) ? "The port is in use by another program or tab." : "The connection to the radio was lost.";
	case "SecurityError": return /user gesture/i.test(raw) ? "Press the button again." : "The browser refused access to the port.";
	case "NotAllowedError": return "The browser did not allow access to the port.";
	default: return raw;
	}
}

export class SerialStream {
	constructor(port) {
		this.port = port;
		this.buf = new Uint8Array(0);
		this.closed = false;
		this.lost = false;
	}

	// A port from an earlier visit the browser still allows, else the chooser (needs a click)
	static async choose() {
		const known = (await navigator.serial.getPorts()).filter((p) => {
			const i = p.getInfo?.() || {};
			return FILTERS.some((f) => f.usbVendorId === i.usbVendorId && (f.usbProductId === undefined || f.usbProductId === i.usbProductId));
		});
		const port = known.length === 1 ? known[0] : await navigator.serial.requestPort({ filters: FILTERS });
		return SerialStream.open(port);
	}

	static async open(port, baudRate = 115200) {
		const opts = { baudRate, bufferSize: 65536 };
		try {
			await port.open(opts);
		} catch (e) {
			if (e?.name !== "InvalidStateError") throw e;
			try { await port.close(); } catch { throw e; }
			await port.open(opts);
		}
		const s = new SerialStream(port);
		s.pumping = s.pump();
		return s;
	}

	async pump() {
		let glitches = 0;
		while (!this.closed && this.port.readable) {
			this.reader = this.port.readable.getReader();
			try {
				for (;;) {
					const { value, done } = await this.reader.read();
					if (done) break;
					if (value.length) glitches = 0;
					this.buf = concat(this.buf, value);
				}
			} catch (e) {
				if (!SOFT.has(e?.name)) break;
				glitches++;
			} finally {
				this.reader.releaseLock();
			}
			if (glitches > 20) await sleep(20);
		}
		if (!this.closed) this.lost = true;
	}

	async write(data) {
		if (!this.port.writable) throw new DOMException("The device has been lost.", "NetworkError");
		const w = this.port.writable.getWriter();
		try { await w.write(data); } finally { w.releaseLock(); }
	}

	clear() { this.buf = new Uint8Array(0); }

	take(n) {
		const out = this.buf.slice(0, n);
		this.buf = this.buf.slice(n);
		return out;
	}

	async close() {
		this.closed = true;
		try { await this.reader?.cancel(); } catch { /* gone */ }
		await Promise.race([this.pumping, sleep(2000)]);
		try { await this.port.close(); } catch { /* already closed */ }
	}
}
