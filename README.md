# VBuddy

A free companion for Microsoft Flight Simulator. VBuddy runs on your sim PC and puts your flight on your phone, tablet or any browser: a live map with VATSIM traffic, your aircraft's systems, cockpit controls, a landing analyzer, radios and chat, and a remote view of the sim. Nothing to install on the phone.

Version 1.2.0 · Windows · MSFS 2024 (and 2020) · [What's new](CHANGELOG.md)

---

## Get started

1. **Download** the installer from the [Releases page](https://github.com/Ravishankar642/Vbuddy-web/releases):
   - `VBuddy-Setup-1.2.0.exe`: works at home **and** away from home (optional cloud relay).
   - `VBuddy-Local-Setup-1.2.0.exe`: home network only. It never connects to any VBuddy server.

   Both include everything they need; you don't need Node.js or anything else. To share VBuddy with a friend, just send them the installer.
2. **Run the installer.** It opens VBuddy's port (TCP 4789) in Windows Firewall for you. Leave these ticked if you want them:
   - *Install the VBuddy Link plugin into vPilot*: needed for chat and VATSIM connect/disconnect from the app. Restart vPilot afterwards.
   - *Start VBuddy when I sign in.*
3. **Start VBuddy** from the Start menu. The **VBuddy window** opens and VBuddy keeps running as an icon in the notification area (under the **^** arrow). Close the window whenever you like; double-click the icon to bring it back.
4. **Open it on your phone.** Phone and PC on the same Wi-Fi:
   - Setup edition: scan the QR code in the VBuddy window, or type the address it shows.
   - Local edition: open `http://<your PC's IPv4 address>:4789`. To find the address, open Command Prompt on the PC, type `ipconfig` and use the **IPv4 Address** line (for example `http://192.168.0.108:4789`).
5. **Pair to control the aircraft.** Anyone on your network can watch, but only paired devices can press buttons. On the phone go to **Systems → Controls** and type the 6-digit pairing code from the VBuddy window. You only do this once per device.

**Add it to your home screen** (Android: Chrome menu → *Add to Home screen*; iPhone/iPad: Share → *Add to Home Screen*) for a full-screen app.

---

## Away from home (Setup edition)

Watch a long-haul flight from anywhere, on 5G, without touching your router:

1. In the VBuddy window, switch on **Away from home (cloud relay)**.
2. When it says *Connected*, open the **phone link** it shows (or scan its QR code) on your phone.
3. Type the pairing code once. Install it to your home screen from there to get notifications.

The relay is off until you switch it on. While it's on, your flight data passes through the relay server; switch it off and the PC stops connecting to it. If your connection drops, VBuddy keeps recording on the PC and fills in the gap when you're back.

Prefer to stay on your own network? Use the Local edition, or a private VPN such as Tailscale with the Local edition's address.

---

## What's in the app

| Tab | What you get |
|---|---|
| **Flights** | Live instruments with your airline and SimBrief plan, your saved flights, and nearby VATSIM traffic and ATC |
| **Systems** | Engines, autopilot, fuel, electrical, cabin and weather; **Controls** (FCU/MCP, lights, simulator buttons); **Sim view**; **CDU** (PMDG); **Fenix EFB** (Fenix) |
| **Comms** | COM radios, transponder, VATSIM chat and ACARS (Hoppie telex and CPDLC) |
| **Atlas** | Your flight record and every landing |
| Search | Airport weather and your SimBrief flight plan |

The map shows your aircraft with VATSIM traffic, ATC sectors and airports, and warns you before you cross into a new controller's airspace. Your SimBrief route is drawn as a dashed line, and your own trail starts once you've spawned at the airport and connected to VATSIM. The **rain** button adds a weather radar (RainViewer); tap it again for **clouds** too, which needs a free [OpenWeatherMap](https://openweathermap.org/api) key pasted into the VBuddy window under *Your accounts*.

### Your flight and SimBrief
When you connect to VATSIM, VBuddy loads your latest SimBrief plan by itself (your SimBrief name goes in the VBuddy window). If the plan starts at the airport where you spawned, it's tied to the flight: the route goes on the map, the Live page shows the flight number and distance to go, and the flight record keeps the plan, planned against flown. A flight only starts once the aircraft has settled at its spawn point, so time in the menu, the hangar, loading or watching a replay isn't recorded and replays don't count as landings.

### Airline colours
Connect to VATSIM with an airline callsign (QTR123, IGO6E45, UAE202…) and the app takes on that airline's colours, in light and dark mode, with a nameplate on the Live page. About 260 airlines are known, with their logos (loaded from a public airline-logo service); switch the colours off under Settings → Appearance. To use your own logo instead, put an image named after the airline's ICAO code (`QTR.png`, `IGO.svg`…) in `%APPDATA%\VBuddy\logos`. If no logo loads, the nameplate shows the airline's code in its colour.

### Landing analyzer
Every touchdown is recorded from the sim's own data: rate (fpm), G, pitch, bank, wind, bounces and your flare (sink rate at 50, 30 and 10 ft), with a chart and a rating. Landings are kept on the PC, so you never miss one.

### Controls
Under **Systems → Controls**, for every aircraft: lights, and a **Simulator and systems** card (pause, gear, spoilers, parking brake, engines, APU, flaps, altimeter, time rate, camera, and *Pause later* before the top of descent). The autopilot panel depends on the aircraft (below). Every command is checked against what the sim reports, so if an aircraft ignores something, the app tells you.

### Sim view
**Systems → Sim view** shows the simulator window on your phone, about three pictures a second. If you use **ChasePlane**, your saved camera views are listed there and switch with one tap; without it, there are Cockpit and Outside buttons. **Take screenshot** grabs the sim window at full size; it's kept on the PC (`%APPDATA%\VBuddy\screenshots`) and *Save to phone* puts it in your photos.

### Notifications
The **bell** at the top of the sheet opens Notifications: one switch for the device, then what to be told about: takeoff, top of climb, passing 10,000 ft, top of descent, approaching the destination, touchdown, at the gate; ATC changes and boundaries, messages, VATSIM connect, flight plan loaded; aircraft alerts, low fuel, autopilot off, the simulator stopping or pausing. They need a paired device on the relay's https address; on iPhone, add VBuddy to the Home Screen and open it from there. While VBuddy is on screen you see them in the app instead.

---

## Aircraft

| Aircraft | What works |
|---|---|
| **Fenix A320** | Full FCU and captain's EFIS with real knobs, lights, radios, and the **Fenix EFB** inside VBuddy. Needs the free MobiFlight WASM module in your Community folder if the FCU says it isn't reaching the aircraft. |
| **PMDG 737 and 777** | MCP (speed, heading, altitude, V/S, course on the 737) with its lights, and the **CDU** (Systems → CDU). Sets itself up (below). |
| **iniBuilds A340, A350, A380** | The same FCU screen as the Fenix: knobs, push/pull, AP, A/THR, LOC, APPR, FD and more, plus lights. Some FCU lights in the app may stay dark if the aircraft doesn't report them. |
| **FlyByWire A32NX / A380X** | Airbus FCU and lights. |
| **iFly 737 MAX** | MCP buttons and knobs. |
| **Default and most other aircraft** | Autopilot panel and lights through the simulator's standard controls. |
| **FSLabs, ToLiss, iniBuilds A300/A310** | These aircraft keep their cockpit private, so the autopilot and lights can't be operated from outside. Everything else (map, systems, landings, simulator controls) works. |

### PMDG setup
There's nothing to do by hand. When VBuddy starts, and every time you change aircraft, it:
- copies the aircraft's SDK file (`PMDG_NG3_SDK.h` for the 737, `PMDG_777X_SDK.h` for the 777) from its package into `%APPDATA%\VBuddy\sdk`, and copies it again after an aircraft update;
- turns on PMDG's data and CDU screens in the aircraft's `737_Options.ini` / `777_Options.ini`. It keeps a backup of the original as `.vbuddy-backup` the first time.

PMDG creates its options file the first time you load the aircraft. So on a new install, fly it once with VBuddy running. When the app says VBuddy has just turned the data on, reload the aircraft.

If the app still says it can't find the SDK file, copy it yourself from the aircraft's `Documentation\SDK` folder into `%APPDATA%\VBuddy\sdk`. To turn the data on by hand, add these lines to the options file in the aircraft's `work` folder:
```
[SDK]
EnableDataBroadcast=1
EnableCDUBroadcast.0=1
EnableCDUBroadcast.1=1
```
On the 777, also add `EnableCDUBroadcast.2=1`.

---

## Updates

VBuddy checks for a new version when it starts and every 6 hours and downloads it in the background (it waits while the simulator is running). It then appears under **Settings → Updates** in the VBuddy window with what's new; press *Install update*, allow Windows to make changes, and VBuddy restarts on the new version. You can also just run a newer installer over the old one.

Your flights, landings, paired devices and settings live in `%APPDATA%\VBuddy` and are kept when you update. Uninstalling (Windows Settings → Apps) asks whether to delete them.

**Settings** (port, notifications, relay): Start menu → *VBuddy settings*. Remove the `#` in front of a line to use it, save, then restart VBuddy from the tray icon.

---

## Troubleshooting

| Problem | Try this |
|---|---|
| The phone can't open the address | Same Wi-Fi as the PC (not a guest network). In Windows Settings → Network, set the network to **Private**. Check the address with `ipconfig` → IPv4 Address. |
| "Bridge not reachable" | VBuddy must be running: look for its icon under the **^** arrow. If it's missing, start VBuddy again. |
| No tray icon | Some antivirus tools block it. Start *VBuddy with a window (for troubleshooting)* from the Start menu instead. |
| Buttons are greyed out / view-only | Pair the device: Systems → Controls, then the code from the VBuddy window. |
| Chat or VATSIM connect doesn't work | Install the VBuddy Link plugin for vPilot (re-run the installer), restart vPilot, then VBuddy. |
| PMDG values don't move, or no CDU | Reload the aircraft (VBuddy turns PMDG's data on, but the aircraft only reads it when it loads). If it still doesn't work, see PMDG setup above. |
| An aircraft ignores a control | Start menu → *VBuddy find aircraft controls* makes a report of what the aircraft offers. Send it along with the log (tray icon → *View log*). |

---

## Good to know
- Talking on frequency from the phone isn't available; Comms can open VATSIM Listen (receive only).
- IVAO traffic isn't included yet.
- VBuddy is free and has no accounts. Whoever runs the cloud relay can see the flight data that passes through it while you have it switched on.

Building VBuddy yourself, hosting your own relay, and how each part works: [docs/DEVELOPERS.md](docs/DEVELOPERS.md). Licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
