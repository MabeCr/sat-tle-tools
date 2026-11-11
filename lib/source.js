// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// Where the element sets come from: CelesTrak first, and when it can't be reached or answers badly, this site's own copy
// (tle/amateur.txt, which .github/workflows/tle-mirror.yml keeps fresh from GitHub's servers). Runs in browsers and in Node.
import { SAT_TLE_URL, parse } from "./tle.js";

export const SAT_TLE_SOURCES = [
	{ id: "celestrak", name: "CelesTrak", url: SAT_TLE_URL },
	// Same origin as the page, so no cross-origin rules apply; mirror.json says when the copy was taken
	{ id: "mirror", name: "this site's copy", url: "tle/amateur.txt", meta: "tle/mirror.json" },
];

const MIN_SETS = 1;	// an error page parses to none; a source that answers with any valid set is used (the mirror job checks its copy holds 10 or more)

// Tries each source in turn. Resolves {text, source, fetched} for the first that answers with usable element sets
// (fetched: when a mirror's copy was taken, Unix seconds, else null; via: which list the copy was taken from, "" when
// unknown); rejects with an Error whose message names each
// failure when none does
export async function fetchSets(sources = SAT_TLE_SOURCES, { fetchFn = (...a) => fetch(...a), timeoutMs = 8000, minSets = MIN_SETS } = {}) {
	const failures = [];
	for (const src of sources) {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeoutMs);
		try {
			const r = await fetchFn(src.url, { cache: "no-store", signal: ctl.signal });
			if (!r.ok) throw new Error(`the server answered ${r.status}`);
			const text = await r.text();
			if (parse(text).size < minSets) throw new Error("no usable element sets in the answer");
			clearTimeout(timer);
			const meta = src.meta ? await fetchedAt(fetchFn, src.meta, timeoutMs) : { fetched: null, via: "" };
			return { text, source: src, fetched: meta.fetched, via: meta.via };
		} catch (e) {
			failures.push(`${src.name}: ${ctl.signal.aborted ? "no answer in time" : e.message}`);
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(failures.join("; "));
}

// A mirror's mirror.json: {"fetched": "2026-11-11T06:23:00Z", "source": "AMSAT"}; empty when it is missing or unreadable
async function fetchedAt(fetchFn, url, timeoutMs) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const r = await fetchFn(url, { cache: "no-store", signal: ctl.signal });
		if (!r.ok) return { fetched: null, via: "" };
		const m = await r.json();
		const t = Date.parse(m.fetched);
		return { fetched: Number.isNaN(t) ? null : Math.floor(t / 1000), via: typeof m.source === "string" ? m.source.slice(0, 40) : "" };
	} catch {
		return { fetched: null, via: "" };
	} finally {
		clearTimeout(timer);
	}
}
