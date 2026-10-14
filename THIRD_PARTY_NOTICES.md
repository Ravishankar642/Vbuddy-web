# Third-party notices

VBuddy is free software under the GNU General Public License v3.0 or later (see `LICENSE`).
It includes or uses the following. Each keeps its own license.

## Software
| Component | License |
|---|---|
| Node.js (bundled in the Windows installer) | MIT (https://github.com/nodejs/node/blob/main/LICENSE) |
| node-simconnect | LGPL-3.0-or-later |
| ws | MIT |
| web-push | MPL-2.0 |
| React, React DOM | MIT |
| Leaflet | BSD-2-Clause |
| esbuild, Vite, TypeScript (build time only) | MIT / MIT / Apache-2.0 |

Microsoft Flight Simulator SimConnect is used through node-simconnect; VBuddy contains no Microsoft code.
vPilot is a separate program by Ross Carlson; the VBuddy Link plugin only uses its public plugin interface and does not include vPilot.
PMDG, Fenix, iniBuilds, iFly, FSLabs and other add-on names are trademarks of their owners and are used only to say which aircraft VBuddy works with.

## Data and map services (fetched while VBuddy runs, not included)
- **VATSIM data feed** (traffic, controllers): subject to the VATSIM data usage policy.
- **VATSpy data project** (FIR/sector boundaries): CC BY-SA 4.0, https://github.com/vatsimnetwork/vatspy-data-project
- **SimAware TRACON boundaries**: https://github.com/vatsimnetwork/simaware-tracon-project
- **Esri World Dark Gray Canvas** map tiles: © Esri and its data providers, used under Esri's terms of use. The map shows the required attribution.

If a service changes its terms, check the current ones.

## ComSpotter (protocol reference only, no code copied)
The ChasePlane connection follows the message format used by ComSpotter, https://github.com/sw-jannik/comspotter, Copyright (c) 2026 Jannik Reichenau, MIT License. ChasePlane is a product of Parallel 42; VBuddy is not affiliated with it.
