import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CmdReply } from "../lib/bridge-client";

const DEFAULT_NOTE = "Not confirmed on your aircraft yet. Tell me if it works.";

export function PanelButton({ label, lit, onPress, disabled, unverified, small, note }: { label: string; lit?: boolean; onPress: () => void; disabled?: boolean; unverified?: boolean; small?: boolean; note?: string }) {
  const [flash, setFlash] = useState(false);
  return (
    <button
      type="button"
      className={`pbtn${small ? " pbtn--small" : ""}${lit ? " is-lit" : ""}${flash ? " is-flash" : ""}${unverified ? " is-unverified" : ""}`}
      aria-pressed={lit === undefined ? undefined : lit}
      disabled={disabled}
      title={unverified ? (note ?? DEFAULT_NOTE) : undefined}
      onClick={() => {
        setFlash(true);
        setTimeout(() => setFlash(false), 180);
        onPress();
      }}
    >
      {lit !== undefined && <span className="pbtn__bar" aria-hidden="true" />}
      <span className="pbtn__label">{label}</span>
    </button>
  );
}

export function SetValue({ label, hint, onSet, onClose }: { label: string; hint: string; onSet: (v: number) => Promise<CmdReply>; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = Number(text.replace(",", ".").replace(/^fl/i, "").trim()) * (/^fl/i.test(text.trim()) ? 100 : 1);
    if (!Number.isFinite(v) || text.trim() === "") return setErr("Enter a number.");
    setBusy(true);
    setErr(null);
    const r = await onSet(v);
    setBusy(false);
    if (r.ok) onClose();
    else setErr(r.error);
  };
  return (
    <form className="setval" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <label className="setval__label">
        Set {label}
        <input ref={input} inputMode="decimal" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={hint} disabled={busy} />
      </label>
      <div className="setval__row">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "Setting…" : "Set"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
      {err && (
        <p className="setval__err" role="alert">
          {err}
        </p>
      )}
    </form>
  );
}

