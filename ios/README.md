# VBuddy for iPhone and iPad

A small iPhone/iPad app that opens VBuddy full screen through the **VBuddy cloud relay**, so it works at home on Wi-Fi and away on mobile data. On first launch you scan the phone link QR code in the VBuddy window on your PC (or type its 12-character ID); the app remembers it.

You need the VBuddy edition with the cloud relay on the PC (VBuddy-Setup-x.y.z.exe, not the Local one), with **Away from home (cloud relay)** switched on in its window.

The app is a shell around the VBuddy web app that your PC serves through the relay, so updating VBuddy on the PC updates what you see in the app too. On top of the web app it adds:

- **Full screen**, with no Safari bars, and the screen stays on while VBuddy is open (iOS Settings → VBuddy → Keep screen on).
- **QR code scanning** for the phone link.
- **Screenshots to Photos.** The sim view's "Save to phone" opens the iOS share sheet; choose **Save Image**.
- **Changing the phone link**: shake the phone, use **Settings → VBuddy app → Change phone link** inside VBuddy, or switch on **Change phone link** in iOS Settings → VBuddy.
- **Links** to other sites (aircraft photos, GitHub, SimBrief) open in Safari.

**Notifications:** iPhone doesn't give push notifications to an app like this one (only App Store apps and Home Screen web apps get them). If you want them, also open your phone link in Safari, add it to the Home Screen (Share → Add to Home Screen) and turn notifications on there. Both can be paired at the same time.

Typing a home Wi-Fi address (`192.168.1.23`) instead of a phone link still works, for a PC running the Local edition.

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

The phone needs an internet connection when the automation runs (Wi-Fi is the most reliable). A daily refresh keeps every app far from its 7-day limit.

### Good to know

- A free Apple ID can have **3 sideloaded apps** active at once (SideStore is one of them) and create **10 app IDs every 7 days**.
- If you update or reset iOS, the pairing file can stop working: run iloader once more with the cable.
- Open SideStore now and then: if it says a refresh failed, connect LocalDevVPN and tap **Refresh All**.

## First launch

1. On your PC, open the VBuddy window → **Connect** and switch on **Away from home (cloud relay)**. The phone link and its QR code appear there.
2. Open VBuddy on the iPhone and tap **Scan QR code** (allow the camera), or type the 12 letters and numbers at the end of the phone link (`…/?r=abcd2345wxyz`). You can paste the whole link too.
3. To press buttons in the cockpit, pair the phone: in VBuddy go to **Systems → Controls** and type the 6-digit pairing code from the VBuddy window. You only do this once.

## Building it yourself on a Mac

```sh
brew install xcodegen
cd ios
xcodegen generate
open VBuddy.xcodeproj
```

Pick your team under Signing & Capabilities to run it on your own phone from Xcode.
