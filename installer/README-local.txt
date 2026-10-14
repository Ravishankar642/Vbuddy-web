VBuddy 1.1 (home network edition)
=================================

This edition works while your phone or tablet is on the same Wi-Fi as this PC. It never
connects to any VBuddy server.

1. Start VBuddy from the Start menu. The VBuddy window opens and VBuddy keeps running as an
   icon in the notification area (under the ^ arrow; drag it to the taskbar if you like).
   Double-click the icon to open the window again. Right-click it for the log, settings,
   Restart and Exit.

2. On your phone or tablet, open  http://<your PC's IPv4 address>:4789
   To find the address: open Command Prompt on this PC, type  ipconfig  and use the
   "IPv4 Address" line, for example  http://192.168.0.108:4789
   Add it to your home screen for a full-screen app.

3. To control the aircraft, pair the device once: in the app go to Systems > Controls and type
   the 6-digit pairing code shown in the VBuddy window.

4. Chat and VATSIM connect/disconnect from the app need the "VBuddy Link" plugin in vPilot
   (the installer offers it). Restart vPilot after installing it.

PMDG 737 / 777: copy PMDG_NG3_SDK.h and/or PMDG_777X_SDK.h from the aircraft's
Documentation\SDK folder into %APPDATA%\VBuddy\sdk, and in the aircraft's work folder add these
under [SDK] in 737_Options.ini / 777_Options.ini, then reload the aircraft:
    EnableDataBroadcast=1
    EnableCDUBroadcast.0=1
    EnableCDUBroadcast.1=1        (777: also EnableCDUBroadcast.2=1)

Updates: VBuddy checks for new versions itself; install them from Settings > Updates in the
VBuddy window. Your flights, landings, pairings and settings (%APPDATA%\VBuddy) are kept.

Phone can't connect? Same Wi-Fi as the PC (not a guest network), and the Windows network set
to "Private". The installer opens TCP port 4789 in Windows Firewall for you. "VBuddy with a
window" in the Start menu shows the log, for troubleshooting.

Settings: Start menu > "VBuddy settings". Files and licenses: LICENSE.txt,
THIRD_PARTY_NOTICES.md. What's new: CHANGELOG.md.
