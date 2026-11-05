// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// The FTDI driver against a fake WebUSB device (the cable's side of the protocol), and the debug link over it.
import test from "node:test";
import assert from "node:assert/strict";
import { baudDivisor, FtdiStream } from "../lib/ftdi.js";
import { Link } from "../lib/link.js";
import * as sat from "../lib/sat.js";
import { FakeRadio } from "./fakeradio.js";
import { FakeFtdi } from "./fakeftdi.js";

test("baud divisors match the chip's known values", () => {
	assert.deepEqual(baudDivisor(115200), { value: 0x001A, index: 0 });
	assert.deepEqual(baudDivisor(9600), { value: 0x4138, index: 0 });
	assert.deepEqual(baudDivisor(19200), { value: 0x809C, index: 0 });
	assert.deepEqual(baudDivisor(38400), { value: 0xC04E, index: 0 });
	assert.deepEqual(baudDivisor(57600), { value: 0xC034, index: 0 });	// 52.083 rounds to 52 and an eighth
	assert.deepEqual(baudDivisor(921600), { value: 0x8003, index: 0 });	// 3.25
	assert.deepEqual(baudDivisor(3000000), { value: 0, index: 0 });	// the chip's top rate is divisor 0
	assert.throws(() => baudDivisor(1), RangeError);
});

test("opening sets 115200 8N1, no flow control, a short latency, and purges", async () => {
	const dev = new FakeFtdi(new FakeRadio());
	const s = await FtdiStream.open(dev);
	const reqs = dev.controls.map((c) => [c.request, c.value, c.index]);
	assert.deepEqual(reqs, [[0, 0, 0], [3, 0x1A, 0], [4, 8, 0], [2, 0, 0], [9, 2, 0], [0, 1, 0], [0, 2, 0]]);
	assert.ok(dev.controls.every((c) => c.requestType === "vendor" && c.recipient === "device"));
	await s.close();
});

test("the debug link works over the cable: status bytes are dropped and long replies arrive whole", async () => {
	const radio = new FakeRadio({ store: [{ norad: 25544, elements: true, epoch: 1793000000, up_hz: 145990000, down_hz: 437800000, up_tone: 670, arm_tone: 0, arm_ms: 0, armed_s: 0, name: "ISS" }] });
	const dev = new FakeFtdi(radio);
	const s = await FtdiStream.open(dev);
	const link = new Link(s, { timeout: 500 });
	assert.equal((await link.version()).board, "FAKE");
	assert.equal((await sat.list(link))[0].name, "ISS");
	const iss = { l1: "1 25544U 98067A   26307.51782528  .00016717  00000-0  30144-3 0  9993", l2: "" };
	await assert.rejects(() => sat.load(link, iss.l1, "2 25544"), /not 69/);
	await s.close();
});

test("a write is cut into pieces of at most 512 bytes", async () => {
	const dev = new FakeFtdi(new FakeRadio());
	const s = await FtdiStream.open(dev);
	await s.write(new Uint8Array(1200));
	assert.deepEqual(dev.outs, [512, 512, 176]);
	await s.close();
});

test("a cable pulled out is a lost connection", async () => {
	const dev = new FakeFtdi(new FakeRadio());
	const s = await FtdiStream.open(dev);
	dev.unplugged = true;
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(s.lost, true);
	await assert.rejects(() => s.write(new Uint8Array(1)), (e) => e.name === "NetworkError");
});
