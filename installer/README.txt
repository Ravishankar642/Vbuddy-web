VBuddy 1.1
==========

1. Start VBuddy from the Start menu. The VBuddy window opens and VBuddy keeps running as an
   icon in the notification area (under the ^ arrow; drag it to the taskbar if you like).
   Double-click the icon to open the window again. Right-click it for the log, settings,
   Restart and Exit.

2. On your phone or tablet (same Wi-Fi as this PC), scan the QR code in the VBuddy window or
   type the address it shows. Add it to your home screen for a full-screen app.

3. To control the aircraft, pair the device once: in the app go to Systems > Controls and type
   the 6-digit pairing code shown in the VBuddy window.

4. Away from home: switch on "Away from home (cloud relay)" in the VBuddy window and open the
   phone link it shows, on any network. It is off until you switch it on.

5. Chat and VATSIM connect/disconnect from the app need the "VBuddy Link" plugin in vPilot
   (the installer offers it). Restart vPilot after installing it.

PMDG 737 / 777: nothing to do. VBuddy copies the aircraft's SDK file into %APPDATA%\VBuddy\sdk
and turns on PMDG's data in 737_Options.ini / 777_Options.ini by itself (with a backup). Fly the
aircraft once, start VBuddy, then reload the aircraft if the app asks you to.

Updates: VBuddy checks for new versions itself; install them from Settings > Updates in the
VBuddy window. Your flights, landings, pairings and settings (%APPDATA%\VBuddy) are kept.

Phone can't connect? Same Wi-Fi as the PC, and the Windows network set to "Private". The
installer opens TCP port 4789 in Windows Firewall for you. "VBuddy with a window" in the Start
menu shows the log, for troubleshooting.

Settings: Start menu > "VBuddy settings". Files and licenses: LICENSE.txt,
THIRD_PARTY_NOTICES.md. What's new: CHANGELOG.md.
