import type { Airline } from "./airlines";

/**
 * Turns an airline's colours into the app's whole palette, for light and for dark. Surfaces take a faint tint of
 * the brand's hue (none for a "neutral" airline: plain white, greys and black); the accent is the brand colour,
 * made darker in light mode and lighter in dark mode until text on it, and it on the page, is easy to read.
 */

type Rgb = [number, number, number];

const hexRgb = (h: string): Rgb => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbHex = ([r, g, b]: Rgb) => "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

function rgbHsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl(h: number, s: number, l: number): string {
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

function luminance(hex: string): number {
  const c = hexRgb(hex).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Moves the colour's lightness (keeping hue and saturation) until it reaches `ratio` against `against`. */
function untilContrast(h: number, s: number, l: number, against: string, ratio: number, dir: 1 | -1): string {
  let c = hsl(h, s, l);
  for (let i = 0; i < 40 && contrast(c, against) < ratio; i++) {
    l += dir * 0.02;
    c = hsl(h, s, l);
  }
  return c;
}

const rgba = (hex: string, a: number) => {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

export function airlinePalette(a: Airline, mode: "light" | "dark"): Record<string, string> {
  const [h, s0, l0] = rgbHsl(hexRgb(a.brand));
  const tint = a.neutral ? 0 : Math.min(1, s0);
  // How much of the hue the surfaces get.
  const ts = (x: number) => tint * x;
  const second = a.second ?? hsl((h + 180) % 360, Math.max(0.5, s0), 0.55);
  const [h2, s2] = rgbHsl(hexRgb(second));
  const brand = a.brand;
  const brandHi = hsl(h, Math.min(1, s0 * 1.05), Math.min(0.62, l0 + 0.12));
  const brandDeep = hsl(h, s0, Math.max(0.08, l0 * 0.55));
  if (mode === "light") {
    const bg = hsl(h, ts(0.25), 0.965);
    const accent = untilContrast(h, Math.max(0.35, s0), Math.min(l0, 0.45), "#ffffff", 4.8, -1);
    return {
      "--brand": brand,
      "--brand-hi": brandHi,
      "--brand-deep": brandDeep,
      "--bg": bg,
      "--panel": "#ffffff",
      "--well": hsl(h, ts(0.22), 0.945),
      "--raised": hsl(h, ts(0.2), 0.915),
      "--raised-2": hsl(h, ts(0.18), 0.86),
      "--sel": hsl(h, ts(0.45), 0.94),
      "--input": "#ffffff",
      "--bubble": hsl(h, ts(0.25), 0.92),
      "--edge": hsl(h, ts(0.18), 0.86),
      "--edge-strong": hsl(h, ts(0.15), 0.76),
      "--text": hsl(h, ts(0.4), 0.11),
      "--muted": untilContrast(h, ts(0.14), 0.42, bg, 4.6, -1),
      "--accent": accent,
      "--accent-ink": "#ffffff",
      "--accent-soft": hsl(h, Math.max(0.3, ts(0.5)), 0.92),
      "--link": accent,
      "--overlay": "rgba(255, 255, 255, 0.9)",
      "--own": untilContrast(h, Math.max(0.6, s0), 0.45, "#ffffff", 3.2, -1),
      "--sel-plane": hsl(h, ts(0.4), 0.08),
      "--wash": rgba(brand, 0.04),
      "--grid": hsl(h, ts(0.18), 0.9),
      "--axis": hsl(h, ts(0.15), 0.76),
      "--plan": untilContrast(h2, Math.max(0.5, s2), 0.45, "#ffffff", 3, -1),
      "--shadow": `0 1px 2px ${rgba(brandDeep, 0.06)}, 0 10px 28px -14px ${rgba(brandDeep, 0.22)}`,
    };
  }
  const bg = hsl(h, ts(0.35), 0.055);
  const accent = untilContrast(h, Math.max(0.55, s0), Math.max(0.62, l0), bg, 6, 1);
  return {
    "--brand": brand,
    "--brand-hi": brandHi,
    "--brand-deep": brandDeep,
    "--bg": bg,
    "--panel": hsl(h, ts(0.32), 0.085),
    "--well": hsl(h, ts(0.34), 0.068),
    "--raised": hsl(h, ts(0.3), 0.125),
    "--raised-2": hsl(h, ts(0.26), 0.165),
    "--sel": hsl(h, ts(0.32), 0.135),
    "--input": hsl(h, ts(0.35), 0.045),
    "--bubble": hsl(h, ts(0.28), 0.125),
    "--edge": hsl(h, ts(0.28), 0.175),
    "--edge-strong": hsl(h, ts(0.26), 0.26),
    "--text": hsl(h, ts(0.3), 0.95),
    "--muted": untilContrast(h, ts(0.16), 0.66, bg, 5.5, 1),
    "--accent": accent,
    "--accent-ink": hsl(h, Math.max(0.5, s0), 0.1),
    "--accent-soft": hsl(h, Math.max(0.25, ts(0.4)), 0.19),
    "--link": untilContrast(h, Math.max(0.45, s0 * 0.8), 0.78, bg, 7, 1),
    "--overlay": rgba(bg, 0.86),
    "--own": accent,
    "--sel-plane": "#ffffff",
    "--wash": "rgba(255, 255, 255, 0.04)",
    "--grid": hsl(h, ts(0.28), 0.125),
    "--axis": hsl(h, ts(0.26), 0.21),
    "--plan": untilContrast(h2, Math.max(0.55, s2), 0.62, bg, 4.5, 1),
    "--shadow": "0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 12px 30px -16px rgba(0, 0, 0, 0.7)",
  };
}
