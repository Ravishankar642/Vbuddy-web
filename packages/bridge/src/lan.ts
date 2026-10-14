import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** Adapters that exist on a PC but are not the home network: virtual machines, WSL, VPNs, containers. */
const VIRTUAL = /vethernet|wsl|hyper-?v|virtualbox|vbox|vmware|vmnet|docker|podman|loopback|bluetooth|tailscale|zerotier|hamachi|vpn|\btap\b|\btun\b|npcap|host-only|pseudo|teredo|isatap|veth|br-|virbr/i;
const REAL = /wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl/i;

function rank(name: string, ip: string): number {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  let r = 0;
  if (VIRTUAL.test(name)) r += 100;
  if (!REAL.test(name)) r += 10;
  if (a === 192 && b === 168) r += 0;
  else if (a === 10) r += 1;
  else if (a === 172 && b >= 16 && b <= 31) r += 2;
  else if (a === 100 && b >= 64 && b <= 127) r += 60; // carrier-grade NAT / Tailscale range
  else r += 40;
  return r;
}

/** This PC's addresses on the home network, most likely first: Wi-Fi/Ethernet with a 192.168/10.x address before virtual adapters, VPNs and the like. */
export function rankLanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const found: Array<{ ip: string; r: number }> = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      found.push({ ip: a.address, r: rank(name, a.address) });
    }
  }
  return found.sort((x, y) => x.r - y.r).map((x) => x.ip).filter((ip, i, all) => all.indexOf(ip) === i);
}
