import type { LandingSummary } from "@vbuddy/protocol";

const LABEL: Record<LandingSummary["rating"], string> = { butter: "Butter", smooth: "Smooth", normal: "Normal", firm: "Firm", hard: "Hard", severe: "Severe" };
const TONE: Record<LandingSummary["rating"], string> = { butter: "#0ca30c", smooth: "#2a9d6a", normal: "#3a7bd5", firm: "#e08a00", hard: "#ec5a3a", severe: "#d03b3b" };

/** A 1080×1080 picture of a landing for Discord and friends, drawn on this device. */
export async function landingCard(l: LandingSummary, opts: { callsign?: string | null; airport?: string | null; brand?: string } = {}): Promise<Blob> {
  const S = 1080;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d")!;
  const brand = opts.brand ?? "#5c0632";
  const grad = g.createLinearGradient(0, 0, S, S);
  grad.addColorStop(0, brand);
  grad.addColorStop(1, "#14050c");
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  try {
    await document.fonts.ready;
  } catch {
    /* system fonts then */
  }
  const ui = '"Manrope Variable", system-ui, sans-serif';
  const num = '"Barlow Condensed", "Arial Narrow", sans-serif';
  g.fillStyle = "rgba(255,255,255,0.75)";
  g.font = `700 34px ${ui}`;
  g.fillText("VBUDDY LANDING", 80, 120);
  g.fillStyle = "#fff";
  g.font = `600 44px ${ui}`;
  const where = [opts.callsign, opts.airport].filter(Boolean).join(" · ");
  if (where) g.fillText(where, 80, 185);

  g.font = `700 300px ${num}`;
  g.fillText(`${Math.abs(l.vsFpm)}`, 70, 520);
  g.font = `600 64px ${num}`;
  g.fillStyle = "rgba(255,255,255,0.8)";
  g.fillText("FPM", 80, 600);

  // Rating pill.
  g.fillStyle = TONE[l.rating];
  const pillW = 320;
  g.beginPath();
  g.roundRect(80, 650, pillW, 96, 48);
  g.fill();
  g.fillStyle = "#fff";
  g.font = `800 52px ${ui}`;
  g.textAlign = "center";
  g.fillText(LABEL[l.rating].toUpperCase(), 80 + pillW / 2, 716);
  g.textAlign = "left";

  const facts: Array<[string, string]> = [
    ["G", l.gPeak.toFixed(2)],
    ["SPEED", `${Math.round(l.iasKt)} kt`],
    ["PITCH", `${l.pitch.toFixed(1)}°`],
    ["WIND", l.wind ? `${String(Math.round(l.wind.fromDeg)).padStart(3, "0")}/${Math.round(l.wind.speedKt)}` : "–"],
  ];
  facts.forEach(([k, v], i) => {
    const x = 80 + i * 240;
    g.fillStyle = "rgba(255,255,255,0.65)";
    g.font = `700 28px ${ui}`;
    g.fillText(k, x, 850);
    g.fillStyle = "#fff";
    g.font = `600 58px ${num}`;
    g.fillText(v, x, 915);
  });
  g.fillStyle = "rgba(255,255,255,0.65)";
  g.font = `600 30px ${ui}`;
  const title = l.aircraftTitle.length > 48 ? l.aircraftTitle.slice(0, 47) + "…" : l.aircraftTitle;
  g.fillText(`${title} · ${new Date(l.ts).toISOString().slice(0, 10)}`, 80, 1000);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("no image"))), "image/png"));
}
