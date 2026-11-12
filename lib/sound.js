// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Element sets as sound (docs/spec/sound-transfer.md of the firmware repository): one satellite is one HDLC frame of
// 1200 baud Bell 202 AFSK (mark 1200 Hz, space 2200 Hz), played at the radio's microphone. The frame and its tone bits
// are the same as tools/sat_sound.py's, checked against the same vectors (test/sound_vectors.json). Pure functions, no
// browser API except playAudio, so the tests run them in Node.
import { catalog, checksum } from "./tle.js";

export const MAGIC = 0x54, VERSION = 1, NAME_MAX = 24, SETS_MAX = 32, TLE_LEN = 69;
export const BAUD = 1200, MARK_HZ = 1200, SPACE_HZ = 2200;
export const PREAMBLE_FLAGS = 30;	// about 0.2 s of flags before each frame
export const TAIL_FLAGS = 3;
export const GAP_MS = 100;		// silence between frames
export const LEAD_MS = 500;		// silence before the first frame
export const PASS_GAP_MS = 1000;	// silence between the passes of a repeated set
export const FADE_MS = 5;		// a ramp in and out of each frame, so the speaker doesn't click

// A name the way a frame carries it: printable ASCII, at most 24 characters
export function cleanName(name) {
	return [...String(name ?? "")].map((c) => (c >= " " && c <= "~" ? c : "?")).join("").trim().slice(0, NAME_MAX);
}

// The rules of core/sat/sat_tle.c's tle_parse that a sender needs: 69 columns, line numbers, both check digits, one satellite
export function tleOk(l1, l2) {
	if (typeof l1 !== "string" || typeof l2 !== "string" || l1.length !== TLE_LEN || l2.length !== TLE_LEN) return false;
	if (l1[0] !== "1" || l2[0] !== "2" || !/\d/.test(l1[68]) || !/\d/.test(l2[68])) return false;
	if (checksum(l1) !== Number(l1[68]) || checksum(l2) !== Number(l2[68])) return false;
	return !Number.isNaN(catalog(l1)) && catalog(l1) === catalog(l2);
}

// One satellite's frame; null where the firmware's sat_sound_build returns 0
export function buildFrame(id, index, count, name, l1, l2) {
	if (!(Number.isInteger(count) && count > 0 && count <= SETS_MAX && Number.isInteger(index) && index >= 0 && index < count)) return null;
	if (typeof name !== "string" || name.length > NAME_MAX || [...name].some((c) => c < " " || c > "~")) return null;
	if (!tleOk(l1, l2)) return null;
	const out = new Uint8Array(6 + name.length + 2 * TLE_LEN);
	out.set([MAGIC, VERSION, id & 255, index, count, name.length]);
	for (let i = 0; i < name.length; i++) out[6 + i] = name.charCodeAt(i);
	for (let i = 0; i < TLE_LEN; i++) {
		out[6 + name.length + i] = l1.charCodeAt(i);
		out[6 + name.length + TLE_LEN + i] = l2.charCodeAt(i);
	}
	return out;
}

// The HDLC frame check sequence (CRC-16/X.25), as core/aprs/ax25.c's ax25_fcs
export function fcs(data) {
	let crc = 0xFFFF;
	for (const b of data) {
		crc ^= b;
		for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1;
	}
	return ~crc & 0xFFFF;
}

// core/aprs/hdlc.c's encoder: bits go out least significant first, NRZI (a 0 changes the tone, a 1 keeps it), a 0 stuffed
// after five 1s; tone 1 is mark
export class Hdlc {
	constructor() {
		this.tones = [];
		this.level = 1;
		this.ones = 0;
	}

	#put(bit) {
		if (!bit) this.level ^= 1;
		this.tones.push(this.level);
	}

	flags(n) {
		for (let k = 0; k < n; k++) for (let i = 0; i < 8; i++) this.#put((0x7E >> i) & 1);
		this.ones = 0;
	}

	#byte(b) {
		for (let i = 0; i < 8; i++) {
			const bit = (b >> i) & 1;
			this.#put(bit);
			if (bit) {
				if (++this.ones === 5) {
					this.#put(0);
					this.ones = 0;
				}
			} else this.ones = 0;
		}
	}

	frame(data) {
		const c = fcs(data);
		this.ones = 0;
		for (const b of data) this.#byte(b);
		this.#byte(c & 255);
		this.#byte(c >> 8);
	}
}

// The tone bits as hdlc.h keeps them: bit i of the buffer is byte i >> 3, bit i & 7
export function tonesPacked(tones) {
	const out = new Uint8Array((tones.length + 7) >> 3);
	tones.forEach((t, i) => { if (t) out[i >> 3] |= 1 << (i & 7); });
	return out;
}

export function frameTones(frame, preamble = PREAMBLE_FLAGS, tail = TAIL_FLAGS) {
	const h = new Hdlc();
	h.flags(preamble);
	h.frame(frame);
	h.flags(tail);
	return h.tones;
}

export const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// The frames of a transfer for the chosen sets ({name, l1, l2}, in the order given). Throws on a set no frame can carry
export function framesFor(sets, id) {
	if (!sets.length) throw new Error("No satellites are chosen.");
	if (sets.length > SETS_MAX) throw new Error(`The radio holds ${SETS_MAX}: choose ${SETS_MAX} or fewer.`);
	return sets.map((s, i) => {
		const f = buildFrame(id, i, sets.length, cleanName(s.name), s.l1, s.l2);
		if (!f) throw new Error(`${s.name || "A satellite"}: its element set can't be sent.`);
		return f;
	});
}

const frameSamples = (nbits, rate) => Math.round((nbits * rate) / BAUD);

// How long the whole transfer plays, in seconds
export function seconds(sets, passes = 2, rate = 48000, id = 0) {
	const frames = framesFor(sets, id);
	let n = Math.round((LEAD_MS * rate) / 1000);
	for (let p = 0; p < passes; p++) {
		if (p) n += Math.round((PASS_GAP_MS * rate) / 1000);
		for (const f of frames) n += frameSamples(frameTones(f).length, rate) + Math.round((GAP_MS * rate) / 1000);
	}
	return n / rate;
}

// The audio of a whole transfer: every set's frame in order, the whole list `passes` times, as floats (-1 to 1) at `rate`.
// Bit k of a frame ends at sample round((k + 1) * rate / 1200), so a rate that isn't a multiple of 1200 (44.1 kHz) keeps the
// baud rate exactly
export function encode(sets, { id = Math.floor(Math.random() * 256), passes = 2, rate = 48000, amp = 0.6 } = {}) {
	const frames = framesFor(sets, id), tones = frames.map((f) => frameTones(f));
	const lead = Math.round((LEAD_MS * rate) / 1000), gap = Math.round((GAP_MS * rate) / 1000), pgap = Math.round((PASS_GAP_MS * rate) / 1000);
	const fade = Math.round((FADE_MS * rate) / 1000);
	let total = lead;
	for (let p = 0; p < passes; p++) {
		if (p) total += pgap;
		for (const t of tones) total += frameSamples(t.length, rate) + gap;
	}
	const out = new Float32Array(total);
	let at = lead;
	for (let p = 0; p < passes; p++) {
		if (p) at += pgap;
		for (const t of tones) {
			const n = frameSamples(t.length, rate);
			let phase = 0;
			for (let k = 0; k < t.length; k++) {
				const s0 = Math.round((k * rate) / BAUD), s1 = Math.round(((k + 1) * rate) / BAUD);
				const step = (2 * Math.PI * (t[k] ? MARK_HZ : SPACE_HZ)) / rate;
				for (let s = s0; s < s1; s++) {
					let a = amp;
					if (s < fade) a *= s / fade;
					else if (s >= n - fade) a *= (n - s) / fade;
					out[at + s] = a * Math.sin(phase);
					phase += step;
				}
			}
			at += n + gap;
		}
	}
	return { samples: out, id, rate, frames: frames.length * passes, seconds: total / rate };
}

// A 16 bit mono WAV file of the samples
export function toWav(samples, rate = 48000) {
	const out = new Uint8Array(44 + samples.length * 2), v = new DataView(out.buffer);
	const tag = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
	tag(0, "RIFF");
	v.setUint32(4, 36 + samples.length * 2, true);
	tag(8, "WAVEfmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);	// PCM
	v.setUint16(22, 1, true);	// mono
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	tag(36, "data");
	v.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
	return out;
}

// Play it. The audio context's own rate is used (a phone's is 44100 or 48000), so call this from a click and pass the
// sets, not samples: {stop(), done: Promise, rate}. Needs a browser
export function playAudio(sets, opts = {}) {
	const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
	if (!Ctx) throw new Error("This browser can't play audio from a page.");
	const ctx = new Ctx();
	const { samples, seconds: secs, frames } = encode(sets, { ...opts, rate: ctx.sampleRate });
	const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
	buf.copyToChannel(samples, 0);
	const src = ctx.createBufferSource();
	src.buffer = buf;
	src.connect(ctx.destination);
	let stopped = false;
	const done = new Promise((resolve) => { src.onended = () => { ctx.close().catch(() => {}); resolve(stopped ? "stopped" : "finished"); }; });
	if (ctx.state === "suspended") ctx.resume().catch(() => {});
	src.start();
	return { done, seconds: secs, frames, elapsed: () => ctx.currentTime, stop() { stopped = true; try { src.stop(); } catch { /* already ended */ } } };
}
