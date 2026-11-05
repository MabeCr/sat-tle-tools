// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// A WebUSB FTDI cable between the page and a FakeRadio: the cable's side of the protocol, with the two status bytes at
// the start of every bulk-in packet as the chip sends them. Shared by the Node tests and the browser test.
import { concat } from "../lib/bytes.js";

export class FakeFtdi {
	constructor(radio) {
		this.radio = radio;
		this.opened = false;
		this.configuration = null;
		this.controls = [];
		this.outs = [];
		this.productName = "FT231X USB UART";
		this.vendorId = 0x0403;
		this.unplugged = false;
	}
	async open() { this.opened = true; }
	async close() { this.opened = false; }
	async selectConfiguration(n) {
		this.configuration = { interfaces: [{ interfaceNumber: 0, alternates: [{ endpoints: [
			{ endpointNumber: 1, direction: "in", type: "bulk" }, { endpointNumber: 2, direction: "out", type: "bulk" }] }] }] };
	}
	async claimInterface() {}
	async releaseInterface() {}
	async controlTransferOut(c) { this.controls.push(c); return { status: "ok" }; }
	async transferOut(ep, data) {
		if (ep !== 2) throw new Error("bulk out is endpoint 2");
		this.outs.push(data.length);
		await this.radio.write(data);
		return { status: "ok", bytesWritten: data.length };
	}
	async transferIn(ep, n) {
		if (ep !== 1) throw new Error("bulk in is endpoint 1");
		for (let i = 0; i < 400; i++) {
			if (this.unplugged) throw new DOMException("The device was disconnected.", "NotFoundError");
			if (this.radio.buf.length) {
				const take = this.radio.take(Math.min(this.radio.buf.length, 62 * Math.floor(n / 64)));
				const packets = [];
				for (let o = 0; o < take.length; o += 62) packets.push(new Uint8Array([0x31, 0x60]), take.subarray(o, o + 62));
				const all = concat(...packets);
				return { status: "ok", data: new DataView(all.buffer) };
			}
			await new Promise((r) => setTimeout(r, 2));
		}
		return { status: "ok", data: new DataView(new Uint8Array([0x31, 0x60]).buffer) };	// idle: status bytes only
	}
}

