import type { ReactNode } from "react";

export function Tile({
  label,
  value,
  unit,
  sub,
  tone,
  wide,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: "warn" | "good";
  wide?: boolean;
}) {
  return (
    <section className={`tile${tone ? ` tile--${tone}` : ""}${wide ? " tile--wide" : ""}`}>
      <h2 className="tile__label">{label}</h2>
      <div className="tile__value">
        {value}
        {unit && <span className="tile__unit">{unit}</span>}
      </div>
      {sub && <div className="tile__sub">{sub}</div>}
    </section>
  );
}

export function Flag({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={`flag${on ? " flag--on" : ""}`}>{children}</span>;
}
