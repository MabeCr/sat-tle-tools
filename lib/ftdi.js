// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// An FTDI USB-serial cable (FT232R, FT231X and the like) over WebUSB, as the byte stream the Link reads. Chrome on
// Android gives Web Serial only to USB devices of the standard serial class (and Bluetooth ports), so an FTDI cable
// is invisible to it there; WebUSB sees it, and the chip is driven with its own vendor requests.
//   - Every bulk-in packet (64 bytes at full speed) starts with two status bytes (modem and line status): dropped.
//   - Control requests (vendor, device): reset 0x00, flow control 0x02, baud rate 0x03, data format 0x04,
//     latency timer 0x09.
// On a computer the operating system's FTDI driver owns the cable and WebUSB can't claim it: use Web Serial there.
import { concat, sleep } from "./bytes.js";

export const FTDI_VID = 0x0403;
export const usbSupported = () => typeof navigator !== "undefined" && "usb" in navigator;

const REQ = { RESET: 0x00, FLOW: 0x02, BAUD: 0x03, DATA: 0x04, LATENCY: 0x09 };
const PACKET = 64;		// a full speed bulk packet
const READ_BYTES = 512;		// a read: eight packets at most (it returns at the first short one)
const WRITE_BYTES = 512;
// A baud rate's fraction (in eighths) as the chip's divisor bits
const FRAC = [0, 3, 2, 4, 1, 5, 6, 7];

// The FT232R / FT-X divisor for a baud rate from their 3 MHz base clock (48 MHz / 16, with three fraction bits):
// {value, index} of the baud rate request. 9600 is 0x4138, 19200 0x809C, 38400 0xC04E, 115200 0x001A
export function baudDivisor(baud) {
	if (!(baud >= 183 && baud <= 3000000)) throw new RangeError(`baud rate ${baud} is outside what the chip makes`);
	const eighths = Math.round(24000000 / baud);	// 3 MHz * 8 / baud
	let enc = (eighths >> 3) | (FRAC[eighths & 7] << 14);
	if (enc === 1) enc = 0;				// 3 Mbaud
	else if (enc === 0x4001) enc = 1;			// 2 Mbaud
	return { value: enc & 0xFFFF, index: (enc >>> 16) & 0xFFFF };
}

export function errorText(e) {
	const raw = e?.message || String(e);
	switch (e?.name) {
	case "NotFoundError": return /disconnect|no device selected/i.test(raw) && !/no device selected/i.test(raw) ? "The cable was unplugged." : "No cable was chosen.";
	case "SecurityError": return "The browser refused access to the cable.";
	case "NetworkError": return /claim|busy|access/i.test(raw) ? "Another app or tab is using the cable: close the other tab (the RadioFoundry page, a terminal) and unplug and plug the cable in again." : "The connection to the cable was lost.";
	case "InvalidStateError": return "The cable is already open in another tab or program: close it and try again.";
	default: return raw;
	}
}

export class FtdiStream {
	constructor(device, inEp, outEp) {
		this.dev = device;
		this.inEp = inEp;
		this.outEp = outEp;
		this.buf = new Uint8Array(0);
		this.closed = false;
		this.lost = false;
		this.product = device.productName || "";
	}

	// A cable this page was allowed to use before (one), else the chooser, which needs a click
	static async choose() {
		const known = (await navigator.usb.getDevices()).filter((d) => d.vendorId === FTDI_VID);
		const dev = known.length === 1 ? known[0] : await navigator.usb.requestDevice({ filters: [{ vendorId: FTDI_VID }] });
		return FtdiStream.open(dev);
	}

	static async open(dev, baud = 115200) {
		if (!dev.opened) await dev.open();
		if (dev.configuration === null) await dev.selectConfiguration(1);
		const iface = dev.configuration.interfaces[0];
		await dev.claimInterface(iface.interfaceNumber);
		const eps = iface.alternates[0].endpoints.filter((e) => e.type === "bulk");
		const inEp = eps.find((e) => e.direction === "in")?.endpointNumber, outEp = eps.find((e) => e.direction === "out")?.endpointNumber;
		if (inEp === undefined || outEp === undefined) throw new Error("This USB device has no bulk endpoints: not an FTDI serial cable.");
		const s = new FtdiStream(dev, inEp, outEp);
		const ctl = (request, value, index = 0) => dev.controlTransferOut({ requestType: "vendor", recipient: "device", request, value, index });
		const d = baudDivisor(baud);
		await ctl(REQ.RESET, 0);
		await ctl(REQ.BAUD, d.value, d.index);
		await ctl(REQ.DATA, 0x0008);		// 8 data bits, no parity, one stop bit
		await ctl(REQ.FLOW, 0, 0);		// no flow control
		await ctl(REQ.LATENCY, 2);		// a reply isn't held for the default 16 ms
		await ctl(REQ.RESET, 1);		// purge what the chip received before now
		await ctl(REQ.RESET, 2);
		s.pumping = s.pump();
		return s;
	}

	async pump() {
		while (!this.closed) {
			let r;
			try {
				r = await this.dev.transferIn(this.inEp, READ_BYTES);
			} catch (e) {
				if (!this.closed) this.lost = true;
				return;
			}
			if (r.status === "stall") {
				try { await this.dev.clearHalt("in", this.inEp); } catch { this.lost = true; return; }
				continue;
			}
			if (r.status !== "ok" || !r.data || r.data.byteLength <= 2) continue;	// an idle status packet
			const raw = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
			const parts = [];
			for (let o = 0; o < raw.length; o += PACKET) if (raw.length - o > 2) parts.push(raw.subarray(o + 2, Math.min(o + PACKET, raw.length)));
			if (parts.length) this.buf = concat(this.buf, ...parts);
		}
	}

	async write(data) {
		if (this.lost || this.closed) throw new DOMException("The device has been lost.", "NetworkError");
		for (let o = 0; o < data.length; o += WRITE_BYTES) {
			const r = await this.dev.transferOut(this.outEp, data.slice(o, o + WRITE_BYTES));
			if (r.status !== "ok") throw new DOMException("The cable did not take the data.", "NetworkError");
		}
	}

	clear() { this.buf = new Uint8Array(0); }

	take(n) {
		const out = this.buf.slice(0, n);
		this.buf = this.buf.slice(n);
		return out;
	}

	async close() {
		this.closed = true;
		await Promise.race([this.pumping, sleep(300)]);
		try { await this.dev.releaseInterface(this.dev.configuration.interfaces[0].interfaceNumber); } catch { /* gone */ }
		try { await this.dev.close(); } catch { /* gone */ }
	}
}
