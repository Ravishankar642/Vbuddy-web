// Writes the SideStore / AltStore source (sidestore-source.json) for a release, so SideStore can install VBuddy
// from a link and tell you about updates.
// node ios/make-source.mjs <version> <build> <ipa file> <ipa download URL> <repo, e.g. owner/name> > sidestore-source.json
import { statSync } from "node:fs";

const [version, build, ipa, downloadURL, repo] = process.argv.slice(2);
if (!version || !ipa || !downloadURL || !repo) {
  console.error("usage: make-source.mjs <version> <build> <ipa> <downloadURL> <owner/repo>");
  process.exit(1);
}
const size = statSync(ipa).size;
const date = new Date().toISOString().slice(0, 10);
const raw = `https://raw.githubusercontent.com/${repo}/main`;
const about =
  "Your MSFS flight on your iPhone: live flight data, the FCU and MCP with real knobs, the CDU, a moving map with VATSIM traffic and weather, text ATC, a sim view with full-resolution screenshots, and a landing analyzer. Connects to VBuddy on your PC over your Wi-Fi.";

const source = {
  name: "VBuddy",
  identifier: "app.vbuddy.source",
  subtitle: "The free MSFS companion",
  description: about,
  iconURL: `${raw}/ios/VBuddy/Assets.xcassets/AppIcon.appiconset/icon-1024.png`,
  website: `https://github.com/${repo}`,
  tintColor: "#8e1052",
  apps: [
    {
      name: "VBuddy",
      bundleIdentifier: "app.vbuddy.companion",
      developerName: "VBuddy",
      subtitle: "Your flight deck in your pocket",
      localizedDescription: about,
      iconURL: `${raw}/ios/VBuddy/Assets.xcassets/AppIcon.appiconset/icon-1024.png`,
      tintColor: "#8e1052",
      category: "utilities",
      screenshotURLs: [],
      versions: [
        {
          version,
          buildVersion: String(build || "1"),
          date,
          localizedDescription: `VBuddy ${version}. See https://github.com/${repo}/releases for what's new.`,
          downloadURL,
          size,
          minOSVersion: "15.0",
        },
      ],
      // Older SideStore / AltStore versions read these instead of "versions".
      version,
      versionDate: date,
      versionDescription: `VBuddy ${version}`,
      downloadURL,
      size,
      appPermissions: {
        entitlements: [],
        privacy: {
          NSLocalNetworkUsageDescription: "VBuddy connects to the VBuddy app on your PC over your Wi-Fi.",
          NSPhotoLibraryAddUsageDescription: "VBuddy saves the simulator screenshots you take to your photos.",
        },
      },
    },
  ],
  news: [],
};
process.stdout.write(JSON.stringify(source, null, 2) + "\n");
