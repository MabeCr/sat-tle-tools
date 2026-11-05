// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Two-line element sets: the same rules as tools/rfoundry_debug.py (tle_checksum, tle_catalog, tle_epoch, parse_tles),
// checked against the same vectors (test/vectors.json). Runs in browsers and in Node.

export const SAT_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle";
export const TLE_ERRORS = { 0: "ok", 1: "a line isn't 69 columns, or the wrong line number", 2: "check digit wrong",
	3: "a field doesn't parse", 4: "the two lines name different satellites" };
export const SGP4_ERRORS = { 0: "ok", 1: "eccentricity out of range", 2: "mean motion not positive",
	3: "semi-latus rectum negative", 4: "decayed", 5: "deep space (period of 225 minutes or more)" };

// A line's check digit: the digits' sum plus 1 for each '-', modulo 10, over columns 1-68
export function checksum(line) {
	let sum = 0;
	for (const c of line.slice(0, 68)) sum += c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c === "-" ? 1 : 0;
	return sum % 10;
}

// The catalog number of a line: five digits, or Alpha-5 (a leading letter stands for 10-33, I and O skipped). NaN if it
// doesn't parse
export function catalog(line) {
	const c = line[2];
	let lead;
	if ((c >= "0" && c <= "9") || c === " ") lead = c === " " ? 0 : c.charCodeAt(0) - 48;
	else if (c >= "A" && c <= "Z") lead = 10 + (c.charCodeAt(0) - 65) - (c > "I" ? 1 : 0) - (c > "O" ? 1 : 0);
	else return NaN;
	const rest = line.slice(3, 7);
	return /^\d{4}$/.test(rest) ? lead * 10000 + Number(rest) : NaN;
}

// Line 1's epoch as Unix seconds (NaN if it doesn't parse)
export function epoch(line) {
	const yy = line.slice(18, 20), day = line.slice(20, 32);
	if (!/^\d\d$/.test(yy) || !/^\s*\d+(\.\d*)?\s*$/.test(day)) return NaN;
	const y = Number(yy);
	const year = y < 57 ? 2000 + y : 1900 + y;
	return Date.UTC(year, 0, 1) / 1000 + (Number(day) - 1) * 86400;
}

// Every valid element set in text (two lines, or a name line then two): a Map from catalog number to
// {name, l1, l2, epoch}. A set whose lines are the wrong length, don't check or name different satellites is left
// out; the newest wins
export function parse(text) {
	const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
	const out = new Map();
	for (let i = 0; i + 1 < lines.length; i++) {
		const l1 = lines[i], l2 = lines[i + 1];
		if (!(l1.startsWith("1 ") && l2.startsWith("2 ") && l1.length === 69 && l2.length === 69)) continue;
		if (!/\d/.test(l1[68]) || !/\d/.test(l2[68])) continue;
		if (checksum(l1) !== Number(l1[68]) || checksum(l2) !== Number(l2[68])) continue;
		const norad = catalog(l1), ep = epoch(l1);
		if (Number.isNaN(norad) || norad !== catalog(l2) || Number.isNaN(ep)) continue;
		const prev = i > 0 ? lines[i - 1] : "";
		const name = i > 0 && !prev.startsWith("1 ") && !prev.startsWith("2 ") ? prev.trim() : "";
		const have = out.get(norad);
		if (!have || ep > have.epoch) out.set(norad, { name, l1, l2, epoch: ep });
	}
	return out;
}

// How a downloaded set compares with what the radio holds (the radio reports its epoch rounded to the second):
// "new" nothing stored for it, "newer", "same", or "older"
export function compare(set, stored) {
	if (!stored || !stored.elements) return "new";
	if (set.epoch > stored.epoch + 1) return "newer";
	return set.epoch >= stored.epoch - 1 ? "same" : "older";
}
