# sat-tle-tools
A collection of tools to help with satellite firmware for handheld radios.

## Satellite TLE tool (the page at the root of this repository)

A web page that updates a radio's satellite element sets (TLEs), sets its clock from the phone or computer and reads its
diagnostics, over the programming cable. It runs in the browser with Web Serial (Chrome or Edge on a computer, or Chrome
on an Android phone with the cable on an OTG adapter) and needs a radio running a RadioFoundry build with satellite
tracking (`SAT` in the features list of its `version`). Plain files, no build step.

### Use it

1. Open the page (see "Publish it" below). It downloads CelesTrak's amateur radio element sets at once (kept in the
   browser and not repeated within two hours; **Paste** and **File** are the fallbacks). No radio is needed yet.
2. **Choose satellites**: every set read is listed, with a search box and a check box each. The page counts the radio's
   32 places. *Preview what will be written* shows each chosen satellite's data age, inclination, period and height,
   and whether it is new on the radio, replaces an older set or is already current.
3. **Write to the radio**: plug the cable into the radio and the device, switch the radio on, **Connect radio** and
   choose the cable. Satellites already on the radio whose data has a newer set are ticked for you. *Write to the radio*
   sets the clock too (the box is ticked by default; the radio refuses a time before 2026) and then stores the chosen
   satellites. It sends this device's time zone with the clock (daylight saving included, to the nearest 15 minutes), so the
   radio's pass times are local; a radio whose firmware can't take the zone yet gets the clock alone and the page says so. A satellite that wasn't on the radio is stored with its **frequencies** (uplink, downlink, CTCSS tone and, for SO-50,
   the arming carrier) when the page has them: the table in `lib/profiles.js`, from AMSAT's FM satellite list and checked against
   SatNOGS DB. A satellite the radio already holds with no frequencies at all is filled in the same way; one that has any keeps
   them, since you may have set them. A satellite the table doesn't have is stored by name only.
   **Or send by sound** (no cable): the page plays the satellites chosen in step 2 as an audio signal, so a phone's speaker
   held at the radio's microphone can carry them. *Play to the radio* plays it; *Download the audio (WAV)* saves it to play from
   any player. Each satellite is one frame of 1200 baud AFSK and the whole list is sent twice, about 90 seconds for 32.
   The frequencies go in the same frames (a version 2 frame, 16 bytes more a satellite), under the same rule on the radio. It needs
   a radio whose firmware can receive it (a satellite build with *Receive sound*); the signal is specified in the firmware
   repository's `docs/spec/sound-transfer.md`. Only the satellites you chose are sent, up to 32.
4. **On the radio**: what the radio holds, read when you connect (so you can look before writing) and again after a
   write. *Delete* removes one.
5. **Advanced**: the *retune test* and *diagnostics*.
   - Retune test: receive only. It steps the receiver between a frequency (a NOAA weather channel by default,
     162.400 MHz; any steady FM carrier will do) and an offset of it, and times how long the signal takes to settle after
     each retune. That decides how Doppler correction can be done. Needs firmware with the retune test.
   - Diagnostics: read-only: version, tasks (free heap and stack), the last crash record, the satellite store and the
     orbit model's speed. *Copy report* puts it on the clipboard for a bug report.

**When CelesTrak can't be reached.** The page tries CelesTrak first. If that fails (the site is down, answers badly or
doesn't reply within 8 seconds), it falls back to this site's own copy, `tle/amateur.txt`, and says so, with how old the
copy is, and which list it came from. The copy is kept by a GitHub Action (`.github/workflows/tle-mirror.yml`) that downloads
CelesTrak's amateur group every six hours from GitHub's servers, checks that it parses, and commits it when it changed.
If CelesTrak can't be reached it takes [AMSAT's list](https://www.amsat.org/tle/current/nasabare.txt) instead (AMSAT sends no
cross-origin header, so a browser page can't read it directly, but the Action can). When neither works, the copy that is
there stays. Run it by hand from the repository's Actions tab (*tle-mirror*, *Run workflow*), for example after
turning this on the first time. The page still keeps the last download in the browser, and Paste and File still work. To add
another source, add it to `SAT_TLE_SOURCES` in `lib/source.js` (a host that allows cross-origin requests from the page).

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
`test/vectors.json` is how the two agree (and `test/sound_vectors.json`, from `tests/data/sat_sound_vectors.json` and `tools/sat_sound.py`, for the sound): the host tool produces `tests/data/sat_update_vectors.json` there
(`tools/sat_vectors.py`), this copy must be identical, and the CI here fails when it isn't. To change the update rules,
change the host tool, regenerate the vectors, copy the file here, and make the tests pass.

| File | What |
|---|---|
| `lib/tle.js` | check digits, catalog numbers (Alpha-5), epochs, parsing, "newer or not" |
| `lib/sound.js` | the sets as sound: the frame, HDLC and AFSK, a WAV file, playing it (the same frames and tone bits as the firmware repository's `tools/sat_sound.py`) |
| `lib/frame.js`, `lib/link.js` | the radio's debug link: frames, requests, version, view sections |
| `lib/sat.js` | the SAT command and the update loop (the same rules as `rfoundry_debug.py sat update`) |
| `lib/serial.js` | Web Serial as a byte stream |
| `lib/ftdi.js` | an FTDI cable over WebUSB as a byte stream (baud divisor, status bytes, vendor requests) |
| `test/fakeradio.js` | a radio's debug link in memory |
