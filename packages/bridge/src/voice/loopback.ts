import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../log.js";

/*
 * Listening to what the PC plays on one output device (WASAPI loopback): the headset vPilot (or BeyondATC,
 * SayIntentions) talks into. A PowerShell process compiles a small C# helper (C# 5, for Windows PowerShell's built-in
 * compiler) that captures the device's mix, turns it into 16 kHz mono 16-bit samples and writes them, raw, to its
 * output. With "list" it prints the output devices as JSON lines instead. Nothing is recorded to disk here.
 */
const HELPER = String.raw`
param([string]$Mode = "capture", [string]$Device = "", [string]$Flow = "render")
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class VbMMDeviceEnumerator {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVbEnum {
  int EnumAudioEndpoints(int flow, int mask, out IVbCollection devices);
  int GetDefaultAudioEndpoint(int flow, int role, out IVbDevice device);
  int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IVbDevice device);
  int RegisterEndpointNotificationCallback(IntPtr c);
  int UnregisterEndpointNotificationCallback(IntPtr c);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVbCollection { int GetCount(out int n); int Item(int i, out IVbDevice d); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVbDevice {
  int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  int OpenPropertyStore(int access, out IVbProps props);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}
[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVbProps {
  int GetCount(out int n);
  int GetAt(int i, out VbKey k);
  int GetValue(ref VbKey k, out VbVariant v);
  int SetValue(ref VbKey k, ref VbVariant v);
  int Commit();
}
[StructLayout(LayoutKind.Sequential)] struct VbKey { public Guid fmt; public int pid; }
[StructLayout(LayoutKind.Explicit)] struct VbVariant { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr p2; }

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVbClient {
  int Initialize(int share, int flags, long duration, long period, IntPtr format, IntPtr session);
  int GetBufferSize(out uint frames);
  int GetStreamLatency(out long latency);
  int GetCurrentPadding(out uint padding);
  int IsFormatSupported(int share, IntPtr format, out IntPtr closest);
  int GetMixFormat(out IntPtr format);
  int GetDevicePeriod(out long def, out long min);
  int Start();
  int Stop();
  int Reset();
  int SetEventHandle(IntPtr h);
  int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}
[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVbCapture {
  int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong pos, out ulong qpc);
  int ReleaseBuffer(uint frames);
  int GetNextPacketSize(out uint frames);
}

public static class VbAudio {
  static readonly Guid IID_CLIENT = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
  static readonly Guid IID_CAPTURE = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
  static VbKey NAME = new VbKey { fmt = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

  static string Name(IVbDevice d) {
    IVbProps props; d.OpenPropertyStore(0, out props);
    VbVariant v; props.GetValue(ref NAME, out v);
    return v.vt == 31 ? Marshal.PtrToStringUni(v.p) : "";
  }
  static string Json(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

  public static void Run(string mode, string want, string flowName) {
    // render (0): what the PC plays, through loopback; capture (1): a microphone, as it is.
    int flow = flowName == "capture" ? 1 : 0;
    var en = (IVbEnum)new VbMMDeviceEnumerator();
    IVbDevice def; en.GetDefaultAudioEndpoint(flow, 0, out def);
    string defId; def.GetId(out defId);
    IVbCollection all; en.EnumAudioEndpoints(flow, 1, out all);
    int n; all.GetCount(out n);
    IVbDevice pick = null; string pickName = "";
    for (int i = 0; i < n; i++) {
      IVbDevice d; all.Item(i, out d);
      string id; d.GetId(out id);
      string name = Name(d);
      if (mode == "list") Console.WriteLine("{\"name\":" + Json(name) + ",\"default\":" + (id == defId ? "true" : "false") + "}");
      else if (pick == null && want.Length > 0 && name.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0) { pick = d; pickName = name; }
    }
    if (mode == "list") return;
    if (pick == null) { pick = def; pickName = Name(def); }
    Console.Error.WriteLine("DEVICE " + pickName);

    object o; Guid ic = IID_CLIENT; pick.Activate(ref ic, 23, IntPtr.Zero, out o);
    var client = (IVbClient)o;
    IntPtr fmt; client.GetMixFormat(out fmt);
    int tag = Marshal.ReadInt16(fmt, 0) & 0xFFFF;
    int ch = Marshal.ReadInt16(fmt, 2);
    int rate = Marshal.ReadInt32(fmt, 4);
    int bits = Marshal.ReadInt16(fmt, 14);
    bool isFloat = tag == 3;
    if (tag == 0xFFFE) isFloat = Marshal.ReadInt16(fmt, 24) == 3;
    int hr = client.Initialize(0, flow == 0 ? 0x00020000 : 0, 10000000, 0, fmt, IntPtr.Zero);
    if (hr != 0) throw new Exception("Initialize failed 0x" + hr.ToString("X8"));
    Guid cc = IID_CAPTURE; object co; client.GetService(ref cc, out co);
    var cap = (IVbCapture)co;
    client.Start();
    Console.Error.WriteLine("FORMAT " + rate + " " + ch + " " + bits + (isFloat ? " float" : " int"));

    // Exit when VBuddy goes away (its end of our input closes).
    var watch = new Thread(() => { try { while (Console.In.ReadLine() != null) {} } catch {} Environment.Exit(0); });
    watch.IsBackground = true; watch.Start();

    var outp = Console.OpenStandardOutput();
    var sw = Stopwatch.StartNew();
    long written = 0;
    double acc = 0; int cnt = 0; long phase = 0;
    var buf = new byte[32000];
    int bp = 0;
    int bytesPer = bits / 8;
    while (true) {
      Thread.Sleep(10);
      uint packet; cap.GetNextPacketSize(out packet);
      while (packet > 0) {
        IntPtr data; uint frames; uint flags; ulong p1; ulong p2;
        cap.GetBuffer(out data, out frames, out flags, out p1, out p2);
        bool silent = (flags & 2) != 0;
        int total = (int)frames * ch;
        float[] fb = null; short[] sb = null;
        if (!silent && isFloat && bits == 32) { fb = new float[total]; Marshal.Copy(data, fb, 0, total); }
        else if (!silent && bits == 16) { sb = new short[total]; Marshal.Copy(data, sb, 0, total); }
        for (int f = 0; f < frames; f++) {
          double s = 0;
          if (!silent) {
            for (int c = 0; c < ch; c++) {
              int k = f * ch + c;
              int off = k * bytesPer;
              if (fb != null) s += fb[k];
              else if (sb != null) s += sb[k] / 32768.0;
              else if (bits == 32) s += Marshal.ReadInt32(data, off) / 2147483648.0;
              else if (bits == 24) s += ((Marshal.ReadByte(data, off) | (Marshal.ReadByte(data, off + 1) << 8) | ((sbyte)Marshal.ReadByte(data, off + 2) << 16))) / 8388608.0;
            }
            s /= ch;
          }
          acc += s; cnt++;
          phase += 16000;
          if (phase >= rate) {
            phase -= rate;
            double v = acc / cnt; acc = 0; cnt = 0;
            if (v > 1) v = 1; if (v < -1) v = -1;
            short sv = (short)(v * 32767);
            buf[bp++] = (byte)(sv & 0xFF); buf[bp++] = (byte)((sv >> 8) & 0xFF);
            written++;
            if (bp >= buf.Length) { outp.Write(buf, 0, bp); bp = 0; }
          }
        }
        cap.ReleaseBuffer(frames);
        cap.GetNextPacketSize(out packet);
      }
      // Nothing playing: Windows sends no packets, so keep time with silence.
      long due = sw.ElapsedMilliseconds * 16;
      while (written < due - 1600) {
        buf[bp++] = 0; buf[bp++] = 0; written++;
        if (bp >= buf.Length) { outp.Write(buf, 0, bp); bp = 0; }
      }
      if (bp > 0) { outp.Write(buf, 0, bp); outp.Flush(); bp = 0; }
    }
  }
}
// Listening to chosen apps only (Windows 10 2004 and later): process loopback, one capture per app, mixed.
[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVbActivateOp { void GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVbActivateHandler { void ActivateCompleted(IVbActivateOp op); }
[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVbAgile {}
[ClassInterface(ClassInterfaceType.None), ComVisible(true)]
public class VbHandler : IVbActivateHandler, IVbAgile {
  public ManualResetEvent Done = new ManualResetEvent(false);
  public int Hr = -1; public object Iface;
  public void ActivateCompleted(IVbActivateOp op) {
    try { op.GetActivateResult(out Hr, out Iface); } catch (Exception e) { Hr = Marshal.GetHRForException(e); }
    Done.Set();
  }
}
class VbSrc {
  public string Token; public int Pid; public IVbClient Client; public IVbCapture Cap; public int Rate; public int Ch;
  public long Phase; public double Acc; public int Cnt; public long Pos = -1;
}

public static class VbApps {
  [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
  static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, IntPtr parameters, IVbActivateHandler handler, out IVbActivateOp op);
  static readonly Guid IID_CLIENT = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
  static readonly Guid IID_CAPTURE = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
  const int N = 64000;

  static IntPtr Fmt(int rate, int ch) {
    IntPtr f = Marshal.AllocHGlobal(18);
    Marshal.WriteInt16(f, 0, 1); Marshal.WriteInt16(f, 2, (short)ch); Marshal.WriteInt32(f, 4, rate);
    Marshal.WriteInt32(f, 8, rate * ch * 2); Marshal.WriteInt16(f, 12, (short)(ch * 2)); Marshal.WriteInt16(f, 14, 16); Marshal.WriteInt16(f, 16, 0);
    return f;
  }

  static IVbClient Activate(int pid) {
    IntPtr par = Marshal.AllocHGlobal(12);
    Marshal.WriteInt32(par, 0, 1);   // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
    Marshal.WriteInt32(par, 4, pid);
    Marshal.WriteInt32(par, 8, 0);   // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
    int size = IntPtr.Size == 8 ? 24 : 16;
    IntPtr pv = Marshal.AllocHGlobal(size);
    for (int i = 0; i < size; i++) Marshal.WriteByte(pv, i, 0);
    Marshal.WriteInt16(pv, 0, 65);   // VT_BLOB
    Marshal.WriteInt32(pv, 8, 12);
    Marshal.WriteIntPtr(pv, IntPtr.Size == 8 ? 16 : 12, par);
    var h = new VbHandler(); IVbActivateOp op;
    ActivateAudioInterfaceAsync("VAD\\Process_Loopback", IID_CLIENT, pv, h, out op);
    if (!h.Done.WaitOne(5000)) throw new Exception("timed out");
    if (h.Hr != 0 || h.Iface == null) throw new Exception("0x" + h.Hr.ToString("X8"));
    return (IVbClient)h.Iface;
  }

  static VbSrc Open(string token, int pid) {
    int[][] tries = new int[][] { new int[] { 16000, 1 }, new int[] { 48000, 2 }, new int[] { 44100, 2 } };
    string last = "";
    foreach (var t in tries) {
      IVbClient c = Activate(pid);
      int hr = c.Initialize(0, 0x00020000 | 0x00040000, 2000000, 0, Fmt(t[0], t[1]), IntPtr.Zero);
      if (hr != 0) { last = "0x" + hr.ToString("X8"); Marshal.ReleaseComObject(c); continue; }
      var evt = new AutoResetEvent(false);
      c.SetEventHandle(evt.SafeWaitHandle.DangerousGetHandle());
      Guid cc = IID_CAPTURE; object co; c.GetService(ref cc, out co);
      c.Start();
      var s = new VbSrc(); s.Token = token; s.Pid = pid; s.Client = c; s.Cap = (IVbCapture)co; s.Rate = t[0]; s.Ch = t[1];
      GC.KeepAlive(evt);
      return s;
    }
    throw new Exception("Initialize " + last);
  }

  static bool Alive(int pid) {
    try { return !Process.GetProcessById(pid).HasExited; } catch { return false; }
  }

  static void Pump(VbSrc s, double[] ring, long written) {
    uint packet; int hr = s.Cap.GetNextPacketSize(out packet);
    if (hr != 0) throw new Exception("0x" + hr.ToString("X8"));
    while (packet > 0) {
      IntPtr data; uint frames; uint flags; ulong p1; ulong p2;
      hr = s.Cap.GetBuffer(out data, out frames, out flags, out p1, out p2);
      if (hr != 0) throw new Exception("0x" + hr.ToString("X8"));
      bool silent = (flags & 2) != 0;
      int total = (int)frames * s.Ch;
      short[] sb = null;
      if (!silent) { sb = new short[total]; Marshal.Copy(data, sb, 0, total); }
      // A little ahead of the writer, so uneven packets don't get cut.
      if (s.Pos < written) s.Pos = written + 1600;
      for (int f = 0; f < frames; f++) {
        double v = 0;
        if (sb != null) { for (int c = 0; c < s.Ch; c++) v += sb[f * s.Ch + c] / 32768.0; v /= s.Ch; }
        s.Acc += v; s.Cnt++;
        s.Phase += 16000;
        if (s.Phase >= s.Rate) {
          s.Phase -= s.Rate;
          double o = s.Acc / s.Cnt; s.Acc = 0; s.Cnt = 0;
          if (s.Pos - written < N) ring[s.Pos % N] += o;
          s.Pos++;
        }
      }
      s.Cap.ReleaseBuffer(frames);
      s.Cap.GetNextPacketSize(out packet);
    }
  }

  public static void Run(string list) {
    Exception err = null;
    var t = new Thread(() => { try { Loop(list); } catch (Exception e) { err = e; } });
    t.SetApartmentState(ApartmentState.MTA);
    t.IsBackground = true;
    t.Start();
    t.Join();
    if (err != null) { Console.Error.WriteLine("ERROR " + err.Message); Environment.Exit(2); }
  }

  static void Loop(string list) {
    string[] want = list.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
    var srcs = new List<VbSrc>();
    var failed = new Dictionary<int, bool>();
    int self = Process.GetCurrentProcess().Id;
    var watch = new Thread(() => { try { while (Console.In.ReadLine() != null) {} } catch {} Environment.Exit(0); });
    watch.IsBackground = true; watch.Start();

    var outp = Console.OpenStandardOutput();
    var ring = new double[N];
    var buf = new byte[32000];
    int bp = 0;
    long written = 0;
    var sw = Stopwatch.StartNew();
    long nextScan = 0;
    string report = null;
    while (true) {
      Thread.Sleep(10);
      if (sw.ElapsedMilliseconds >= nextScan) {
        nextScan = sw.ElapsedMilliseconds + 3000;
        srcs.RemoveAll(x => { bool gone = !Alive(x.Pid); if (gone) { try { x.Client.Stop(); } catch {} } return gone; });
        Process[] procs = Process.GetProcesses();
        foreach (string raw in want) {
          string tok = raw.Trim();
          if (tok.Length == 0 || srcs.Exists(x => x.Token == tok)) continue;
          Process best = null; DateTime bestAt = DateTime.MaxValue;
          foreach (var p in procs) {
            if (p.Id == self || p.ProcessName.IndexOf(tok, StringComparison.OrdinalIgnoreCase) < 0) continue;
            DateTime at = DateTime.MaxValue; try { at = p.StartTime; } catch {}
            if (best == null || at < bestAt) { best = p; bestAt = at; }
          }
          if (best == null || failed.ContainsKey(best.Id)) continue;
          try { srcs.Add(Open(tok, best.Id)); Console.Error.WriteLine("APP " + tok + " " + best.ProcessName + " " + best.Id); }
          catch (Exception e) { failed[best.Id] = true; Console.Error.WriteLine("FAIL " + tok + " " + e.Message); }
        }
        var names = new List<string>(); foreach (var x in srcs) names.Add(x.Token);
        string now = string.Join(",", names.ToArray());
        if (now != report) { report = now; Console.Error.WriteLine("APPS " + now); }
      }
      for (int i = srcs.Count - 1; i >= 0; i--) {
        try { Pump(srcs[i], ring, written); }
        catch (Exception e) { Console.Error.WriteLine("LOST " + srcs[i].Token + " " + e.Message); try { srcs[i].Client.Stop(); } catch {} srcs.RemoveAt(i); report = null; }
      }
      long due = sw.ElapsedMilliseconds * 16 - 3200;
      while (written < due) {
        int k = (int)(written % N);
        double v = ring[k]; ring[k] = 0;
        if (v > 1) v = 1; if (v < -1) v = -1;
        short sv = (short)(v * 32767);
        buf[bp++] = (byte)(sv & 0xFF); buf[bp++] = (byte)((sv >> 8) & 0xFF);
        written++;
        if (bp >= buf.Length) { outp.Write(buf, 0, bp); bp = 0; }
      }
      if (bp > 0) { outp.Write(buf, 0, bp); outp.Flush(); bp = 0; }
    }
  }
}
'@
if ($Flow -eq 'apps') { [VbApps]::Run($Device) } else { [VbAudio]::Run($Mode, $Device, $Flow) }
`;

function helperFile(): string {
  const file = join(tmpdir(), "vbuddy-atc-audio.ps1");
  writeFileSync(file, "﻿" + HELPER, "utf8");
  return file;
}

const ps = (args: string[]) => spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperFile(), ...args], { windowsHide: true });

export interface OutputDevice {
  name: string;
  default: boolean;
}

/** Audio coming in: 16 kHz mono 16-bit samples. */
export interface AudioSource {
  start(device: string, onSamples: (s: Int16Array, at: number) => void, onStop: (why: string) => void): void;
  stop(): void;
  devices(): Promise<OutputDevice[]>;
  /** The device actually opened, once known. */
  current(): string | null;
}

/** No audio capture on this computer (not Windows). */
export class NoAudio implements AudioSource {
  current() {
    return null;
  }
  devices() {
    return Promise.resolve([]);
  }
  start(_d: string, _s: (s: Int16Array, at: number) => void, onStop: (why: string) => void) {
    onStop("Listening to the radio works when VBuddy runs on the Windows PC with the simulator.");
  }
  stop() {}
}

/**
 * The apps that speak ATC, and the part of their program's name VBuddy looks for (each app's whole process tree is
 * heard, nothing else on the PC).
 */
export const ATC_APPS = [
  { key: "vpilot", name: "vPilot", proc: "vPilot" },
  { key: "xpilot", name: "xPilot", proc: "xPilot" },
  { key: "altitude", name: "Altitude (IVAO)", proc: "Altitude" },
  { key: "swift", name: "swift", proc: "swift" },
  { key: "sayintentions", name: "SayIntentions.AI", proc: "SayIntentions" },
  { key: "beyondatc", name: "BeyondATC", proc: "BeyondATC" },
] as const;
export type AtcAppKey = (typeof ATC_APPS)[number]["key"];
export const isAtcAppKey = (k: unknown): k is AtcAppKey => ATC_APPS.some((a) => a.key === k);
/** The program names to listen to: the chosen apps', then any typed in ("MyClient, other.exe"). */
export function appTokens(keys: readonly string[], extra: string): string[] {
  const out = ATC_APPS.filter((a) => keys.includes(a.key)).map((a) => a.proc as string);
  for (const raw of extra.split(/[,;]/)) {
    const t = raw.trim().replace(/\.exe$/i, "").replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/**
 * WASAPI on Windows: loopback of an output device ("render"), a microphone ("capture"), or only some apps' sound
 * ("apps": `device` is then their program names, comma separated).
 */
export class WindowsLoopback implements AudioSource {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private dev: string | null = null;
  private devCbs: Array<() => void> = [];
  /** Apps that couldn't be listened to, and why. */
  problems = new Map<string, string>();
  constructor(
    private log: Logger,
    private flow: "render" | "capture" | "apps" = "render",
  ) {}

  /** Called when the device opened (or, for apps, the set of apps being heard) changes. */
  onDevice(cb: () => void) {
    this.devCbs.push(cb);
  }
  private setDev(d: string | null) {
    if (d === this.dev) return;
    this.dev = d;
    for (const cb of this.devCbs) cb();
  }

  current() {
    return this.dev;
  }

  devices(): Promise<OutputDevice[]> {
    if (this.flow === "apps") return Promise.resolve([]);
    return new Promise((done) => {
      const p = ps(["list", "", this.flow]);
      let out = "";
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (d: string) => (out += d));
      p.on("error", () => done([]));
      p.on("exit", () => {
        const list: OutputDevice[] = [];
        for (const line of out.split(/\r?\n/)) {
          try {
            if (line.trim()) list.push(JSON.parse(line) as OutputDevice);
          } catch {
            /* not a device line */
          }
        }
        done(list);
      });
      setTimeout(() => p.kill(), 30_000).unref();
    });
  }

  start(device: string, onSamples: (s: Int16Array, at: number) => void, onStop: (why: string) => void) {
    this.stop();
    const p = ps(["capture", device, this.flow]);
    this.proc = p;
    this.problems.clear();
    let carry: Buffer = Buffer.alloc(0);
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      const all = carry.length ? Buffer.concat([carry, d]) : d;
      const even = all.length - (all.length % 2);
      carry = all.subarray(even);
      if (!even) return;
      const copy = Buffer.from(all.subarray(0, even));
      onSamples(new Int16Array(copy.buffer, copy.byteOffset, even / 2), Date.now() - (even / 2 / 16));
    });
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d: string) => {
      for (const line of d.split(/\r?\n/)) {
        if (line.startsWith("DEVICE ")) {
          this.setDev(line.slice(7).trim());
          this.log.info(`ATC voice: ${this.flow === "capture" ? "your microphone" : "listening to"} "${this.dev}"`);
        } else if (line.startsWith("APPS")) {
          const names = line.slice(4).trim();
          this.setDev(names ? names.split(",").join(", ") : "");
          this.log.info(names ? `ATC voice: listening to ${this.dev}` : "ATC voice: waiting for an ATC app to start");
        } else if (line.startsWith("APP ")) {
          const [tok] = line.slice(4).trim().split(" ");
          if (tok) this.problems.delete(tok);
          this.log.debug(`ATC voice: ${line.slice(4).trim()}`);
        } else if (line.startsWith("FAIL ") || line.startsWith("LOST ")) {
          const rest = line.slice(5).trim();
          const sp = rest.indexOf(" ");
          const tok = sp > 0 ? rest.slice(0, sp) : rest;
          this.problems.set(tok, sp > 0 ? rest.slice(sp + 1) : "");
          this.log.warn(`ATC voice: couldn't listen to ${tok} (${rest.slice(sp + 1)})`);
          for (const cb of this.devCbs) cb();
        } else if (line.startsWith("FORMAT ")) this.log.debug(`ATC voice: device format ${line.slice(7)}`);
        else if (line.trim()) err = (err + " " + line.trim()).slice(-400);
      }
    });
    p.on("error", (e) => onStop(`The audio helper couldn't start (${e.message}).`));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      onStop(code === 0 ? "stopped" : `The audio helper stopped (code ${code})${err ? `: ${err.trim()}` : ""}.`);
    });
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.setDev(null);
    if (p) {
      p.stdin.end();
      setTimeout(() => p.kill(), 1000).unref();
    }
  }
}
