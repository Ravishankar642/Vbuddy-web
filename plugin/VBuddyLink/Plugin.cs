using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using RossCarlson.Vatsim.Vpilot.Plugins;
using RossCarlson.Vatsim.Vpilot.Plugins.Exceptions;

namespace VBuddyLink
{
    /// <summary>
    /// Passes vPilot's network state and chat to the VBuddy bridge (ws://127.0.0.1:4789/plugin) and carries
    /// out the bridge's commands. It holds no settings of its own beyond the optional VBuddyLink.ini.
    /// </summary>
    public class Plugin : IPlugin
    {
        public string Name { get { return "VBuddy Link"; } }

        private IBroker _vPilot;
        private BridgeLink _link;
        private SynchronizationContext _ui;

        // What the bridge needs to know about the current session, re-sent whenever the link (re)connects.
        private readonly object _lock = new object();
        private bool _connected;
        private string _callsign, _type, _selcal;
        private bool _observer;

        public void Initialize(IBroker broker)
        {
            _vPilot = broker;
            _ui = SynchronizationContext.Current;

            var settings = Settings.Load(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location));
            _link = new BridgeLink(settings, Handle, SendNetState, Log);

            broker.NetworkConnected += (s, e) =>
            {
                lock (_lock) { _connected = true; _callsign = e.Callsign; _type = e.TypeCode; _selcal = e.SelcalCode; _observer = e.ObserverMode; }
                SendNetState();
            };
            broker.NetworkDisconnected += (s, e) =>
            {
                lock (_lock) { _connected = false; _observer = false; }
                SendNetState();
            };
            broker.RadioMessageReceived += (s, e) => _link.Send(Chat("radio", e.From, e.Frequencies, e.Message));
            broker.PrivateMessageReceived += (s, e) => _link.Send(Chat("private", e.From, null, e.Message));
            broker.BroadcastMessageReceived += (s, e) => _link.Send(Chat("broadcast", e.From, null, e.Message));
            broker.SelcalAlertReceived += (s, e) => _link.Send(Chat("selcal", e.From, e.Frequencies, ""));
            // (No stop on SessionEnded: if vPilot raises it when a VATSIM session ends rather than when vPilot closes, the link would stay off until the next vPilot start.)

            _link.Start();
            Log("Started. Looking for the VBuddy bridge at " + settings.Host + ":" + settings.Port);
        }

        private static Dictionary<string, object> Chat(string kind, string from, int[] freqs, string text)
        {
            var f = new List<object>();
            if (freqs != null) foreach (var x in freqs) f.Add(x);
            return new Dictionary<string, object> { { "t", "chat" }, { "kind", kind }, { "from", from ?? "" }, { "freqs", f }, { "text", text ?? "" } };
        }

        private void SendNetState()
        {
            bool c, o; string cs, ty, sc;
            lock (_lock) { c = _connected; o = _observer; cs = _callsign; ty = _type; sc = _selcal; }
            _link.Send(new Dictionary<string, object>
            {
                { "t", "net" }, { "connected", c }, { "callsign", c ? cs : null }, { "type", ty }, { "selcal", sc }, { "observer", o },
            });
        }

        private string _logFile;
        private readonly object _logLock = new object();

        /// <summary>To vPilot's debug window and to VBuddyLink.log next to the DLL (the window can miss lines written while vPilot starts).</summary>
        private void Log(string msg)
        {
            try { _vPilot.PostDebugMessage("[VBuddy Link] " + msg); } catch { }
            try
            {
                lock (_logLock)
                {
                    if (_logFile == null) _logFile = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? ".", "VBuddyLink.log");
                    var fi = new FileInfo(_logFile);
                    if (fi.Exists && fi.Length > 200 * 1024) File.Delete(_logFile);
                    File.AppendAllText(_logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + msg + Environment.NewLine);
                }
            }
            catch { }
        }

        /// <summary>Runs one command from the bridge on vPilot's own thread and reports how it went.</summary>
        private void Handle(string id, string op, Dictionary<string, object> cmd)
        {
            Action run = () =>
            {
                try
                {
                    switch (op)
                    {
                        case "connect": _vPilot.RequestConnect(Str(cmd, "callsign"), Str(cmd, "type"), Str(cmd, "selcal")); break;
                        case "disconnect": _vPilot.RequestDisconnect(); break;
                        case "sendRadio": _vPilot.SendRadioMessage(Str(cmd, "text")); break;
                        case "sendPrivate": _vPilot.SendPrivateMessage(Str(cmd, "to"), Str(cmd, "text")); break;
                        case "ident": _vPilot.SquawkIdent(); break;
                        case "modeC": _vPilot.SetModeC(cmd.ContainsKey("on") && cmd["on"] is bool && (bool)cmd["on"]); break;
                        default: _link.Reply(id, false, "Unknown command " + op); return;
                    }
                    _link.Reply(id, true, null);
                }
                catch (AlreadyConnectedException) { _link.Reply(id, false, "vPilot is already connected."); }
                catch (NotConnectedException) { _link.Reply(id, false, "vPilot isn't connected to VATSIM."); }
                catch (SimNotReadyException) { _link.Reply(id, false, "The simulator isn't ready yet."); }
                catch (NotTransmittingException) { _link.Reply(id, false, "vPilot isn't set to transmit on a radio (select TX on COM1 or COM2 in vPilot)."); }
                catch (Exception ex) { _link.Reply(id, false, ex.Message); }
            };
            if (_ui != null) _ui.Post(_ => run(), null);
            else run();
        }

        private static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v != null ? v.ToString() : "";
        }
    }
}
