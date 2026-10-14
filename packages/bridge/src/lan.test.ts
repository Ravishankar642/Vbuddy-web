import { test } from "node:test";
import assert from "node:assert/strict";
import { rankLanAddresses } from "./lan.js";

const nic = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "255.255.255.0", mac: "", cidr: null });

test("the home Wi-Fi address comes before virtual adapters and VPNs", () => {
  const ranked = rankLanAddresses({
    "vEthernet (WSL)": [nic("172.22.48.1")],
    "VirtualBox Host-Only Network": [nic("192.168.56.1")],
    "Tailscale": [nic("100.101.5.5")],
    Loopback: [nic("127.0.0.1", true)],
    "Wi-Fi": [nic("192.168.1.23")],
    Local: [nic("169.254.3.4")],
  });
  assert.equal(ranked[0], "192.168.1.23");
  assert.ok(!ranked.includes("127.0.0.1") && !ranked.includes("169.254.3.4"));
  assert.deepEqual(ranked.slice(-1), ["100.101.5.5"]);
});

test("a 10.x Ethernet beats an unnamed 192.168 adapter", () => {
  assert.equal(rankLanAddresses({ Ethernet: [nic("10.0.0.5")], "Some Adapter": [nic("192.168.9.9")] })[0], "10.0.0.5");
});
