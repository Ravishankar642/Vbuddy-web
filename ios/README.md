# VBuddy for iPhone and iPad

A small iPhone/iPad app that opens VBuddy full screen. On first launch it asks for the address shown in the VBuddy window on your PC (for example `192.168.1.23`), remembers it, and connects over your Wi-Fi.

The app is a shell around the VBuddy web app served by the bridge on your PC, so updating VBuddy on the PC updates what you see in the app too. On top of the web app it adds:

- **Full screen**, with no Safari bars, and the screen stays on while VBuddy is open (iOS Settings → VBuddy → Keep screen on).
- **Screenshots to Photos.** The sim view's "Save to phone" opens the iOS share sheet; choose **Save Image**.
- **Changing the address**: shake the phone, use **Settings → VBuddy app → Change address** inside VBuddy, or switch on **Change address** in iOS Settings → VBuddy.
- **Links** to other sites (aircraft photos, GitHub, SimBrief) open in Safari.

Phone notifications (push) are not available in the app, the same as in Safari on a `http://` Wi-Fi address.

## Getting the app (.ipa)

The `.ipa` is built by GitHub (the **iPhone app** workflow in `.github/workflows/ios.yml`) on a Mac runner, unsigned. SideStore signs it with your own Apple ID when it installs it.

- **For a release:** publishing a release on GitHub runs the workflow by itself, and it attaches `VBuddy-x.y.z.ipa` and `sidestore-source.json` to the release.
- **Any time:** on GitHub open **Actions → iPhone app → Run workflow**. When it finishes, download the **VBuddy-iPhone-x.y.z** artifact (a zip with the `.ipa` inside).

## Installing with SideStore (no PC needed after the first setup)

Apple lets a free Apple ID install apps that expire after 7 days. SideStore re-signs them **on the phone**, so you only need the PC once. It uses a small on-device VPN app (LocalDevVPN) to talk to the phone itself, instead of a cable to a computer.

### One-time setup (with your PC and a cable)

1. On the PC, install **iTunes** (from apple.com, not the Microsoft Store version if you can avoid it) and **iloader** (`https://github.com/nab138/iloader`, the `.msi`).
2. Plug the iPhone in, unlock it and tap **Trust**.
3. Open iloader, sign in with your Apple ID, pick your iPhone and install **SideStore**. iloader also puts the pairing file SideStore needs on the phone.
4. On the iPhone:
   - Settings → General → **VPN & Device Management**: trust your Apple ID's developer app.
   - Settings → Privacy & Security → **Developer Mode**: turn it on (the phone restarts).
5. Install **LocalDevVPN** from the App Store, open it and tap **Connect** (allow the VPN profile).
6. Open SideStore and sign in with the same Apple ID.

You can unplug the phone now.

### Install VBuddy

Either way works:

- **From the VBuddy source (gets updates):** SideStore → **Sources** → **+** → paste
  `https://github.com/Ravishankar642/Vbuddy-web/releases/latest/download/sidestore-source.json`
  then open VBuddy in the source and tap **Get**.
- **From the file:** save `VBuddy-x.y.z.ipa` to Files on the iPhone, then SideStore → **My Apps** → **+** → pick the file.

LocalDevVPN must be connected while SideStore installs or refreshes.

### Refresh every 7 days, without the PC

By hand: connect LocalDevVPN, open SideStore → **My Apps** → **Refresh All**.

Automatically, with the Shortcuts app:

1. Shortcuts → **Shortcuts** tab → **+**. If LocalDevVPN offers a **Connect** action, add it first. Then add SideStore's **Refresh All Apps** action, and turn off **Show When Run**. Name it "Refresh apps".
2. Run it once by hand and allow anything it asks for.
3. Shortcuts → **Automation** → **+** → **Time of Day**, for example 03:00, **Daily**, **Run Immediately**, notifications off → run the "Refresh apps" shortcut.

The phone needs Wi-Fi when the automation runs. A daily refresh keeps every app far from its 7-day limit.

### Good to know

- A free Apple ID can have **3 sideloaded apps** active at once (SideStore is one of them) and create **10 app IDs every 7 days**.
- If you update or reset iOS, the pairing file can stop working: run iloader once more with the cable.
- Open SideStore now and then: if it says a refresh failed, connect LocalDevVPN and tap **Refresh All**.

## First launch

1. Start VBuddy on your PC. The address is in the VBuddy window under **Connect**.
2. Open VBuddy on the iPhone, type the address (just `192.168.1.23`; the app adds `:4799`) and tap **Connect**.
3. When iPhone asks whether VBuddy may find devices on your local network, tap **Allow**. If you tapped Don't Allow, turn it on in iOS Settings → VBuddy → **Local Network**.

## Building it yourself on a Mac

```sh
brew install xcodegen
cd ios
xcodegen generate
open VBuddy.xcodeproj
```

Pick your team under Signing & Capabilities to run it on your own phone from Xcode.
