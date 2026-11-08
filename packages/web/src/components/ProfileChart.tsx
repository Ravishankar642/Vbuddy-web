import type { ProfilePoint, Progress } from "@vbuddy/protocol";

const W = 400;
const H = 150;
const PAD = { l: 44, r: 8, t: 14, b: 24 };

/**
 * The plan's vertical profile (SimBrief's altitude at each fix along the route), the top of descent, and you on it.
 * Drawn above or below the line by how far you are off the planned altitude.
 */
export function ProfileChart({ profile, progress, altFt }: { profile: ProfilePoint[]; progress: Progress; altFt: number }) {
  const total = Math.max(1, profile[profile.length - 1]!.distNm);
  const top = Math.max(10_000, ...profile.map((p) => p.altFt), altFt) * 1.08;
  const x = (nm: number) => PAD.l + (Math.max(0, Math.min(total, nm)) / total) * (W - PAD.l - PAD.r);
  const y = (ft: number) => H - PAD.b - (Math.max(0, ft) / top) * (H - PAD.t - PAD.b);
  const line = profile.map((p, i) => `${i ? "L" : "M"}${x(p.distNm).toFixed(1)},${y(p.altFt).toFixed(1)}`).join(" ");
  const area = `${line} L${x(total).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`;
  const todNm = progress.todNm !== null ? progress.alongNm + progress.todNm : null;
  const ax = x(progress.alongNm);
  const ay = y(altFt);
  const flown = profile.filter((p) => p.distNm <= progress.alongNm);
  const flownLine = [...flown.map((p) => [p.distNm, p.altFt] as const), [progress.alongNm, progress.plannedAltFt ?? altFt] as const]
    .map(([d, a], i) => `${i ? "L" : "M"}${x(d).toFixed(1)},${y(a).toFixed(1)}`)
    .join(" ");
  const ticks = [0, 0.5, 1].map((f) => Math.round((top / 1.08) * f / 1000) * 1000);
  const off = progress.vertical === "high" || progress.vertical === "low";
  return (
    <svg className="pc" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Vertical profile: ${Math.round(progress.alongNm)} of ${Math.round(total)} nm flown`}>
      {ticks.map((ft) => (
        <g key={ft}>
          <line className="pc__grid" x1={PAD.l} x2={W - PAD.r} y1={y(ft)} y2={y(ft)} />
          <text className="pc__tick" x={PAD.l - 4} y={y(ft) + 3} textAnchor="end">
            {ft === 0 ? "0" : `FL${Math.round(ft / 100)}`}
          </text>
        </g>
      ))}
      <path className="pc__area" d={area} />
      <path className="pc__plan" d={line} />
      <path className="pc__flown" d={flownLine} />
      {todNm !== null && (
        <g>
          <line className="pc__tod" x1={x(todNm)} x2={x(todNm)} y1={PAD.t} y2={H - PAD.b} />
          <text className="pc__label" x={x(todNm) + 4} y={PAD.t + 10}>
            T/D
          </text>
        </g>
      )}
      <text className="pc__tick" x={PAD.l} y={H - 6}>
        {profile[0]!.ident}
      </text>
      <text className="pc__tick" x={W - PAD.r} y={H - 6} textAnchor="end">
        {profile[profile.length - 1]!.ident}
      </text>
      {progress.plannedAltFt !== null && <line className={`pc__dev${off ? " is-off" : ""}`} x1={ax} x2={ax} y1={y(progress.plannedAltFt)} y2={ay} />}
      <circle className={`pc__me${off ? " is-off" : ""}`} cx={ax} cy={ay} r={5.5} />
    </svg>
  );
}
