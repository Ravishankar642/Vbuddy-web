# VBuddy 1.0

The browser-based VBuddy: a **bridge** that runs on your sim PC and streams MSFS data, plus a **web client** you open on any phone, tablet or browser.

This folder is separate from the C# vPilot plugin in the parent folder. They don't share code or build steps.

```
webapp/
  packages/
    protocol/   message formats shared by everything (typed + validated)
    bridge/     Node app on the sim PC: SimConnect -> WebSocket + serves the web client
    web/        React web client (installable PWA)
    relay/      Small server for a cloud VM: https/wss access from outside your home
  plugin/       VBuddy Link: a new vPilot plugin (C#) that feeds chat and the VATSIM connection to the bridge
  deploy/relay/ Caddy + systemd + setup script for the relay VM
```

## Status

| Part | What | State |
|---|---|---|
| 0 | Monorepo + shared protocol | done |
| 1 | Bridge (SimConnect -> WebSocket), LAN dashboard, Fenix variable discovery | done |
| 2 | Landing analyzer: touchdown rate, G, flare trace, bounces, wind | done |
| 3 | Flight log on disk (SQLite) + replay after long disconnects | done |
| 4 | PWA shell (install to home screen, offline) | done |
| 5 | Live map + VATSIM traffic + ATC alerts | done (IVAO not yet) |
| 6 | Glass cockpit: Fenix FCU knobs | done |
| 7 | Cloud relay on Oracle VM (https, 5G access) + push notifications | done |
| 7b | Comms: Zulu clock, VATSIM status, radios/squawk, chat, unread badge + chime, chat push, new vPilot plugin | done (needs a real vPilot test) |
| 7c | Flight controls for other aircraft | discovery tool and lights card done; **cockpit controls are Airbus-only in 1.0**; PMDG code built but switched off; iniBuilds, iFly, FSLabs panels not started |
| 8 | Version 1.0.0: Windows installer + portable zip, settings file, docs | done |

## Install (Windows, sim PC)

1. Download `VBuddy-Setup-1.0.0.exe` and run it. It includes everything (no Node.js needed). Tick:
   - The installer always opens VBuddy's port (TCP 4789) in Windows Firewall, for every network type, and allows its own node.exe, so phones and tablets can connect (it also removes any earlier "Block" rule for it). Remove them at any time by uninstalling.
   - **Install the VBuddy Link plugin into vPilot**: needed for chat and VATSIM connect/disconnect from the app. Restart vPilot afterwards.
   - **Start VBuddy when I sign in** (ticked by default; untick it if you prefer to start it yourself).
2. Start **VBuddy** from the Start menu (the installer can also start it for you). It opens the **VBuddy window** and keeps running as an icon in the notification area (Windows usually puts new icons under the **^ hidden icons** arrow; drag it onto the taskbar if you like). Close the window any time; VBuddy keeps running. Double-click the icon to open the window again.
   The window shows what you need: simulator and vPilot status, the **address for your phone** (with a QR code), the **pairing code**, the **cloud relay** switch with its phone link, and the devices you have paired (with *Forget*).
   Right-click the icon for: *Open VBuddy window*, *Open VBuddy app in browser*, *Copy address for phone*, *Show pairing code*, *Settings*, *View log*, *Start with Windows*, *Restart*, *Exit*.
3. On the phone, open the address (same Wi-Fi), or scan the QR code. To **control the cockpit**, type the 6-digit pairing code from the window on the phone's Cockpit tab. Away from home: switch on *Cloud relay* in the window and open its phone link (see "Away from home").

Prefer no installer? Unzip `VBuddy-1.0.0-win-x64.zip` anywhere and run `VBuddy.vbs` (tray icon) or `VBuddy.cmd` (shows a window with the log, useful when something is wrong).

**Settings** (relay for away from home, port, notifications): Start menu > *VBuddy settings* opens `%APPDATA%\VBuddy\config.env`. Every line is commented; remove the `#` of the ones you want, save, restart VBuddy. Command-line options (`VBuddy.cmd --help`) and Windows environment variables override the file.

**Update:** run the new installer over the old one. Your flight log, landings, pairings and settings (in `%APPDATA%\VBuddy`) are kept. **Uninstall:** Windows Settings > Apps; it asks whether to delete that data folder too and removes the firewall rule.

### Troubleshooting
| Problem | Check |
|---|---|
| Phone can't open the address | Same Wi-Fi as the PC (not a guest network). Windows network type is *Private* (Settings > Network). Firewall rule present (re-run the installer, or in an administrator PowerShell: `netsh advfirewall firewall add rule name=VBuddy dir=in action=allow protocol=TCP localport=4789 profile=any`). |
| "Bridge not reachable" after a restart | VBuddy must be running: look for its icon in the notification area (under ^). If it is missing, start VBuddy again; if it keeps vanishing, right-click > *View log*, or start *VBuddy with a window (for troubleshooting)*. |
| No tray icon appears | Some antivirus tools block hidden PowerShell scripts. Use *VBuddy with a window (for troubleshooting)* instead, and allow `tray.ps1` in your antivirus if you want the icon. |
| Cockpit tab says view-only | Pair the device with the code from the PC's Cockpit tab. |
| Chat or Connect doesn't work; header says *vPilot not linked* | Install the VBuddy Link plugin, restart vPilot, then start VBuddy. If it still fails, send `VBuddyLink.log` (next to the plugin DLL in `%LOCALAPPDATA%\vPilot\Plugins`) and VBuddy's log (tray icon > *View log*). |
| Radios or squawk don't change in the sim | The aircraft may own its radios. Report the aircraft; `Find aircraft controls` in the Start menu makes a report. |
| Fenix FCU says "not reaching the aircraft" | Check the MobiFlight WASM module is in the Community folder, then *Retry*. |
| Away from home | Switch on *Cloud relay* in the VBuddy window; see "Away from home" below. |

### What works in 1.0 (and what doesn't)
- Works: flight dashboard, map with VATSIM traffic and ATC alerts, landing log, Fenix A320 FCU/EFIS, lights on every aircraft, comms and chat through vPilot, pairing, relay and notifications.
- Cockpit controls are **Airbus-only**; other aircraft show a notice. PMDG 737/777 support is built but off until the SDK files can be read from a real install (see the PMDG section).
- Phone audio: the Comms tab opens VATSIM Listen (receive only). Talking from a phone is not available.
- IVAO traffic is not included.
- Written and tested with a mock flight and automated tests; see the project notes for what still needs checking in a real sim.

## Build a release (developers)

Needs Node 22.13+, pnpm, and for the installer [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`winget install JRSoftware.InnoSetup`). For the vPilot plugin, the .NET SDK and vPilot installed on the same PC.

```powershell
pnpm package
```

Builds every package, bundles the bridge (`esbuild`), downloads the matching Windows Node.js (checked against nodejs.org's published checksum), builds the plugin when it can, and writes `release\VBuddy-1.0.0-win-x64.zip`, `release\VBuddy-Setup-1.0.0.exe` and `release\SHA256SUMS.txt`. Options: `--no-build`, `--skip-plugin`, `--plugin-dll <path>`, `--skip-installer`, `--skip-node`.

## Run from source (developers)

### One-time setup (Windows, sim PC)

1. Install **Node.js 22.13 or newer** (22 LTS or 24) from https://nodejs.org (tick "Add to PATH").
2. Install pnpm: open PowerShell and run `npm install -g pnpm`
3. In this folder: `pnpm install` (run it again after updates that add packages; Part 5 added the map library)

## Run it

**With MSFS 2024:**

```powershell
pnpm start
```

The bridge prints the addresses to open, e.g. `http://192.168.1.20:4789`. Open that on your tablet (same Wi-Fi). The bridge can start before MSFS does; it connects when the sim is running and reconnects if the sim restarts.

The first time, Windows Firewall may ask about Node.js. Allow it on **Private networks**, or other devices can't connect.

**Without MSFS (built-in test flight):**

```powershell
pnpm start:mock
```

The mock flies a circuit of about 4 minutes: takeoff, climb to 1,500 ft, descent, approach and landing, then repeats. It cycles through three landings (smooth -110 fpm, firm -380 fpm, hard -520 fpm with a bounce) so you can see every kind of debrief.

For landing practice without waiting for the climb, use `pnpm start:mock-quick`. It starts on a short final and lands about every 2 minutes.

**While developing (hot reload):**

```powershell
pnpm dev        # real sim
pnpm dev:mock   # test flight
```

Open `http://localhost:5173` (or the Network URL Vite prints, from your tablet).

### Bridge options

`node packages/bridge/dist/index.js --help` lists them all:

| Option | Default | |
|---|---|---|
| `--port` | 4789 | HTTP + WebSocket port |
| `--hz` | 5 | Live update rate to clients (1-30) |
| `--backlog` | 15 | Minutes of telemetry kept in memory for reconnecting clients (older data comes from the flight log) |
| `--host` | 0.0.0.0 | Use `127.0.0.1` to keep it to this PC only |
| `--simconnect host:port` | auto | Connect to SimConnect over TCP instead of auto-detect |
| `--control` | on | `off` makes every device view-only (no cockpit commands) |
| `--network` | vatsim | `vatsim` for traffic, online ATC and boundary alerts, or `off` |
| `--callsign` | auto | Your VATSIM callsign, if automatic detection picks the wrong one |
| `--relay on\|off\|wss://host` | off | `on` = the shared VBuddy relay, or your own `wss://` address (see "Away from home"). The VBuddy window has a switch for this too, which wins over the file |
| `--relay-access` | paired | `paired`: devices reaching you through the relay must pair before they see anything. `open`: anyone with the address can watch |
| `--push` | on | Phone notifications (ATC changes, touchdown result) for paired devices |
| `--push-contact` | `mailto:vbuddy@example.com` | A contact address sent to the browsers' push services; use your own email |
| `--mock` | off | Built-in test flight |
| `--mock-quick` | off | With `--mock`: start on short final, land every ~2 minutes |
| `--keep-hours` | 24 | Hours of telemetry kept in the flight log. `0` = don't record telemetry (landings are still saved) |
| `--data-dir` | `%APPDATA%\VBuddy` | Where the flight log (`flights.db`) is saved. The mock flight doesn't save unless you set this |

## Landing analyzer

The bridge watches **every sim frame** (not the 5 Hz stream your tablet gets) and keeps the last 45 seconds. When the aircraft goes from flying to on the ground it records one landing and follows it until the aircraft has settled (3 seconds on the ground) or flown away again. Open the **Landings** tab to see it. If a landing happens while you're on the Flight tab, a banner appears with a View button. Landings that happen while your tablet was offline show up as soon as it reconnects.

What each landing records:

- **Touchdown rate (fpm).** Taken from the simulator's own touchdown measurement (`PLANE TOUCHDOWN NORMAL VELOCITY`) when it is available. If not, it is estimated from the fastest descent in the 0.4 s before contact. The debrief says which one was used, and flags when the two disagree by more than 60 fpm.
- **Peak G** from just before contact to 1 second after.
- **Pitch, bank, IAS, ground speed** at first contact, **wind** (headwind and crosswind) at touchdown.
- **Bounces:** a hop of at least 2 ft and 0.3 s counts. The rate always refers to the *first* contact.
- **Touch-and-go:** flagged when the aircraft is flying again (100 ft or 8 s) within seconds of touching down. A touch-and-go with a long ground roll before lift-off is recorded as a normal landing.
- **Flare:** sink rate at 50, 30 and 10 ft, the peak sink in the last 100 ft and how much the flare eased it, and the pitch change from 50 ft.
- **Trace:** height, vertical speed, pitch, airspeed and G at about 10 samples per second, from 20 s before to 3 s after. Heights are measured from the touchdown point, so aircraft whose "altitude above ground" doesn't read zero on the runway are fine.
- **Sparse data flag:** if frames were too far apart around touchdown (a stutter, a very low frame rate) the landing is marked approximate.

**Rating.** The worse of two measures decides:

| Rating | Descent rate | Peak G |
|---|---|---|
| Butter | up to 100 fpm | up to 1.20 |
| Smooth | up to 200 | up to 1.40 |
| Normal | up to 300 | up to 1.60 |
| Firm | up to 450 | up to 1.85 |
| Hard | up to 600 | up to 2.10 |
| Severe | over 600 | over 2.10 |

These bands are this project's own, tuned for sim use. They aren't an airline or manufacturer standard.

**Where landings are saved.** In the flight log (`flights.db`, see below). The newest 500 are kept in memory and served. The same data is available as JSON at `/api/landings` and `/api/landings/<id>`. If you ran Part 1 or 2 and have a `landings.jsonl`, the bridge moves it into the database the first time it starts and renames it `landings.jsonl.imported` (it is never deleted).

**First real-sim check** (the analyzer is tested with synthetic and mock flights, not yet with MSFS): fly one landing and look at the bridge console. It prints a line like `Touchdown -142 fpm (sim), 1.18 g, SMOOTH`.

- `(sim)` means the simulator's own value was used. `(estimated)` means MSFS didn't provide it; the landing still works.
- On the Landings tab, if you see "Frame data shows N fpm" under the headline, the two measurements disagree. Please send me both numbers.
- Check that pitch is **positive when the nose is up**.

## Cockpit: the Fenix A320 FCU

The **Cockpit** tab is the Fenix A320's FCU and the captain's EFIS control panel, live from the sim and operable from your tablet.

- **Knobs:** tap the left half for one click down, the right half for one click up, hold to keep turning, or drag your finger round the knob. On a keyboard: arrow keys, Page Up/Down for 10 clicks.
- **Push / Pull** buttons sit above and below each knob, labelled with what they do (selected, managed, level off, STD…).
- **Type a value:** tap a window (SPD, HDG, ALT, V/S), enter e.g. `270`, `FL350`, `-1500` or `0.78`. VBuddy turns the knob, reads the window back and corrects, and only says it's done once the FCU shows your value. For big altitude changes it uses the 100/1000 ft switch and puts it back.
- **Buttons:** LOC, AP1, AP2, A/THR, EXPED, APPR (with their lights), SPD/MACH, HDG-V/S/TRK-FPA, METRIC ALT, and the EFIS FD, LS, CSTR, WPT, VOR.D, NDB, ARPT and ND mode.

**How commands reach the Fenix.** Through the **MobiFlight WASM module**, the same way the VBuddy vPilot plugin already does it, so if that works, this works. Each command is checked: VBuddy watches the Fenix's own counter for that control and reports "working" only when it moved. If MobiFlight doesn't answer twice in a row, VBuddy tries direct SimConnect writes instead. If neither works, the tab says so and offers **Retry**. Commands are paced about 60 ms per click, which is what the Fenix reliably takes, so a 180° heading change typed in takes several seconds.

**What's confirmed and what isn't** (from your discovery run on 12 Oct):

| | |
|---|---|
| Confirmed | all four FCU windows and knobs, ALT and V/S push/pull, AP1, AP2, A/THR, LOC, APPR, EXPED buttons, AP1/AP2/A/THR/EXPED lights, speed managed dot, speed and V/S dashes, baro knob and display, ND mode, FD, LS, CSTR, WPT, VOR.D, NDB, ARPT |
| Not yet seen working | SPD and HDG push/pull, baro push/pull (STD), SPD/MACH, HDG-V/S/TRK-FPA, METRIC ALT, heading/altitude managed dots, LOC/APPR lights (they never lit during discovery, probably because no ILS was tuned) |

Controls in the second row have a dotted outline. Try them and tell me what happens; they're mapped by the same pattern as their confirmed neighbours.

**Pairing (who may press buttons).** Anyone on your network can *watch*. To *control*:

- VBuddy opened **on the bridge PC itself** can always control.
- A **phone or tablet** pairs once: open the Cockpit tab on the PC (or look at the bridge window) for a 6-digit code, and enter it on the device. The code works for one device and changes every 10 minutes. After 5 wrong codes, a device must wait a minute.
- The device keeps a long random key from then on (only a fingerprint of it is stored on the PC, in `paired-devices.json`). Remove a device from the list on the PC's Cockpit tab and it is view-only again at once.
- `--control off` turns all control off.

## Comms: radios, squawk, VATSIM connection and chat

The header always shows a **Zulu clock** (`HH:MM:SSz`, from the device's clock) and a **VATSIM status** (`VATSIM BAW123` when connected, `VATSIM off`, or `vPilot not linked`).

The **Comms** tab has:

- **Avionics:** COM1/COM2 active and standby (type a frequency, **Set**, **⇄** swap, one-tap UNICOM), the squawk code (type 4 digits, or tap 1200 / 7000 / 2000), **STBY/ALT**, **IDENT**, and a **VATSIM switch** that connects (callsign, aircraft type, optional SELCAL, prefilled from last time) or disconnects (asks to confirm).
- **Messages:** one conversation per frequency you're tuned to (UNICOM 122.800 is labelled), per direct-message callsign (type a callsign in "New DM"), plus Broadcasts and System. Sending on a frequency needs a radio tuned to it; if neither is, the app offers "Tune COM1 / COM2". Radio messages go out on the radio **vPilot is set to transmit on**.
- **Alerts:** a red badge on the Comms tab counts unread messages that matter (DMs, SELCAL, and radio calls that use your callsign). A toast appears on other tabs, and a two-note **chime** plays (switch it off or test it on the Comms tab; browsers only allow sound after you've tapped the page once). With notifications on (Flight tab), the same messages arrive as a **push alert** with the app closed ("Messages" checkbox). The badge also appears on the home-screen icon where the browser supports it.

Who can see and do what: the radios, squawk, VATSIM switch and chat need the bridge PC or a **paired** device, like the cockpit. Chat is **never** shown to unpaired devices (DMs are private), and nothing is saved to disk (the last 500 messages are kept in the bridge's memory; your callsign and type are remembered for the connect form).

How it works: the COM radios and transponder are read and set through SimConnect (the vPilot plugin SDK has no calls for them; vPilot follows the sim's radios). Chat, connect/disconnect and ident go through the **VBuddy Link plugin** in vPilot. See `plugin/README.md` for building and installing it. It is a new, separate plugin; the old VBuddy notification plugin is not touched and the two can run side by side.

Try it without MSFS or vPilot: `pnpm start:mock` has pretend radios and a pretend VATSIM session that sends an ATC call, UNICOM chatter and a DM every 25 seconds.

Not verified on real hardware: SimConnect radio/transponder events in MSFS 2024 (some add-on aircraft manage their own transponder and may ignore the mode switch), the plugin against the real vPilot SDK, and vPilot's frequency number format (handled in several forms).

## Map, VATSIM traffic and ATC alerts

The **Map** tab shows your aircraft and the track you've flown, other VATSIM pilots, and the ATC that is online: centre sectors (blue outlines), approach areas (purple), and airport badges with a letter for each open position (**D**elivery, **G**round, **T**ower, **A**pproach) plus the ATIS letter. Tap a badge or sector for frequencies; tap an aircraft for its type, route, altitude and speed. Dragging the map stops it following you; **Follow aircraft** brings it back. Callsigns appear from zoom level 7. Below the map: **Your ATC** and the nearest traffic.

The bridge on your PC does the network work, so your phone only receives what is near you:

- It reads the VATSIM data feed every 15 s (that is how often VATSIM updates it), but only while a phone/tablet or the sim is connected. If VATSIM can't be reached it retries with back-off and the map says so. Nothing else is affected.
- It sends each device only the traffic inside its map view (up to 300 aircraft). Between updates, aircraft are moved along their heading so they don't jump every 15 s.
- It finds **you** on VATSIM (the pilot at your position, height and heading) and leaves you out of the traffic. If it picks the wrong one, start the bridge with `--callsign YOURCALL`.
- Sector shapes come from the [VATSpy data project](https://github.com/vatsimnetwork/vatspy-data-project) (CC BY-SA 4.0) and approach areas from the [SimAware TRACON project](https://github.com/vatsimnetwork/simaware-tracon-project). The bridge downloads them once a day into `%APPDATA%\VBuddy\network` and uses the saved copy if GitHub can't be reached. An approach unit with no published shape gets a 35 nm circle round its airport.

**Your ATC** (on the Flight and Map tabs) is the controller you should be talking to: the lowest online unit whose airspace you're in. If the tower is offline the approach controller covers the airport, then centre, as on VATSIM. Rules VBuddy uses:

| Position | Covers you when |
|---|---|
| Ground (then Delivery) | you're on the ground within 4 nm of its airport |
| Tower | below 3,000 ft above ground, inside its published area or within 8 nm of the airport |
| Approach / Departure | below 18,000 ft, inside its area |
| Centre, then FSS | inside its sector (the smallest matching sector wins when several are online) |

These are VBuddy's approximations. The real sector limits (especially vertical ones) vary by region, so treat the card as a strong hint, not an instruction. When it says UNICOM, nobody covers you: 122.800.

**Alerts** appear as a banner on any tab:

- **New controller:** you've been in a different controller's airspace for 5 seconds (so wobbling along a boundary doesn't spam you), or a controller has logged on above you. The banner reads "Contact *name* on *frequency* (*callsign*)."
- **Coming up:** looking 10 minutes ahead along your track at your ground speed, the next controller and roughly when you'll get there. Announced once per boundary.
- **Leaving ATC coverage:** the next stretch has nobody online.

The bridge console logs each alert too.

**Not included yet:** IVAO (its live data format couldn't be confirmed). The map's background is Esri's Dark Gray Canvas (no API key needed), so the tablet needs internet for it. Esri's terms ask for the attribution shown on the map and are intended for light, non-commercial use like this. The aircraft, traffic and sectors come from the bridge.

## Brief: SimBrief flight plan and airport weather

Open the VBuddy window on the PC and type your **SimBrief name or pilot ID** under *Your accounts*, then Save. The app's **Brief** tab shows your latest SimBrief plan (route, off-blocks time, time en route, distance, cruise, fuel, weights) and a card for the departure, arrival and alternate airports with the decoded METAR, the raw report, the planned runway and, on request, the TAF. You can also look up any airport by ICAO code. Generate a new plan on SimBrief and press **Refresh** to pick it up.

- The bridge PC fetches the plan from SimBrief and the weather from the US Aviation Weather Center (free, no account), so it needs an internet connection. Plans are cached for a minute and weather for five.
- The **Hoppie logon code** field is stored the same way and is used by the upcoming ACARS messaging. It is kept in `integrations.json` in the VBuddy data folder, readable only by your Windows account, and is never sent to the relay or to a phone.
- Flight category follows the US rule: VFR above 5 miles and 3000 ft, Marginal VFR 3 to 5 miles or 1000 to 3000 ft, IFR 1 to 3 miles or 500 to 1000 ft, Low IFR below that.

## Aircraft alerts and notification settings

On the Flight tab, under **Notifications** (pair the device first, and use the relay's https address or the installed app), choose what you want to hear about. Everything is per device, so a phone and a tablet can differ.

| Setting | What it does |
|---|---|
| ATC changes and boundaries | New controller, and a boundary coming up. |
| Tell me about an ATC boundary when it is N nm ahead | 10 to 150 nm along your track (default 40). |
| Boundary and no-ATC notices | Optional limit per hour (default no limit). "Contact ..." calls are never limited. |
| Messages, Touchdown result | As before. |
| VATSIM connected / disconnected | A notice when vPilot connects or drops. If vPilot itself is closed, the notice says so. |
| Aircraft alerts | Engine stopped, stall warning, overspeed, gear up low, high sink rate, low fuel. |
| Top of descent | A notice a chosen number of minutes (5 to 30, default 10) before the descent should start. Needs your SimBrief plan: it uses the plan's TOD point, or, if the plan has none, 3 nm for every 1,000 ft before the destination. Sent once per flight, only above 10,000 ft and while not yet descending; joining a flight already close to the point stays quiet. Pick "Don't tell me" to turn it off. |
| Autopilot switches off in the cruise | Off by default. A notice when the autopilot, which had been on for at least 30 seconds, stays off for 2 seconds while you are more than 3,000 ft above the ground. Switching it off to land does not trigger it. |
| Low fuel | Warns when the fuel left would last less than 15 to 90 minutes (default 30), or never. |

How the aircraft alerts decide:

- **Engine stopped:** an engine that was running for 15 seconds or more stops for 3 seconds while airborne. Shutting down on the ground is ignored. The aircraft must report engine combustion; if it doesn't, there is no engine alert.
- **Stall and overspeed:** the simulator's own warning, held for 1 s and 2 s while airborne.
- **Gear up:** gear not down, below 800 ft above ground and descending. **Sink rate:** faster than 2,000 ft/min down below 1,000 ft above ground. Each once per approach.
- **Low fuel:** minutes left = fuel on board divided by the burn over the last 3 minutes (in sim time, so it follows sim rate). No estimate until a minute of flight data exists, or while nothing is burning.
- The same alert repeats at most once a minute. The open app also shows it as a red or amber banner with a chime.
- Add-on aircraft such as the Fenix may handle fuel and engines outside the sim's standard variables. If an alert never fires for yours, tell me which aircraft and what the sim reports.

## ACARS: Hoppie telex, CPDLC, clearance and weather

1. Get a logon code at hoppie.nl/acars and enter it in the VBuddy window on your PC (Your accounts, then Save).
2. Open the Comms tab on a paired device and switch to **ACARS**.

- **Sending as:** your VATSIM callsign when vPilot is connected, otherwise the callsign from your SimBrief plan.
- **Telex:** type the station (for example `EDDF_DEL`) and the message. Hoppie messages are upper case.
- **Pre-departure clearance:** enter the clearance station, optional stand and ATIS letter. The request text (callsign, aircraft, departure, arrival) comes from your SimBrief plan. The reply arrives as a telex.
- **Weather:** METAR, TAF or ATIS for any airport. The answer arrives within about a minute, in the list.
- **CPDLC:** request a logon to an ATC unit, then answer its messages with the buttons under each one.
- The bridge checks Hoppie about once a minute while the simulator is connected (Hoppie asks users not to check more often). **Check now** is limited to once every 20 seconds. The list keeps the last 200 messages and is cleared when the bridge restarts.
- Messages are private to the PC and paired devices, like direct messages.
- Not yet tested against the live Hoppie network from the development machine: if a message type misbehaves, send me the exact text shown and what you expected.

## Android app (APK)

The `android/` folder is a small Android shell around the web app; see `android/README.md` for how to build the APK with Android Studio and install it.

## The app layout (map first)

The app is a full-screen map with a bottom sheet (on a tablet or PC: a side panel) and a floating tab bar, like a flight-tracking app. Drag the handle to make the sheet smaller or larger.

| Tab | What is in it |
|---|---|
| **Flights** | Live (your instruments), My flights (your saved flights), Traffic (your ATC and nearby network traffic) |
| **Systems** | Overview, Engines, Autopilot, Fuel, Electrical, Cabin and weather, and **Controls** (the knobs, lights and simulator buttons that used to be the Cockpit tab) |
| **Inbox** | Radios, messages and ACARS (was Comms) |
| **Atlas** | Flight record and every landing (was Landings) |
| Search button | Airport weather and your SimBrief plan (was Brief) |
| Round button at the top right | Settings: appearance, notifications, install, connection details |

The round buttons on the map switch appearance, network traffic, ATC sectors and airports, and following your aircraft. The pill at the top left says how the app reaches your PC and whether the simulator is connected. Old links such as `#cockpit` still open the right page.

## Simulator and systems (Systems tab, Controls)

Under the lights, every aircraft gets a **Simulator and systems** card: pause and resume, gear, spoilers arm, parking brake, start or stop all engines (stopping asks for a second tap), APU, pitot heat, seat belt sign, flaps up and down by one position, time rate (0.25× to 16×), altimeter (STD or a set value in hPa or inHg) and the camera (cockpit, outside, drone). They use the simulator's standard controls and every press is checked against what the simulator reports afterwards, so an add-on aircraft that ignores one says "didn't respond". Add-on aircraft that run their own systems may ignore some.

**Pause later** pauses the simulator for you, kept on the PC so it works with the phone away:
- *At a time* (your device's clock).
- *Before the top of descent* (0 to 15 minutes ahead). It only counts once you have been level above 10,000 ft for two minutes, uses the same top-of-descent estimate as the notification (SimBrief plan), and, with no plan, pauses when a steady descent from the cruise begins. It happens once, and never touches a simulator that is already paused.

## Appearance

VBuddy uses a burgundy theme in **light and dark**. The round button at the top right cycles *same as device*, *light* and *dark*; the choice is kept on that device only. The map switches its tiles to match. The VBuddy window on the PC follows the PC's setting.

## Install it as an app (PWA)

VBuddy is an installable web app: a home-screen icon, full-screen with no browser bars, and it opens even when the bridge or your network is off (you see the saved landing log and a "can't reach the bridge" banner).

**The catch: browsers only allow offline mode and one-tap install on `https://` addresses or `localhost`.** Your bridge on the home network is plain `http://192.168.x.x:4789`, so there:

- the app works exactly as before, but the install button and offline mode are off. The Flight tab shows a short note about it that you can hide;
- on Android, Chrome menu > **Add to Home screen** still makes a full-screen shortcut. On iPhone/iPad, Share > **Add to Home Screen**;
- on the sim PC itself, `http://localhost:4789` is allowed, so install and offline work there.

Through the cloud relay (see "Away from home") you get an https address, and the full install and offline experience works on your tablet and phone. For testing before that, in Chrome on Android you can open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://<your-pc-ip>:4789`, enable it and relaunch. That is a developer flag, not something to leave on.

What it does where it is allowed:

- Saves the app (page, scripts, styles, icons) on the device. `/ws` and `/api/*` are never cached, so data is always live.
- **Updates:** after you rebuild, the next time the app opens it downloads the new version in the background and shows "A new version of VBuddy is ready. Reload". It never swaps versions underneath you mid-flight.
- Keeps the landing log (the summaries, not the flare traces) on the device so the Landings tab opens offline. A banner says it is the saved copy.
- Icons: `packages/web/public/icons/` (regular, maskable for Android, and the iOS home-screen icon).

## Away from home: the cloud relay (https, 5G) and notifications

Your home router is never opened. The bridge on your PC dials **out** to a relay on a cloud VM, and your phone opens the relay's https address. The relay only passes bytes through; the bridge still decides who sees what.

```
phone on 5G --https--> relay (cloud VM, Caddy gives the https certificate) <--tunnel, dialled out by-- bridge on your PC
```

### Using it (everyone with the app)

1. Open the **VBuddy window** (double-click the tray icon, or Start menu > VBuddy).
2. Switch on **Away from home (cloud relay)**. When it says *Connected*, the window shows your **phone link**, such as `https://vbuddy.duckdns.org/?r=abcd2345wxyz`, with Copy and a QR code.
3. Open that link on your phone or tablet (any network). It asks for the **pairing code** shown in the window; type it once and the device is paired. After that the link just opens.
4. Install it to the home screen from there (offline mode, notifications).

There is nothing to configure and no secret to copy. The shared relay is built into the app (`wss://vbuddy.duckdns.org`), but the app **makes its own id and key** the first time (kept in `%APPDATA%\VBuddy\relay-identity.json`). The id picks your PC out on the shared relay and is part of your phone link; the key proves the id is yours, is never shown, and the relay stores only a hash of it. Nobody can take over your id, and many people use one relay at the same time. If you reinstall and delete the data folder you get a new id and link.

**What the relay can and can't see.** The https certificate ends at the relay, so whoever runs it can see the traffic (flight data, chat) while the switch is on. That is why it is **off until you switch it on**, and why a device must be paired before it sees anything. Switch it off in the window and the PC stops dialling out. Prefer to keep it private? Host your own (below) and set `VBUDDY_RELAY=wss://your-address` in the settings file.

### Hosting the relay (the person running the VM)

**1. A VM and an address.** An Ubuntu 22.04/24.04 VM (Oracle's Always Free tier works). In its network security list allow ingress TCP **80 and 443**. Point a hostname (e.g. at duckdns.org) at the VM's public IP.

**2. Install or update.** Copy this `webapp` folder to the VM (`scp -r`, or `git clone`), then:

```bash
sudo bash deploy/relay/setup.sh vbuddy.duckdns.org
```

It installs Node, Caddy (automatic https certificate) and the relay as a service, opens ports 80/443 in the VM's own firewall, and keeps the list of registered bridges (`/var/lib/vbuddy-relay/.vbuddy-relay/bridges.json`) when you run it again to update. Check `https://vbuddy.duckdns.org/relay/health`: it shows how many bridges are connected right now.

**Limits built in:** one address may register 10 new bridges an hour, 5000 bridges in total, 64 pages and 16 live connections per bridge, wrong keys lock an address out for a minute after 10 tries, and bridges not seen for 120 days are forgotten. Only GET and WebSocket pass through. Change them with `node packages/relay/dist/index.js --help`.

**Self-hosting for yourself only** works the same way: run the setup script with your own hostname, then on the PC set `VBUDDY_RELAY=wss://your-hostname` (or `--relay`). Run it without the script: `pnpm --filter @vbuddy/relay build`, then `node packages/relay/dist/index.js` (127.0.0.1:8080, behind a TLS proxy; `--no-proxy` if there is none).

**Notifications.** On a paired device, the Flight tab has a **Notifications** card: turn it on, choose ATC changes and/or touchdown result, and press "Send a test". The bridge sends them itself through the browser's push service, so they arrive with VBuddy closed and the screen off. They are skipped when VBuddy is open in front of you (the page already shows the alert). Things to know:

- They need an https address (the relay). On iPhone/iPad, add VBuddy to the Home Screen first and open it from there; iOS only allows notifications for installed apps.
- The push keys and device subscriptions live in your data folder (`push-vapid.json`, `push-subscriptions.json`). Remove a device on the Cockpit tab and its notifications stop.
- The bridge PC needs internet access to reach Google/Apple/Mozilla push servers (it already has it).

## Flight log

The bridge writes everything to one SQLite file, `flights.db` in the data folder (`%APPDATA%\VBuddy` on Windows), whether or not a tablet is connected:

- **Telemetry**, the same numbered stream the tablet gets, in small batches every 2 seconds. At 5 Hz that is roughly 9 MB per hour. Anything older than `--keep-hours` (default 24) is deleted automatically; flights and landings are kept.
- **Flights**: one entry per stretch of continuous flying. A new flight starts when the aircraft changes, when the sim disconnects, or after 10 minutes with no data. Each records start and end time, aircraft, start and end position, highest altitude, top ground speed, and how many landings it had.
- **Landings** with their full flare traces.

**Disconnect resilience.** If your tablet drops off Wi-Fi or cellular, the bridge keeps recording. When the tablet comes back it says "the last frame I saw was N" and the bridge sends everything after that: from memory when the outage was short, and from the flight log when it was longer than the memory buffer. An outage that would need more than 4,000 frames (about 13 minutes at 5 Hz) is thinned to every Nth frame so a phone on mobile data isn't flooded; the newest frame is always included, and the footer shows "every 3rd" so nothing is silently missing. The footer also shows how many frames came back from disk.

A restart of the bridge starts a new numbered stream, so a tablet that was disconnected across a restart picks up live data from the new run; it can't ask for frames the bridge never saw.

**If the flight log can't be used** (the file is damaged, the disk is full, the Node.js version is too old), the bridge keeps running and streaming. A damaged file is moved aside as `flights.db.damaged-<time>` and a new one starts. A disk that fills up is retried until it works again.

**Reading it from other tools:**

- `/api/flights` lists recent flights, newest first.
- `/api/flights/<id>/track?max=2000` returns that flight's path as `[ts, lat, lon, altMsl, gs, hdgTrue]` points. The live map (Part 5) uses this.

The file is plain SQLite, so you can also open it in any SQLite viewer.

## Fenix A320 variable discovery

SimConnect can't list a Fenix's internal variables, and it returns 0 for names that don't exist. So this tool *watches* a list of likely names while you operate the cockpit, and reports which ones are real.

1. Start MSFS 2024 and load the **Fenix A320** with the aircraft powered (FCU lit).
2. Run:

   ```powershell
   pnpm fenix:discover
   ```

3. In the cockpit: turn each FCU knob (SPD, HDG, ALT, V/S) a few clicks both ways, push and pull each one, press AP1, AP2, A/THR, LOC, APPR and EXPED, and turn the EFIS baro knob and ND mode/range.
4. Press **Ctrl+C**. It prints what it confirmed and saves `fenix-report-<time>.json` in this folder.

**Write test.** This checks whether VBuddy can turn a Fenix knob directly through SimConnect, with no MobiFlight module. It turns the HDG knob one click and then back:

```powershell
pnpm fenix:discover -- --test-write E_FCU_HEADING
```

Watch the FCU heading window: it should go up by one and come back. Run this test only on the ground or with the autopilot off.

Extra names: `--var SOME_LVAR` (repeatable) or `--vars-file names.txt`.

**Share the report file with the next build step.** The Fenix cockpit (Part 6) is built from it.

## Cockpit tab by aircraft (Part 7c)

The Cockpit tab follows the loaded aircraft:

- **Fenix A320:** the Airbus FCU and EFIS (Part 6).
- **Boeing (PMDG, iFly, default Boeings) and other non-Fenix aircraft:** a Boeing-style mode control panel: COURSE, IAS/MACH, HEADING, ALTITUDE and VERT SPEED windows with knobs (tap a window to type a value), and A/T ARM, F/D, SPEED, LVL CHG, HDG SEL, LNAV/VOR LOC, APP, ALT HLD, V/S and CMD. Other aircraft get the same panel labelled "Autopilot".
- **Other Airbus (FlyByWire, iniBuilds, FSLabs):** the same autopilot panel (no Airbus FCU look yet), plus lights.
- **Every aircraft:** a **Lights** card (landing, taxi, nav, beacon, strobe, wing, logo, recognition, cabin, panel).

**What these controls use.** The Boeing panel and the lights use the simulator's *standard* commands and variables, and every press is checked by watching the matching variable change. They work on aircraft that follow the simulator's own autopilot and light systems (the default Boeings, and many add-ons for lights). **PMDG and iFly keep their own autopilot and mostly ignore the standard commands**: pressing a button then shows "didn't respond" instead of pretending. The PMDG controls need PMDG's own SDK events; for that, copy `PMDG_NG3_SDK.h` (737) and `PMDG_777X_SDK.h` (777) from the aircraft's documentation folder into the `webapp` folder. For iniBuilds lights, if the standard toggle is ignored the bridge also tries the aircraft's own light switches (from your reports; unconfirmed).

To see the Boeing layout without MSFS: `pnpm start -- --mock --mock-aircraft boeing`.

### How add-on aircraft are controlled

Add-on aircraft ignore the simulator's standard autopilot commands, so the autopilot panel uses each one's own way in. Every change is checked against the value the simulator reports afterwards, and the app says "didn't respond" if nothing moved.

| Aircraft | Knobs (speed, heading, altitude, V/S) | Buttons |
|---|---|---|
| PMDG 737 / 777 | With the aircraft's SDK header found (see below): PMDG's own data and events for everything. Without it, the knobs use the SDK event numbers (`#70016`, `#70022`, `#70032`, `#70033`) | Only with the SDK header |
| FlyByWire A32NX / A380X | `A32NX.FCU_*_SET` events | `A32NX.FCU_*` push and pull events |
| iFly 737 MAX | The aircraft's own input events, found by name | Same |
| Everything else | Standard simulator events | Standard events |

Not yet confirmed on real aircraft: the FlyByWire Mach entry, the iFly names, and whether PMDG's autopilot values appear in the standard variables (the panel needs them to show the current value). If a knob reports "didn't respond", run `pnpm aircraft:discover` on that aircraft and share the report.

## PMDG 737 and 777 (Part 7c) — parked

**Status: switched on.** The bridge looks for the SDK header in the PMDG package folders; if it can't find it, the Cockpit tab says so and the knobs fall back to the SDK event numbers. Not yet checked against a real PMDG.

The PMDG aircraft ignore the simulator's standard autopilot and light commands, so VBuddy talks to them the way PMDG
documents: the cockpit is read from the aircraft's `PMDG_NG3_Data` / `PMDG_777X_Data` client data, and buttons, knobs
and switches are sent as PMDG events through its control area. The event numbers and the data layout are read at startup
from the SDK header PMDG ships with the aircraft (`PMDG_NG3_SDK.h`, `PMDG_777X_SDK.h`), so they always match the
installed version.

- The bridge finds the headers in your Community and Official folders. If it can't, copy them into the `sdk` folder
  (see `sdk/README.md`) or set `PMDG_SDK_DIR`.
- In the aircraft's work folder the options `.ini` needs `EnableDataBroadcast=1`; reload the aircraft after changing it.
- At startup the bridge log lists which controls it matched and which it couldn't. `pnpm pmdg:dump` writes
  `pmdg-sdk-report-*.json` (event and field names only) for fixing the ones it missed.
- Knobs: one click each way works out the direction and step, then the window is dialled to the value. Every
  command is checked against the aircraft's own light or window, and the app says when nothing changed.

## Other aircraft: control discovery (Part 7c)

One tool for PMDG 737 / 777, iniBuilds A350 / A340 / A380, iFly 737 MAX and FSLabs A321 neo. It uses three independent methods and reports which ones this aircraft supports:

1. **Input events** (the simulator's own list of cockpit controls, names and values).
2. **Client data areas** (PMDG publishes its cockpit as a block of bytes; the tool shows which bytes change as you operate controls).
3. **L:vars** (asks the MobiFlight WASM module for the list, which needs it installed in the Community folder, plus any names you give it with `--vars-file`).

For each aircraft:

1. Load it in MSFS 2024, powered up on the ground (for PMDG, data broadcast must be on, see below).
2. Run, with a label so the report is named after the aircraft:

   ```powershell
   pnpm aircraft:discover -- --label pmdg737
   ```

   The L:var list is long and mostly other add-ons' helpers (GSX, camera tools), which are skipped. To watch only certain names, add a filter, for example `--lvar-filter "ifly|mcp|fcu"`. The report's `lvars.listed` holds every name found.

3. Operate everything you want in the app: MCP/FCU knobs and buttons, AP/A-THR/FD, gear, flaps, lights, anything. Changes print as you go.
4. Press **Ctrl+C**. It saves `aircraft-report-<label>-<time>.json` in this folder. Share the file.

Tests (ground, autopilot off; each puts the old value back):

```powershell
pnpm aircraft:discover -- --test-input SOME_INPUT_EVENT --value 1
pnpm aircraft:discover -- --test-lvar SOME_LVAR --delta 1
pnpm aircraft:discover -- --test-event 69700 --param 1     # PMDG third-party event number
```

**PMDG:** data broadcast must be switched on in the aircraft's options `.ini` (the `[SDK]` section, `EnableDataBroadcast=1`; the exact file name and location are in PMDG's SDK documentation for your aircraft). Restart the aircraft afterwards. The SDK header (`PMDG_NG3_SDK.h` / `PMDG_777X_SDK.h`) lists the data layout and event numbers; share that file too.

## Protocol in brief

- Single port: HTTP serves the web client, `/ws` is the WebSocket, `/api/health` is a JSON status check.
- The client sends `hello` first. On reconnect it includes `{ sessionId, lastSeq }`, and the bridge replays the frames it missed, from memory or from the flight log (thinned if the outage was very long; `welcome.resume` says how many, whether any came from disk, and the stride).
- After `hello` the bridge sends the landing list (without traces). New landings are pushed with their trace. A client can ask for any landing's trace with `getLanding`.
- Every telemetry frame has a `seq` number. A gap means frames were lost, and the client counts it.
- Network data: `atcList` (all online stations + feed status) after hello and when it changes, `traffic` for the client's area (it sets the area with `trafficArea`), `atcPosition` (who covers you, what's next) and `atcAlert`. Sector shapes: `/api/network/boundaries?ids=...`.
- Cockpit: `cockpit` (FCU state + this device's control rights) after hello and on change; the client sends `cmd` and gets `cmdResult` once the bridge has seen the aircraft react. Pairing: `pair` -> `pairResult` (token), `hello.token` afterwards; `pairingInfo`, `revokeDevice`, `newPairingCode` only for the bridge PC.
- Comms: `commsState` (radios, transponder, VATSIM connection; to everyone), `chatHistory` / `chat` (only to the PC and paired devices), `commsCmd` -> `commsResult`. Frequencies are Hz. The plugin talks to the bridge on `ws://127.0.0.1:<port>/plugin` (loopback only, never via the relay; see `packages/protocol/src/plugin.ts`).
- Relay: the bridge's tunnel is a WebSocket at `/relay/tunnel`, authenticated with its own id (`x-vbuddy-id`) and key (`Authorization: Bearer`); a phone is routed by the `vb` cookie that the phone link `/?r=<id>` sets (see `packages/protocol/src/tunnel.ts`). Through it a client that hasn't paired gets only `cockpit` with `control.locked`, until `pair` succeeds; then the usual `welcome` follows. Notifications: `pushInfo` (key + this device's choices), `pushSubscribe` / `pushUnsubscribe` / `pushTest` from paired devices.
- Every message carries a protocol version `v` and is validated on both ends (see `packages/protocol/src`).

## Security note

Watching (telemetry, map, landings) is open to anyone on your network who knows the address; use `--host 127.0.0.1` on a network you don't trust. Controlling the aircraft needs pairing (see Cockpit). Over plain `http` on your home network the traffic isn't encrypted, so pair on a network you trust. Through the relay (https) everything is encrypted to the relay (whoever runs it can see it), and devices must pair before they see your flight (`--relay-access paired`). The VBuddy window's API (`/api/console`) only answers a browser on the bridge PC itself, opened as `localhost`.

## Checks

```powershell
pnpm typecheck
pnpm build
pnpm test
```

## Fenix EFB
Turn on the Fenix external EFB (default port 8083). VBuddy shows it under Systems → EFB, on the PC and over the cloud relay. After updating, redeploy the relay on the VM (`deploy/relay/setup.sh`): the EFB needs the relay's extended tunnel.

## Two installers: with the relay, and home network only
`pnpm package:both` (needs Windows with Inno Setup) writes both to `release/`:
- `VBuddy-Setup-<version>.exe`: the full edition, with the *Away from home (cloud relay)* switch in the VBuddy window.
- `VBuddy-Local-Setup-<version>.exe`: the home network edition. There is no relay: the switch and its text are gone, the bridge never dials out to a relay, and the console refuses to turn one on. A phone or tablet on the same Wi-Fi opens the address shown in the window (the installer opens the port for you). The portable zips are `VBuddy-Local-<version>-win-x64.zip` and `VBuddy-<version>-win-x64.zip`.

The only difference is an `edition.txt` file next to the app folder (`local` or `cloud`); `VBUDDY_EDITION=local` does the same for a development run. Both use the same install folder and app id, so installing one over the other switches editions and keeps your data. Without the relay there is no https address, so installing the app to the home screen, offline mode and notifications need the https relay; the Fenix EFB, map, landings and cockpit all work over plain Wi-Fi.
