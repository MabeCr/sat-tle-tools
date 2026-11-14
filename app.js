// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The RadioFoundry Authors
// The page: connect to the radio over Web Serial, set its clock, list and update its satellites, read diagnostics.
// All of the radio and TLE logic is in lib/ (tested in Node against a fake radio); this file only wires it to the DOM.
import { Link, LinkError } from "./lib/link.js";
import { FtdiStream, errorText as usbErrorText, usbSupported } from "./lib/ftdi.js";
import { SerialStream, errorText, serialSupported } from "./lib/serial.js";
import * as sat from "./lib/sat.js";
import { fetchSets } from "./lib/source.js";
import * as sound from "./lib/sound.js";
import { PROFILES_SOURCE, describe, profileFor } from "./lib/profiles.js";
import { compare, orbit, parse } from "./lib/tle.js";

const $ = (id) => document.getElementById(id);
const CACHE_KEY = "sat-web.tle";
const CACHE_MS = 2 * 3600 * 1000;	// CelesTrak asks for a group no more often than every two hours
const MIN_CLOCK = Date.UTC(2026, 0, 1) / 1000;	// the radio refuses a time before this too

let link = null, stream = null;
let how = "serial";		// how the radio is connected: "serial" (Web Serial) or "usb" (an FTDI cable over WebUSB)
const ANDROID = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
let stored = [];		// the radio's list, as sat.list gives it
let tles = new Map();		// the element sets read from the source
const picked = new Set();	// catalog numbers the user chose to write
const touched = new Set();	// ones the user ticked or cleared themselves: a connect doesn't change those
const SLOTS = 32;		// what the radio holds
let playing = null;		// the sound being played (lib/sound.js playAudio), if any

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
		const text = e instanceof LinkError ? (/no answer/.test(e.message) ? "The radio did not answer. Is it on, with the cable in, and not in a menu that holds the port?" : e.message) : (how === "usb" ? usbErrorText : errorText)(e);
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
	for (const id of ["write", "stored", "advanced"]) $(id).hidden = !connected;
	$("retune").hidden = false;
	$("connect-btn").hidden = connected;
	$("connect-alt-btn").hidden = connected || $("connect-alt-btn").dataset.none === "1";
	$("disconnect-btn").hidden = !connected;
}

async function connect(method) {
	$("connect-help").hidden = true;
	how = method;
	try {
		stream = method === "usb" ? await FtdiStream.choose() : await SerialStream.choose();
	} catch (e) {
		if (e?.name === "NotFoundError") $("connect-help").hidden = false;	// the chooser closed with nothing chosen (or listed)
		throw e;
	}
	link = new Link(stream);
	const v = await link.version();
	const features = (v.features || "").split(/[\s,]+/);	// the radio lists them comma separated: FM,SUBTONE,...,SAT,...
	if (!features.includes("SAT")) {
		say($("radio-info"), `${v.board || "This radio"} answered, but this firmware has no satellite tracking (SAT is not in its features). The diagnostics still work.`, "warn");
		show(true);
		for (const id of ["write", "stored", "retune"]) $(id).hidden = true;
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
	stored = [];
	show(false);
	renderSets();
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
	// The device knows its own offset, daylight saving included: the radio gets it too, so its times are local
	const zone = sat.zoneMinutes();
	const zoneSet = await sat.setClock(link, now, zone);
	await readClock();
	say($("clock-msg"), `Radio clock set to ${when(Math.floor(now))}${zoneSet ? `; time zone ${sat.zoneName(zone)}` : zone === null ? "" : ". Its firmware can't take the time zone yet: set it on the radio (Settings > Location)"}.`, "ok");
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
		p.textContent = "No satellites are stored yet: choose some in step 2 and write them.";
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
	// Satellites already on the radio whose data has a newer set start ticked, unless the user decided otherwise
	for (const r of stored) {
		const set = tles.get(r.norad);
		if (set && !touched.has(r.norad) && ["new", "newer"].includes(compare(set, r))) picked.add(r.norad);
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
		tles = new Map();
		$("choose").hidden = true;
		return;
	}
	say($("src-msg"), `${tles.size} element sets read${from ? ` (${from})` : ""}.`, "ok");
	picked.clear();
	touched.clear();
	$("progress").textContent = "";
	$("choose").hidden = false;
	for (const r of stored) {	// a radio is already connected: its satellites start ticked when the data is newer
		const set = tles.get(r.norad);
		if (set && ["new", "newer"].includes(compare(set, r))) picked.add(r.norad);
	}
	renderSets();
}

async function download(force) {
	let cached = null;
	try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { /* none */ }
	if (cached && !force && Date.now() - cached.t < CACHE_MS) {
		useText(cached.text, `kept from ${Math.round((Date.now() - cached.t) / 60000)} minutes ago`);
		return;
	}
	say($("src-msg"), "Downloading…");
	let got;
	try {
		got = await fetchSets();
	} catch (e) {
		if (cached) {
			useText(cached.text, "the last download: this one failed");
			return;
		}
		say($("src-msg"), `Couldn't download (${e.message}). Paste the text or choose a file instead: celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle`, "bad");
		return;
	}
	const { text, source, fetched, via } = got;
	// A copy kept on this site stands in when CelesTrak can't be reached: say so, and how old it is
	let from = "downloaded now";
	let old = false;
	if (source.id === "mirror") {
		const h = fetched === null ? null : (Date.now() / 1000 - fetched) / 3600;
		from = `CelesTrak could not be reached: ${source.name}${via ? ` from ${via}` : ""}${h === null ? "" : `, taken ${h < 1 ? "under an hour" : `${Math.round(h)} hours`} ago`}`;
		old = h !== null && h > 36;
	}
	try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), text })); } catch { /* full or private */ }
	useText(text, from);
	if (old) say($("src-msg"), `${$("src-msg").textContent} The copy is old: check the sets' ages below.`, "warn");
}

// Step 2: every set read, by name; the ticked ones are what step 3 writes
function slotsUsed() {
	return new Set([...stored.map((r) => r.norad), ...picked]).size;
}

function renderCount() {
	const used = slotsUsed();
	say($("count"), `${picked.size} chosen. ${link ? `${used} of ${SLOTS} places on the radio used after writing.` : `The radio holds ${SLOTS}.`}`, used > SLOTS ? "bad" : "");
	$("update-btn").disabled = used > SLOTS || (!picked.size && !$("clock-too").checked);
	renderPreview();
	renderSound();
}

function stateOf(set, norad) {
	return compare(set, stored.find((r) => r.norad === norad));
}

// What the frequencies of a satellite will be: the page's own profile (its source is in lib/profiles.js) goes to a satellite that
// is new on the radio and fills in one held with none; a radio keeps the frequencies it already has
function frequencyTag(n, known, rec) {
	const p = profileFor(n);
	if (known && rec && (rec.up_hz || rec.down_hz)) return tag("keeps the frequencies it has", "");
	if (p) return tag(known ? `${rec ? "frequencies filled in" : "stored with"}: ${describe(p)}` : `sends ${describe(p)} (a radio keeps the frequencies it already has)`, "ok");
	return tag(known ? "no frequencies known: stored by name only" : "no frequencies known for it", "warn");
}

function renderPreview() {
	$("profile-source").textContent = `Frequencies: ${PROFILES_SOURCE.list}, checked against ${PROFILES_SOURCE.checked}. A satellite the radio already holds with frequencies keeps them.`;
	const box = $("preview-list");
	box.textContent = "";
	const rows = [...picked].filter((n) => tles.has(n)).sort((a, b) => (tles.get(a).name || "").localeCompare(tles.get(b).name || ""));
	if (!rows.length) {
		const p = document.createElement("p");
		p.className = "muted";
		p.textContent = "Nothing chosen yet.";
		box.append(p);
	}
	for (const n of rows) {
		const set = tles.get(n), o = orbit(set), st = stateOf(set, n);
		const item = document.createElement("div");
		item.className = "item";
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = `${set.name || "?"}  #${n}`;
		const meta = document.createElement("span");
		meta.className = "meta";
		meta.append(`set ${ageDays(set.epoch).toFixed(1)} days old, inclination ${o.incl.toFixed(1)}°, period ${o.period_min.toFixed(1)} min, height about ${Math.round(o.alt_km)} km   `);
		// What the radio will do needs its list: without a connection nothing is said about the set, only about the frequencies
		const known = !!(stored.length || link), rec = stored.find((r) => r.norad === n);
		if (known) meta.append(st === "new" ? tag("new on the radio", "") : st === "newer" ? tag("replaces an older set", "ok") : tag(st === "same" ? "already current: skipped" : "older than the radio's: skipped", ""), " ");
		meta.append(frequencyTag(n, known, rec));
		item.append(name, meta);
		box.append(item);
	}
}

function renderSets() {
	const box = $("sets-list");
	box.textContent = "";
	if (!tles.size) {
		renderCount();
		return;
	}
	const q = $("filter").value.trim().toLowerCase(), only = $("only-picked").checked;
	const rows = [...tles.entries()].filter(([n, s]) => (!q || s.name.toLowerCase().includes(q) || String(n).includes(q)) && (!only || picked.has(n)))
		.sort((a, b) => (a[1].name || "~").localeCompare(b[1].name || "~") || a[0] - b[0]);
	if (!rows.length) {
		const p = document.createElement("p");
		p.className = "muted";
		p.textContent = only && !picked.size ? "Nothing is chosen yet." : "No satellite matches.";
		box.append(p);
	}
	for (const [norad, set] of rows) {
		const item = document.createElement("div");
		item.className = "item";
		const label = document.createElement("label");
		label.className = "inline name";
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.checked = picked.has(norad);
		cb.addEventListener("change", () => {
			touched.add(norad);
			if (cb.checked) picked.add(norad);
			else picked.delete(norad);
			renderCount();
		});
		label.append(cb, `${set.name || "?"}  #${norad}`);
		const meta = document.createElement("span");
		meta.className = "meta";
		meta.append(`set ${ageDays(set.epoch).toFixed(1)} days old   `);
		if (stored.length || link) {
			const st = stateOf(set, norad);
			if (st === "new") meta.append(tag("not on the radio", ""));
			else meta.append(st === "newer" ? tag("newer than the radio's", "ok") : st === "same" ? tag("on the radio, current", "") : tag("older than the radio's", "warn"));
		}
		item.append(label, meta);
		box.append(item);
	}
	renderCount();
}

async function updateRadio() {
	const ul = $("progress");
	ul.textContent = "";
	const line = (text, cls = "") => {
		const li = document.createElement("li");
		li.textContent = text;
		li.className = cls;
		ul.append(li);
	};
	let lock = null;
	try { lock = await navigator.wakeLock?.request("screen"); } catch { /* not allowed: carry on */ }
	try {
		if ($("clock-too").checked) {
			await setClock();
			line($("clock-msg").textContent, $("clock-msg").classList.contains("bad") ? "bad" : "ok");
		}
		if (!picked.size) return;
		const have = new Set(stored.map((r) => r.norad));
		const results = (await sat.update(link, tles, {
			add: [...picked].filter((n) => !have.has(n)), choose: new Set(picked), profile: profileFor,
			onResult: (r) => { if (r.outcome !== "skipped") line(`${r.label} #${r.norad}: ${r.detail}`, r.outcome === "failed" ? "bad" : r.outcome === "updated" || r.outcome === "stored" ? "ok" : ""); },
		})).filter((r) => r.outcome !== "skipped");
		const n = results.filter((r) => r.outcome === "updated" || r.outcome === "stored").length;
		const f = results.filter((r) => r.outcome === "failed").length;
		await readStored();
		line(f ? `${n} written, ${f} failed.` : n ? `Done: ${n} written. The radio's list is below.` : "Nothing needed writing.", f ? "bad" : "ok");
		$("stored").scrollIntoView?.({ block: "nearest" });
	} finally {
		try { await lock?.release(); } catch { /* gone */ }
	}
}

// --- the retune test ---

let retuneText = "";

async function retuneRun() {
	const freq = Number($("rt-freq").value), step = Number($("rt-step").value), count = Number($("rt-count").value), gap = Number($("rt-gap").value);
	const msg = $("rt-msg");
	if (!(freq >= 30 && freq <= 1000)) return say(msg, "The frequency is in MHz, for example 162.400.", "bad");
	if (!(Math.abs(step) >= 0.001 && Math.abs(step) <= 100)) return say(msg, "The step is in kHz, 0.001 to 100, either sign.", "bad");
	if (!Number.isInteger(count) || count < 1 || count > 32) return say(msg, "Retunes: 1 to 32.", "bad");
	if (!Number.isInteger(gap) || gap < 20 || gap > 1000) return say(msg, "Gap: 20 to 1000 ms.", "bad");
	if (count * gap > 10000) return say(msg, "Retunes times gap is at most 10 seconds.", "bad");
	$("rt-out").hidden = $("rt-copy").hidden = true;
	say(msg, "Running… the radio is busy for a few seconds and the audio will click.");
	const params = { base_hz: Math.round(freq * 1e6), step_hz: Math.round(step * 1e3), count, gap_ms: gap, wide: $("rt-width").value === "25" };
	let res;
	try {
		res = await sat.retuneTest(link, params);
	} catch (e) {
		if (e instanceof LinkError && e.status === 3) return say(msg, "A test is already running on the radio: wait a moment and try again.", "warn");
		if (e instanceof LinkError && e.status === 2) return say(msg, "The radio refused those values, or its firmware has no retune test yet.", "bad");
		throw e;
	}
	const sum = sat.retuneSummary(res);
	say(msg, sum.text, res.state === "refused" ? "warn" : sum.never ? "warn" : "ok");
	if (res.state !== "done") return;
	const lines = [`Retune test on ${freq} MHz, step ${step} kHz, ${count} retunes ${gap} ms apart, ${$("rt-width").value} kHz wide`,
		`Steady level ${res.ref_base} dBm on the base frequency, ${res.ref_step} dBm on the other; noise ${res.noise_base}`,
		" #  call us  settle us  lowest dBm  noise  no carrier"];
	res.hops.forEach((h, i) => lines.push(`${String(i + 1).padStart(2)} ${String(h.call_us).padStart(8)} ${(h.settle_us === null ? "never" : String(h.settle_us)).padStart(10)} ${String(h.min_rssi).padStart(11)} ${String(h.max_noise).padStart(6)} ${String(h.lost).padStart(11)}`));
	lines.push(sum.text);
	retuneText = lines.join("\n");
	$("rt-out").textContent = retuneText;
	$("rt-out").hidden = $("rt-copy").hidden = false;
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

// Or by sound: the chosen sets, in the order the preview lists them, played at the radio's microphone or saved as a file
function soundSets() {
	return [...picked].filter((n) => tles.has(n)).map((n) => ({ ...tles.get(n), profile: profileFor(n) }))
		.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

function renderSound() {
	const sets = soundSets(), n = sets.length;
	$("sound-play").disabled = !n || n > SLOTS || !!playing;
	$("sound-save").disabled = !n || n > SLOTS;
	if (playing) return;
	if (!n) say($("sound-info"), "Nothing is chosen yet: tick satellites in step 2.");
	else if (n > SLOTS) say($("sound-info"), `${n} chosen: a sound carries ${SLOTS} at most. Choose fewer.`, "bad");
	else say($("sound-info"), `${n} chosen: about ${Math.round(sound.seconds(sets))} seconds, every satellite sent twice.`);
}

function playSound() {
	const sets = soundSets();
	try {
		playing = sound.playAudio(sets);
	} catch (e) {
		say($("sound-msg"), e.message, "bad");
		return;
	}
	const p = playing;
	$("sound-stop").hidden = false;
	$("sound-play").disabled = true;
	$("sound-save").disabled = true;
	const tick = () => say($("sound-info"), `Playing: ${Math.min(Math.round(p.elapsed()), Math.round(p.seconds))} of ${Math.round(p.seconds)} seconds. Keep the speaker at the microphone and the room quiet.`);
	tick();
	const timer = setInterval(tick, 500);
	p.done.then((how) => {
		clearInterval(timer);
		playing = null;
		$("sound-stop").hidden = true;
		renderSound();
		say($("sound-msg"), how === "stopped" ? "Stopped." : "Finished. What the radio heard is on its own screen.", how === "stopped" ? "warn" : "ok");
	});
}

function saveSound() {
	const sets = soundSets();
	const { samples, rate, seconds } = sound.encode(sets, { rate: 48000 });
	const url = URL.createObjectURL(new Blob([sound.toWav(samples, rate)], { type: "audio/wav" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = `satellites-${sets.length}.wav`;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
	say($("sound-msg"), `Saved ${sets.length} satellites as a sound of ${Math.round(seconds)} seconds. Play it at the radio's microphone from any player.`, "ok");
}

// --- start ---

function init() {
	if (!serialSupported() && !usbSupported()) $("unsupported").hidden = false;
	tickPhone();
	setInterval(tickPhone, 1000);
	// A phone sees an FTDI cable only through WebUSB; a computer's driver owns it, so Web Serial is the first choice there
	const first = ANDROID && usbSupported() ? "usb" : "serial", other = first === "usb" ? "serial" : "usb";
	$("connect-btn").textContent = first === "usb" ? "Connect radio (USB cable)" : "Connect radio";
	$("connect-alt-btn").textContent = other === "usb" ? "FTDI cable over WebUSB" : "Other serial port";
	if (other === "usb" ? !usbSupported() : !serialSupported()) $("connect-alt-btn").dataset.none = "1", $("connect-alt-btn").hidden = true;
	$("connect-btn").addEventListener("click", (e) => run(e.target, $("radio-info"), () => connect(first)));
	$("connect-alt-btn").addEventListener("click", (e) => run(e.target, $("radio-info"), () => connect(other)));
	$("disconnect-btn").addEventListener("click", disconnect);
	$("clock-btn").addEventListener("click", (e) => run(e.target, $("clock-msg"), setClock));
	$("stored-btn").addEventListener("click", (e) => run(e.target, $("radio-info"), readStored));
	for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => setSource(b.dataset.src));
	$("net-btn").addEventListener("click", (e) => run(e.target, $("src-msg"), () => download(true)));
	$("paste-btn").addEventListener("click", () => useText($("paste-text").value, "pasted"));
	$("file-in").addEventListener("change", async (e) => {
		const f = e.target.files[0];
		if (f) useText(await f.text(), f.name);
	});
	$("filter").addEventListener("input", renderSets);
	$("only-picked").addEventListener("change", renderSets);
	$("clear-btn").addEventListener("click", () => { for (const n of picked) touched.add(n); picked.clear(); renderSets(); });
	$("clock-too").addEventListener("change", renderCount);
	$("update-btn").addEventListener("click", (e) => run(e.target, $("clock-msg"), updateRadio));
	$("sound-play").addEventListener("click", playSound);
	$("sound-stop").addEventListener("click", () => playing?.stop());
	$("sound-save").addEventListener("click", (e) => run(e.target, $("sound-msg"), async () => saveSound()));
	$("rt-btn").addEventListener("click", (e) => run(e.target, $("rt-msg"), retuneRun));
	$("rt-copy").addEventListener("click", async () => {
		try { await navigator.clipboard.writeText(retuneText); say($("rt-msg"), "Results copied.", "ok"); } catch { say($("rt-msg"), "Couldn't copy: select the text instead.", "warn"); }
	});
	$("diag-btn").addEventListener("click", (e) => run(e.target, $("radio-info"), diagnostics));
	$("diag-copy").addEventListener("click", async () => {
		try { await navigator.clipboard.writeText($("diag-out").textContent); say($("radio-info"), "Report copied.", "ok"); } catch { say($("radio-info"), "Couldn't copy: select the text instead.", "warn"); }
	});
	navigator.serial?.addEventListener("disconnect", () => { if (link) disconnect(); });
	navigator.usb?.addEventListener("disconnect", () => { if (link && how === "usb") disconnect(); });
	renderSets();
	download(false);	// a radio isn't needed to see what there is to choose from
	if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
