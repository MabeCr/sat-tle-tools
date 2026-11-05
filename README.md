# sat-tle-tools
A collection of tools to help with satellite firmware for handheld radios.

## Satellite TLE tool (the page at the root of this repository)

A web page that updates a radio's satellite element sets (TLEs), sets its clock from the phone or computer and reads its
diagnostics, over the programming cable. It runs in the browser with Web Serial (Chrome or Edge on a computer, or Chrome
on an Android phone with the cable on an OTG adapter) and needs a radio running a RadioFoundry build with satellite
tracking (`SAT` in the features list of its `version`). Plain files, no build step.

### Use it

1. Open the page (see "Publish it" below), plug the cable into the radio and the device, switch the radio on.
2. **Connect radio**, and choose the cable.
3. **Clock**: *Set the radio's clock from this device* (the radio refuses a time before 2026).
4. **Update element sets**: Download (CelesTrak's amateur group, kept in the browser and not repeated within two hours),
   Paste, or File. The page lists the satellites on the radio and whether the data has a newer set; add one that isn't
   stored by catalog number (or an exact name); **Update the radio**.
5. **Diagnostics**: read-only: version, tasks (free heap and stack), the last crash record, the satellite store and the
   orbit model's speed. *Copy report* puts it on the clipboard for a bug report.

Only one program may hold the serial port at a time: close any other tab or tool using the cable.

### Run it on a computer

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000` in Chrome or Edge (`localhost` counts as a secure context, which Web Serial needs).

### Publish it (GitHub Pages)

Web Serial needs `https`, so a phone needs the page at a real address. In this repository: **Settings > Pages > Build and
deployment > Source: Deploy from a branch**, branch `main`, folder `/ (root)`, Save. After a minute the address is at the top of
that page: `https://<user>.github.io/sat-tle-tools/`. Open it in Chrome on the phone and, once it works, *Add to Home
screen* / *Install app*: it then opens like an app and, with the service worker, works with no coverage using the last
element set download. A change pushed to `main` is published again in a minute or two; reload the page once to pick it up.

### Test

```bash
node --test test/*.test.mjs        # the logic against a fake radio, and against vectors from the host tool
node test/page.e2e.mjs [shot.png]  # the page in Chromium (Playwright) at a phone's size
```

### Where it comes from

This is `tools/sat-web` of the RadioFoundry firmware work on satellite tracking
(<https://github.com/MabeCr/RadioFoundry-sat-firmware>, MIT licensed). `test/vectors.json` is produced there by
`tools/sat-web/test/make_vectors.py` from the host tool `tools/rfoundry_debug.py`, so the page and the tool apply the same
rules to element sets; change it there, not here.

| File | What |
|---|---|
| `lib/tle.js` | check digits, catalog numbers (Alpha-5), epochs, parsing, "newer or not" |
| `lib/frame.js`, `lib/link.js` | the radio's debug link: frames, requests, version, view sections |
| `lib/sat.js` | the SAT command and the update loop (the same rules as `rfoundry_debug.py sat update`) |
| `lib/serial.js` | Web Serial as a byte stream |
| `test/fakeradio.js` | a radio's debug link in memory |
