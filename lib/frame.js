// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// The debug link's frame (docs/spec/debuglink.md 2): A5 5A, command, sequence, length (u16 little endian), payload,
// CRC-16/CCITT-FALSE over command to payload (little endian). Runs in browsers and in Node.
import { concat, u16le } from "./bytes.js";

const SOF1 = 0xA5, SOF2 = 0x5A;

export function crc16(data, crc = 0xFFFF) {
	for (const b of data) {
		crc ^= b << 8;
		for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
	}
	return crc;
}

export function frame(cmd, seq, payload = new Uint8Array(0)) {
	const body = concat(new Uint8Array([cmd, seq, payload.length & 0xFF, payload.length >> 8]), payload);
	const c = crc16(body);
	return concat(new Uint8Array([SOF1, SOF2]), body, new Uint8Array([c & 0xFF, c >> 8]));
}

// [{cmd, seq, payload, end}] for each complete, CRC-valid frame in buf
export function parseFrames(buf) {
	const out = [];
	let i = 0;
	while (i + 8 <= buf.length) {
		if (buf[i] !== SOF1 || buf[i + 1] !== SOF2) { i++; continue; }
		const n = u16le(buf, i + 4);
		const e = i + 8 + n;
		if (e > buf.length) break;
		const body = buf.subarray(i + 2, i + 6 + n);
		if (u16le(buf, i + 6 + n) === crc16(body)) {
			out.push({ cmd: buf[i + 2], seq: buf[i + 3], payload: buf.slice(i + 6, i + 6 + n), end: e });
			i = e;
		} else i++;
	}
	return out;
}
