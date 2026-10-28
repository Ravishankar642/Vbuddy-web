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
'@
[VbAudio]::Run($Mode, $Device, $Flow)
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

/** WASAPI on Windows: loopback of an output device ("render"), or a microphone ("capture"). */
export class WindowsLoopback implements AudioSource {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private dev: string | null = null;
  constructor(
    private log: Logger,
    private flow: "render" | "capture" = "render",
  ) {}

  current() {
    return this.dev;
  }

  devices(): Promise<OutputDevice[]> {
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
          this.dev = line.slice(7).trim();
          this.log.info(`ATC voice: ${this.flow === "capture" ? "your microphone" : "listening to"} "${this.dev}"`);
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
    this.dev = null;
    if (p) {
      p.stdin.end();
      setTimeout(() => p.kill(), 1000).unref();
    }
  }
}
