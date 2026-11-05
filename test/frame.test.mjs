// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
import test from "node:test";
import assert from "node:assert/strict";
import { crc16, frame, parseFrames } from "../lib/frame.js";
import { concat } from "../lib/bytes.js";

test("CRC-16/CCITT-FALSE check value", () => {
	assert.equal(crc16(new TextEncoder().encode("123456789")), 0x29B1);
});

test("a frame parses back, and junk before and after it is skipped", () => {
	const f = frame(0x20, 0x41, new Uint8Array([1, 2, 3]));
	const got = parseFrames(concat(new Uint8Array([0, 0xA5, 7]), f, new Uint8Array([9]), frame(0x82, 0x42)));
	assert.equal(got.length, 2);
	assert.deepEqual([got[0].cmd, got[0].seq, [...got[0].payload]], [0x20, 0x41, [1, 2, 3]]);
	assert.deepEqual([got[1].cmd, got[1].seq, got[1].payload.length], [0x82, 0x42, 0]);
});

test("a bad CRC and a partial frame give nothing", () => {
	const f = frame(0x20, 1, new Uint8Array([5]));
	const bad = f.slice();
	bad[bad.length - 1] ^= 1;
	assert.equal(parseFrames(bad).length, 0);
	assert.equal(parseFrames(f.slice(0, f.length - 1)).length, 0);
});
