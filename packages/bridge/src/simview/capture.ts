import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../log.js";
import { MOCK_FRAME } from "./mock-frame.js";

/** One captured picture, or why there isn't one. */
export type CaptureResult =
  | { ok: true; jpeg: string; w: number; h: number }
  | { ok: false; reason: "no-window" | "minimized" | "unavailable"; message: string };

export interface FrameSource {
  grab(): Promise<CaptureResult>;
  /** Called when nobody has asked for a frame for a while: free whatever the source holds. */
  release(): void;
}

/** Same limits as Cobalt's sim view: at most 1024 x 576, JPEG quality 55. */
export const MAX_W = 1024;
export const MAX_H = 576;
export const JPEG_QUALITY = 55;

/**
 * The helper that takes the picture on Windows: a PowerShell process that stays open while someone is watching.
 * Each "g" line on its input answers with one line: "F <w> <h> <base64 jpeg>", "N" (no sim window), "M" (minimized) or "E <message>".
 * It finds the simulator by its process (FlightSimulator*.exe) first and its window title second (the title list Cobalt uses),
 * so a browser tab that merely mentions the sim isn't picked. It never falls back to the whole screen.
 */
const HELPER = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Diagnostics;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "using System.Text.RegularExpressions;",
  "public static class VbCap {",
  "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
  "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);",
  "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr h);",
  "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
  "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);",
  "  [DllImport(\"user32.dll\")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);",
  "  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
  "  [DllImport(\"dwmapi.dll\")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);",
  "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }",
  "  static readonly Regex Title = new Regex(\"Microsoft Flight Simulator|FlightSimulator|X-Plane\", RegexOptions.IgnoreCase);",
  "  public static IntPtr Find() {",
  "    IntPtr byProcess = IntPtr.Zero, byTitle = IntPtr.Zero;",
  "    EnumWindows((h, l) => {",
  "      if (!IsWindowVisible(h)) return true;",
  "      var sb = new StringBuilder(256);",
  "      GetWindowText(h, sb, 256);",
  "      string t = sb.ToString();",
  "      if (t.Length == 0) return true;",
  "      uint pid; GetWindowThreadProcessId(h, out pid);",
  "      string name = \"\";",
  "      try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }",
  "      if (byProcess == IntPtr.Zero && (name.StartsWith(\"FlightSimulator\", StringComparison.OrdinalIgnoreCase) || name.StartsWith(\"X-Plane\", StringComparison.OrdinalIgnoreCase))) byProcess = h;",
  "      else if (byTitle == IntPtr.Zero && Title.IsMatch(t) && !Regex.IsMatch(name, \"^(msedge|chrome|firefox|opera|brave|explorer|vbuddy|node)$\", RegexOptions.IgnoreCase)) byTitle = h;",
  "      return true;",
  "    }, IntPtr.Zero);",
  "    return byProcess != IntPtr.Zero ? byProcess : byTitle;",
  "  }",
  "  public static RECT Bounds(IntPtr h) {",
  "    RECT r;",
  "    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);",
  "    return r;",
  "  }",
  "}",
  "'@",
  "[void][VbCap]::SetProcessDPIAware()",
  "$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
  "$params = New-Object System.Drawing.Imaging.EncoderParameters 1",
  `$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]${JPEG_QUALITY})`,
  "$hwnd = [IntPtr]::Zero",
  "$checked = [DateTime]::MinValue",
  "function Is-Black($bmp) {",
  "  $dark = 0",
  "  foreach ($fx in 0.2, 0.4, 0.5, 0.6, 0.8) { foreach ($fy in 0.2, 0.5, 0.8) {",
  "    $p = $bmp.GetPixel([int]($bmp.Width * $fx), [int]($bmp.Height * $fy))",
  "    if ($p.R + $p.G + $p.B -lt 12) { $dark++ }",
  "  } }",
  "  return $dark -eq 15",
  "}",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($line -eq $null) { break }",
  "  if ($line -ne 'g') { continue }",
  "  try {",
  "    if ($hwnd -eq [IntPtr]::Zero -or -not [VbCap]::IsWindow($hwnd) -or ([DateTime]::UtcNow - $checked).TotalSeconds -gt 5) { $hwnd = [VbCap]::Find(); $checked = [DateTime]::UtcNow }",
  "    if ($hwnd -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('N'); [Console]::Out.Flush(); continue }",
  "    if ([VbCap]::IsIconic($hwnd)) { [Console]::Out.WriteLine('M'); [Console]::Out.Flush(); continue }",
  "    $r = [VbCap]::Bounds($hwnd)",
  "    $w = $r.R - $r.L; $h = $r.B - $r.T",
  "    if ($w -lt 16 -or $h -lt 16) { [Console]::Out.WriteLine('M'); [Console]::Out.Flush(); continue }",
  "    $full = New-Object System.Drawing.Bitmap $w, $h",
  "    $g = [System.Drawing.Graphics]::FromImage($full)",
  // The window's own picture first (PW_RENDERFULLCONTENT = 2: includes DirectX content on Windows 10 1809+), the screen area second.
  "    $wr = New-Object VbCap+RECT; [void][VbCap]::GetWindowRect($hwnd, [ref]$wr)",
  "    $whole = New-Object System.Drawing.Bitmap ($wr.R - $wr.L), ($wr.B - $wr.T)",
  "    $gw = [System.Drawing.Graphics]::FromImage($whole)",
  "    $hdc = $gw.GetHdc(); $okPrint = [VbCap]::PrintWindow($hwnd, $hdc, 2); $gw.ReleaseHdc($hdc); $gw.Dispose()",
  "    if ($okPrint) { $g.DrawImage($whole, (New-Object System.Drawing.Rectangle 0, 0, $w, $h), (New-Object System.Drawing.Rectangle ($r.L - $wr.L), ($r.T - $wr.T), $w, $h), [System.Drawing.GraphicsUnit]::Pixel) }",
  "    $whole.Dispose()",
  "    if (-not $okPrint -or (Is-Black $full)) { $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $h)) }",
  "    $g.Dispose()",
  `    $s = [Math]::Min(1.0, [Math]::Min(${MAX_W} / $w, ${MAX_H} / $h))`,
  "    $ow = [Math]::Max(1, [int]($w * $s)); $oh = [Math]::Max(1, [int]($h * $s))",
  "    $out = New-Object System.Drawing.Bitmap $ow, $oh",
  "    $go = [System.Drawing.Graphics]::FromImage($out)",
  "    $go.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear",
  "    $go.DrawImage($full, 0, 0, $ow, $oh); $go.Dispose(); $full.Dispose()",
  "    $ms = New-Object System.IO.MemoryStream",
  "    $out.Save($ms, $jpeg, $params); $out.Dispose()",
  "    [Console]::Out.WriteLine('F ' + $ow + ' ' + $oh + ' ' + [Convert]::ToBase64String($ms.ToArray())); [Console]::Out.Flush()",
  "    $ms.Dispose()",
  "  } catch {",
  "    [Console]::Out.WriteLine('E ' + ($_.Exception.Message -replace '[\\r\\n]+', ' ')); [Console]::Out.Flush()",
  "  }",
  "}",
].join("\r\n");

/** Takes the picture on Windows through the helper above. Started on the first frame asked for, stopped by release(). */
export class WindowsCapture implements FrameSource {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private waiting: ((line: string) => void) | null = null;
  private failedStarts = 0;
  /** The helper's first answer includes compiling it, so it gets longer. */
  private fresh = true;

  constructor(private log: Logger) {}

  private start(): ChildProcessWithoutNullStreams {
    const file = join(tmpdir(), "vbuddy-sim-view.ps1");
    writeFileSync(file, "﻿" + HELPER, "utf8");
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { windowsHide: true });
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        const w = this.waiting;
        this.waiting = null;
        w?.(line);
      }
    });
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d: string) => this.log.debug(`sim view helper: ${d.trim().slice(0, 300)}`));
    p.on("exit", (code) => {
      if (this.proc === p) this.proc = null;
      this.buf = "";
      const w = this.waiting;
      this.waiting = null;
      w?.(`E The capture helper stopped (code ${code}).`);
    });
    this.proc = p;
    this.fresh = true;
    return p;
  }

  grab(): Promise<CaptureResult> {
    if (this.failedStarts >= 3) return Promise.resolve({ ok: false, reason: "unavailable", message: "The sim view can't start on this PC (PowerShell didn't run the capture helper)." });
    const p = this.proc ?? this.start();
    return new Promise<CaptureResult>((done) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        // A late answer would be taken for the next frame's: start the helper again instead.
        this.release();
        done({ ok: false, reason: "unavailable", message: "The sim window took too long to capture." });
      }, this.fresh ? 20_000 : 4_000);
      this.waiting = (line) => {
        clearTimeout(timer);
        this.fresh = false;
        done(parse(line));
      };
      p.stdin.write("g\n");
    }).then((r) => {
      if (!r.ok && r.reason === "unavailable" && /stopped|ENOENT/.test(r.message)) this.failedStarts++;
      else if (r.ok) this.failedStarts = 0;
      return r;
    });
  }

  release() {
    const p = this.proc;
    this.proc = null;
    if (p) {
      p.stdin.end();
      setTimeout(() => p.kill(), 1000).unref();
    }
  }
}

export function parse(line: string): CaptureResult {
  if (line.startsWith("F ")) {
    const [, w, h, data] = line.split(" ");
    return { ok: true, w: Number(w), h: Number(h), jpeg: data ?? "" };
  }
  if (line === "N") return { ok: false, reason: "no-window", message: "Microsoft Flight Simulator's window wasn't found on this PC." };
  if (line === "M") return { ok: false, reason: "minimized", message: "The simulator window is minimized. Restore it on the PC to see it here." };
  return { ok: false, reason: "unavailable", message: line.startsWith("E ") ? `Couldn't capture the sim window: ${line.slice(2)}` : "Couldn't capture the sim window." };
}

/** The test flight's picture. */
export class MockCapture implements FrameSource {
  grab(): Promise<CaptureResult> {
    return Promise.resolve({ ok: true, ...MOCK_FRAME });
  }
  release() {}
}

/** No capture on this computer (not Windows). */
export class NoCapture implements FrameSource {
  grab(): Promise<CaptureResult> {
    return Promise.resolve({ ok: false, reason: "unavailable", message: "The sim view works when VBuddy runs on the Windows PC with the simulator." });
  }
  release() {}
}
