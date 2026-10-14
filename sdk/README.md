# PMDG SDK headers

VBuddy drives the PMDG 737 and 777 through the SDK files PMDG ships with the aircraft. It looks for them in
your MSFS Community and Official folders by itself. If it can't find them (the bridge log says so), copy these
files here:

- `PMDG_NG3_SDK.h` (737) and/or `PMDG_777X_SDK.h` (777)

They are in the aircraft package, in its `Documentation\SDK` folder. VBuddy only reads them; they are PMDG's
files and are not part of VBuddy (this folder's `.gitignore` keeps them out of git).

Also needed, once per aircraft: in the aircraft's `work` folder, the options `.ini` file must contain
`EnableDataBroadcast=1` (the 737 file is `737_Options.ini`), then reload the aircraft.

`pnpm pmdg:dump` shows what was found and writes a small report of event and field names.
