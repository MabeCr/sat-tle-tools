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

**Connecting from a phone.** Chrome on Android gives Web Serial only to USB devices of the standard serial class (and to
Bluetooth serial ports), so an FTDI programming cable doesn't appear in its serial port list. The page therefore talks to
an FTDI cable (FT232R, FT231X and the like) directly over WebUSB on Android: use **Connect radio (USB cable)**. **Other
serial port** is the Web Serial list, for cables the phone does list. On a computer, **Connect radio** uses Web Serial
(the operating system's FTDI driver owns the cable there, so WebUSB can't claim it).

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
element set download. A change pushed to `main` is published again in a minute or two; reload the page once to pick it up. If a deployment times out on GitHub's side (it happens), pushing any small change to `main` starts a new one.

### Test

```bash
npm test                           # node --test: the logic against a fake radio, and against vectors from the host tool
npm install && npx playwright install chromium && npm run test:page   # the page in Chromium at a phone's size
```

GitHub Actions runs both on every push and pull request (`.github/workflows/test.yml`), and checks the vectors against
the firmware repository's every week.

### Where it comes from, and the one rule

This repository is the only copy of the page. It began as `tools/sat-web` in the RadioFoundry firmware work on satellite
tracking (<https://github.com/MabeCr/RadioFoundry-sat-firmware>, MIT licensed), which no longer holds it. The page applies
the same rules to element sets as that repository's host tool (`tools/rfoundry_debug.py sat update`), and
`test/vectors.json` is how the two agree: the host tool produces `tests/data/sat_update_vectors.json` there
(`tools/sat_vectors.py`), this copy must be identical, and the CI here fails when it isn't. To change the update rules,
change the host tool, regenerate the vectors, copy the file here, and make the tests pass.

| File | What |
|---|---|
| `lib/tle.js` | check digits, catalog numbers (Alpha-5), epochs, parsing, "newer or not" |
| `lib/frame.js`, `lib/link.js` | the radio's debug link: frames, requests, version, view sections |
| `lib/sat.js` | the SAT command and the update loop (the same rules as `rfoundry_debug.py sat update`) |
| `lib/serial.js` | Web Serial as a byte stream |
| `lib/ftdi.js` | an FTDI cable over WebUSB as a byte stream (baud divisor, status bytes, vendor requests) |
| `test/fakeradio.js` | a radio's debug link in memory |
