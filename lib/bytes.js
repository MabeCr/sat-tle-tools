// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Byte helpers. Runs in browsers and in Node.

export const u32le = (b, off) => (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
export const u16le = (b, off) => b[off] | (b[off + 1] << 8);
export const i16le = (b, off) => (u16le(b, off) << 16) >> 16;
export const i32le = (b, off) => u32le(b, off) | 0;

export const le32 = (n) => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);
export const le16 = (n) => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);

export function concat(...parts) {
	const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0x7F);
export const text = (b) => String.fromCharCode(...b);
