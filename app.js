// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// The page: connect to the radio over Web Serial, set its clock, list and update its satellites, read diagnostics.
// All of the radio and TLE logic is in lib/ (tested in Node against a fake radio); this file only wires it to the DOM.
import { Link, LinkError } from "./lib/link.js";
import { SerialStream, errorText, serialSupported } from "./lib/serial.js";
import * as sat from "./lib/sat.js";
import { SAT_TLE_URL, compare, parse } from "./lib/tle.js";

const $ = (id) => document.getElementById(id);
const CACHE_KEY = "sat-web.tle";
const CACHE_MS = 2 * 3600 * 1000;	// CelesTrak asks for a group no more often than every two hours
const MIN_CLOCK = Date.UTC(2026, 0, 1) / 1000;	// the radio refuses a time before this too

let link = null, stream = null;
let stored = [];		// the radio's list, as sat.list gives it
let tles = new Map();		// the element sets read from the source
const added = new Set();	// catalog numbers to store that the radio doesn't hold yet
const unchecked = new Set();	// stored satellites the user turned off

function say(el, text, cls = "") {
	el.textContent = text;
	el.className = `muted ${cls}`.trim();
}

// Every button runs through here: disabled while it works, its error shown where the user is looking
async function run(btn, msg, fn) {
	btn.disabled = true;
	try {
		await fn();
	} catch (e) {
		const text = e instanceof LinkError ? (/no answer/.test(e.message) ? "The radio did not answer. Is it on, with the cable in, and not in a menu that holds the port?" : e.message) : errorText(e);
		say(msg, text, "bad");
		if (e?.name === "NetworkError" || stream?.lost) await disconnect();
	} finally {
		btn.disabled = false;
	}
}

const when = (unix) => new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const mhz = (hz) => (hz ? (hz / 1e6).toFixed(4) : "-");
const ageDays = (epoch) => (Date.now() / 1000 - epoch) / 86400;

// --- connect ---

function show(connected) {
	for (const id of ["clock", "stored", "update", "diag"]) $(id).hidden = !connected;
	$("connect-btn").hidden = connected;
	$("connect-known-btn").hidden = connected;
	$("disconnect-btn").hidden = !connected;
}

async function connect(onlyKnown = false) {
	$("connect-help").hidden = true;
	try {
		stream = await SerialStream.choose({ onlyKnown });
	} catch (e) {
		if (e?.name === "NotFoundError") $("connect-help").hidden = false;	// the chooser closed with nothing chosen (or listed)
		throw e;
	}
	link = new Link(stream);
	const v = await link.version();
	const features = (v.features || "").split(/\s+/);
	if (!features.includes("SAT")) {
		say($("radio-info"), `${v.board || "This radio"} answered, but this firmware has no satellite tracking (SAT is not in its features). The diagnostics still work.`, "warn");
		show(true);
		for (const id of ["clock", "stored", "update"]) $(id).hidden = true;
		return;
	}
	say($("radio-info"), `Connected: ${v.board || "radio"}${v.release ? `, release ${v.release}` : ""}.`, "ok");
	show(true);
	await readClock();
	await readStored();
}

async function disconnect() {
	const s = stream;
	stream = link = null;
	show(false);
	say($("radio-info"), "Disconnected. Press Connect to start again.");
	try { await s?.close(); } catch { /* gone */ }
}

// --- clock ---

function tickPhone() {
	const d = new Date();
	$("clock-phone").textContent = `This device: ${d.toISOString().replace("T", " ").slice(0, 19)} UTC (local ${d.toLocaleTimeString()})`;
}

async function readClock() {
	const kv = (await link.view("sat")).kv;
	say($("clock-radio"), kv["sat.utc_ok"] === "1" ? "The radio has a time." : "The radio has no time yet: passes need it.", kv["sat.utc_ok"] === "1" ? "" : "warn");
}

async function setClock() {
	const now = Date.now() / 1000;
	if (now < MIN_CLOCK) {
		say($("clock-msg"), "This device's clock is before 2026: not setting the radio from it.", "bad");
		return;
	}
	await sat.setTime(link, now);
	await readClock();
	say($("clock-msg"), `Radio clock set to ${when(Math.floor(now))}.`, "ok");
}

// --- stored satellites ---

function tag(text, cls) {
	const s = document.createElement("span");
	s.className = `tag ${cls}`;
	s.textContent = text;
	return s;
}

async function readStored() {
	stored = await sat.list(link);
	const box = $("stored-list");
	box.textContent = "";
	if (!stored.length) {
		const p = document.createElement("p");
		p.className = "muted";
		p.textContent = "No satellites are stored. Add some below, by catalog number.";
		box.append(p);
	}
	for (const r of stored) {
		const item = document.createElement("div");
		item.className = "item";
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = `${r.name || "?"}  #${r.norad}`;
		const del = document.createElement("button");
		del.textContent = "Delete";
		del.className = "danger";
		del.addEventListener("click", () => run(del, $("src-msg"), async () => {
			if (!confirm(`Delete ${r.name || r.norad} from the radio?`)) return;
			await sat.remove(link, r.norad);
			await readStored();
		}));
		const meta = document.createElement("span");
		meta.className = "meta";
		const age = r.elements ? ageDays(r.epoch) : null;
		meta.append(r.elements ? `element set ${age.toFixed(1)} days old   ` : "no element set   ");
		meta.append(r.elements ? tag(age > 30 ? "too old" : age > 14 ? "old" : "fresh", age > 30 ? "bad" : age > 14 ? "warn" : "ok") : tag("no orbit", "warn"));
		meta.append(`   TX ${mhz(r.up_hz)}  RX ${mhz(r.down_hz)}`);
		item.append(name, del, meta);
		box.append(item);
	}
	renderSets();
}

// --- element sets ---

function setSource(src) {
	for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.src === src));
	for (const s of ["net", "paste", "file"]) $(`src-${s}`).hidden = s !== src;
}

function useText(text, from) {
	tles = parse(text);
	if (!tles.size) {
		say($("src-msg"), "No valid element sets in that data (each needs two lines of 69 characters with correct check digits).", "bad");
		$("sets").hidden = true;
		return;
	}
	say($("src-msg"), `${tles.size} element sets read${from ? ` (${from})` : ""}.`, "ok");
	unchecked.clear();
	added.clear();
	$("sets").hidden = false;
	$("progress").textContent = "";
	renderSets();
}

async function download(force) {
	let cached = null;
	try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { /* none */ }
	if (cached && !force && Date.now() - cached.t < CACHE_MS) {
		useText(cached.text, `kept from ${Math.round((Date.now() - cached.t) / 60000)} minutes ago`);
		$("net-force").hidden = false;
		return;
	}
	say($("src-msg"), "Downloading…");
	let text;
	try {
		const r = await fetch(SAT_TLE_URL, { cache: "no-store" });
		if (!r.ok) throw new Error(`the server answered ${r.status}`);
		text = await r.text();
	} catch (e) {
		if (cached) {
			useText(cached.text, "the last download: this one failed");
			return;
		}
		say($("src-msg"), `Couldn't download (${e.message}). Paste the text or choose a file instead: celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle`, "bad");
		return;
	}
	try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), text })); } catch { /* full or private */ }
	useText(text, "downloaded now");
	$("net-force").hidden = false;
}

// The sets to show: every satellite on the radio, then the ones added
function renderSets() {
	const box = $("sets-list");
	box.textContent = "";
	if (!tles.size) return;
	const rows = [...stored.map((r) => ({ norad: r.norad, rec: r })), ...[...added].filter((n) => !stored.some((r) => r.norad === n)).map((n) => ({ norad: n, rec: null }))];
	if (!rows.length) {
		const p = document.createElement("p");
		p.className = "muted";
		p.textContent = "Nothing on the radio to update yet: add a satellite below.";
		box.append(p);
	}
	for (const { norad, rec } of rows) {
		const set = tles.get(norad);
		const item = document.createElement("div");
		item.className = "item";
		const label = document.createElement("label");
		const cb = document.createElement("input");
		cb.type = "checkbox";
		const state = set ? compare(set, rec) : "missing";
		cb.checked = !unchecked.has(norad) && (state === "newer" || state === "new");
		cb.disabled = !set || state === "same" || state === "older";
		cb.addEventListener("change", () => (cb.checked ? unchecked.delete(norad) : unchecked.add(norad)));
		label.append(cb, ` ${rec?.name || set?.name || "?"}  #${norad}`);
		label.className = "name";
		item.append(label);
		const meta = document.createElement("span");
		meta.className = "meta";
		if (!set) meta.append(tag("not in the data", "warn"));
		else {
			meta.append(`new set ${ageDays(set.epoch).toFixed(1)} days old   `);
			meta.append(state === "newer" || state === "new" ? tag(state === "new" ? "to store" : "newer", "ok") : state === "same" ? tag("already current", "") : tag("older than the radio's", "warn"));
		}
		if (!rec) {
			const rm = document.createElement("button");
			rm.textContent = "Remove";
			rm.addEventListener("click", () => { added.delete(norad); renderSets(); });
			item.append(rm);
		}
		item.append(meta);
		box.append(item);
	}
}

function addByInput() {
	const q = $("add-norad").value.trim();
	if (!q) return;
	const n = /^\d+$/.test(q) ? Number(q) : null;
	let norad = n;
	if (n === null) {
		const hits = [...tles.entries()].filter(([, s]) => s.name.toLowerCase().includes(q.toLowerCase()));
		if (hits.length !== 1) {
			say($("src-msg"), hits.length ? `${hits.length} names match: ${hits.slice(0, 5).map(([k, s]) => `${s.name} (#${k})`).join(", ")}. Use the number.` : "No name matches.", "warn");
			return;
		}
		norad = hits[0][0];
	}
	if (!tles.has(norad)) {
		say($("src-msg"), `#${norad} is not in the data read.`, "warn");
		return;
	}
	if (stored.length + added.size >= 32 && !stored.some((r) => r.norad === norad)) {
		say($("src-msg"), "The radio holds 32 satellites: delete one first.", "warn");
		return;
	}
	added.add(norad);
	$("add-norad").value = "";
	say($("src-msg"), "", "");
	renderSets();
}

async function updateRadio() {
	const ul = $("progress");
	ul.textContent = "";
	const choose = new Set();
	for (const r of stored) if (!unchecked.has(r.norad)) choose.add(r.norad);
	for (const n of added) choose.add(n);
	let lock = null;
	try { lock = await navigator.wakeLock?.request("screen"); } catch { /* not allowed: carry on */ }
	try {
		const results = await sat.update(link, tles, {
			add: [...added], choose,
			onResult: (r) => {
				const li = document.createElement("li");
				li.textContent = `${r.label} #${r.norad}: ${r.detail}`;
				li.className = r.outcome === "failed" ? "bad" : r.outcome === "updated" || r.outcome === "stored" ? "ok" : "";
				ul.append(li);
			},
		});
		const n = results.filter((r) => r.outcome === "updated" || r.outcome === "stored").length;
		const f = results.filter((r) => r.outcome === "failed").length;
		const li = document.createElement("li");
		li.textContent = f ? `${n} updated, ${f} failed.` : n ? `Done: ${n} updated.` : "Nothing needed updating.";
		li.className = f ? "bad" : "ok";
		ul.append(li);
		added.clear();
		await readStored();
	} finally {
		try { await lock?.release(); } catch { /* gone */ }
	}
}

// --- diagnostics ---

async function diagnostics() {
	const out = [];
	const v = await link.version();
	out.push("== version ==", ...Object.entries(v).map(([k, x]) => `${k}=${x}`));
	for (const s of ["tasks", "crash", "sat"]) {
		try {
			out.push(`== ${s} ==`, ...Object.entries((await link.view(s)).kv).map(([k, x]) => `${k}=${x}`));
		} catch (e) {
			out.push(`== ${s} ==`, `(${e.message})`);
		}
	}
	try {
		const b = await sat.bench(link, 100);
		out.push("== model ==", `${b.runs} runs, ${b.us} us: ${(b.us / Math.max(b.runs, 1)).toFixed(0)} us a run`);
	} catch { /* no satellites in this build, or no element set loaded */ }
	out.push("== page ==", `time=${new Date().toISOString()}`, `agent=${navigator.userAgent}`);
	$("diag-out").textContent = out.join("\n");
	$("diag-out").hidden = false;
	$("diag-copy").hidden = false;
}

// --- start ---

function init() {
	if (!serialSupported()) $("unsupported").hidden = false;
	tickPhone();
	setInterval(tickPhone, 1000);
	$("connect-btn").addEventListener("click", (e) => run(e.target, $("radio-info"), () => connect(false)));
	$("connect-known-btn").addEventListener("click", (e) => run(e.target, $("radio-info"), () => connect(true)));
	$("disconnect-btn").addEventListener("click", disconnect);
	$("clock-btn").addEventListener("click", (e) => run(e.target, $("clock-msg"), setClock));
	$("stored-btn").addEventListener("click", (e) => run(e.target, $("radio-info"), readStored));
	for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => setSource(b.dataset.src));
	$("net-btn").addEventListener("click", (e) => run(e.target, $("src-msg"), () => download(false)));
	$("net-force").addEventListener("click", (e) => run(e.target, $("src-msg"), () => download(true)));
	$("paste-btn").addEventListener("click", () => useText($("paste-text").value, "pasted"));
	$("file-in").addEventListener("change", async (e) => {
		const f = e.target.files[0];
		if (f) useText(await f.text(), f.name);
	});
	$("add-btn").addEventListener("click", addByInput);
	$("add-norad").addEventListener("keydown", (e) => { if (e.key === "Enter") addByInput(); });
	$("update-btn").addEventListener("click", (e) => run(e.target, $("src-msg"), updateRadio));
	$("diag-btn").addEventListener("click", (e) => run(e.target, $("radio-info"), diagnostics));
	$("diag-copy").addEventListener("click", async () => {
		try { await navigator.clipboard.writeText($("diag-out").textContent); say($("radio-info"), "Report copied.", "ok"); } catch { say($("radio-info"), "Couldn't copy: select the text instead.", "warn"); }
	});
	navigator.serial?.addEventListener("disconnect", () => { if (link) disconnect(); });
	if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
