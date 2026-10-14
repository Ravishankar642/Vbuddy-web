# VBuddy Link (vPilot plugin)

A small, new vPilot plugin (it does not replace or touch the old VBuddy notification plugin; you can run both).
It does two things:

- tells the VBuddy bridge on this PC when you connect to or leave VATSIM, and passes on **radio messages, private messages, broadcasts and SELCAL**;
- carries out what you do in the web app's **Comms** tab: connect, disconnect, send a radio message or DM, squawk ident, altitude reporting on/off.

COM1/COM2 tuning and the squawk code don't go through vPilot at all: the bridge sets them in the simulator, and vPilot follows the sim's radios.

## Build and install

1. Close vPilot.
2. In this folder: `dotnet build VBuddyLink.csproj -c Release` (needs the .NET SDK; the project targets .NET Framework 4.8 like vPilot). If vPilot isn't in `%LOCALAPPDATA%\vPilot`, add `-p:VpilotSdk="C:\path\to\RossCarlson.Vatsim.Vpilot.Plugins.dll"`.
3. Copy `bin\Release\VBuddyLink.dll` into `%LOCALAPPDATA%\vPilot\Plugins`. (`VBuddyLink.ini` is optional.)
4. Start the VBuddy bridge, then vPilot. The bridge window says `vPilot plugin connected`, and the web app's header shows the VATSIM status.

The plugin connects out to `ws://127.0.0.1:4789/plugin`. The bridge only accepts that from this PC, never through the relay.

## Notes

- Sending a radio message uses whichever radio vPilot is set to transmit on. If it isn't set to transmit you get an error in the app.
- The vPilot plugin SDK has no call for tuning radios or reading the squawk, which is why those come from the simulator.
- Built here against a stand-in for the SDK made from its documentation, not the real DLL, so the first build on your PC is the real test.
