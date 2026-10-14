using System;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace VBuddyLink
{
    /// <summary>
    /// The WebSocket to the bridge. Reconnects by itself (the bridge may start after vPilot, or restart),
    /// says hello and the current network state each time it connects, and passes commands to the plugin.
    /// </summary>
    internal class BridgeLink
    {
        private const int ProtocolVersion = 1;
        private readonly Settings _settings;
        private readonly Action<string, string, Dictionary<string, object>> _onCommand;
        private readonly Action _onConnected;
        private readonly Action<string> _log;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = 1 << 20 };
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private CancellationTokenSource _cts;
        private ClientWebSocket _ws;
        private volatile bool _up;
        private string _lastError = "";
        private volatile bool _acked;
        private readonly object _chainLock = new object();
        private Task _tail = Task.FromResult(0);

        public BridgeLink(Settings s, Action<string, string, Dictionary<string, object>> onCommand, Action onConnected, Action<string> log)
        {
            _settings = s; _onCommand = onCommand; _onConnected = onConnected; _log = log;
        }

        public void Start()
        {
            _cts = new CancellationTokenSource();
            Task.Run(() => Loop(_cts.Token));
        }

        public void Stop()
        {
            try { if (_cts != null) _cts.Cancel(); } catch { }
            try { if (_ws != null) _ws.Abort(); } catch { }
        }

        /// <summary>Sends a message if the bridge is there; if not it is dropped (the state is re-sent on connect).</summary>
        public void Send(Dictionary<string, object> msg)
        {
            if (!_up) return;
            var text = _json.Serialize(msg);
            // One after another, in the order they were queued (hello must arrive before the rest).
            lock (_chainLock) _tail = _tail.ContinueWith(_ => SendAsync(text), TaskScheduler.Default).Unwrap();
        }

        public void Reply(string id, bool ok, string error)
        {
            var m = new Dictionary<string, object> { { "t", "result" }, { "id", id }, { "ok", ok } };
            if (error != null) m["error"] = error;
            Send(m);
        }

        private async Task SendAsync(string text)
        {
            var ws = _ws;
            if (ws == null || ws.State != WebSocketState.Open) return;
            await _sendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                var bytes = Encoding.UTF8.GetBytes(text);
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token).ConfigureAwait(false);
            }
            catch { /* the receive loop notices a dead socket */ }
            finally { _sendLock.Release(); }
        }

        private async Task Loop(CancellationToken ct)
        {
            var delay = 1000;
            while (!ct.IsCancellationRequested)
            {
                var ws = new ClientWebSocket();
                ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                // The bridge is on this PC. Without this, .NET Framework looks up a system proxy first (auto-detect can take
                // 20-40 s) and any proxy or VPN setting can swallow 127.0.0.1; that made connecting work only every other try.
                ws.Options.Proxy = null;
                _ws = ws;
                _acked = false;
                try
                {
                    // Never wait forever on a connect that stalls: give up after 10 s and try again.
                    using (var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct))
                    {
                        attempt.CancelAfter(TimeSpan.FromSeconds(10));
                        await ws.ConnectAsync(new Uri("ws://" + _settings.Host + ":" + _settings.Port + "/plugin"), attempt.Token).ConfigureAwait(false);
                    }
                    _log("Connected the socket to " + _settings.Host + ":" + _settings.Port + "; saying hello.");
                    _up = true;
                    delay = 1000;
                    Send(new Dictionary<string, object> { { "t", "hello" }, { "protocol", ProtocolVersion }, { "plugin", "VBuddyLink 1.0.0" } });
                    _onConnected();
                    // The bridge answers hello with "welcome"; if it doesn't within 5 s this connection is not usable, so start over.
                    var watchdog = Task.Delay(5000, ct).ContinueWith(t => { if (!t.IsCanceled && !_acked) { try { ws.Abort(); } catch { } } });
                    await Receive(ws, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception ex)
                {
                    var why = ex is OperationCanceledException ? "timed out" : (ex.InnerException != null ? ex.InnerException.Message : ex.Message);
                    if (why != _lastError) { _log("Can't reach the VBuddy bridge at " + _settings.Host + ":" + _settings.Port + " (" + why + "). Is it running on this PC? Retrying."); _lastError = why; }
                }
                finally
                {
                    if (_up && _acked) _log("Lost the VBuddy bridge; will keep trying.");
                    else if (_up) _log("The bridge accepted the connection but didn't answer; trying again.");
                    _up = false;
                    try { ws.Dispose(); } catch { }
                }
                try { await Task.Delay(delay, ct).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
                delay = Math.Min(5000, delay * 2);
            }
        }

        private async Task Receive(ClientWebSocket ws, CancellationToken ct)
        {
            var buf = new byte[16 * 1024];
            var sb = new StringBuilder();
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                sb.Clear();
                WebSocketReceiveResult r;
                do
                {
                    r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), ct).ConfigureAwait(false);
                    if (r.MessageType == WebSocketMessageType.Close) return;
                    sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
                    if (sb.Length > 256 * 1024) return;
                } while (!r.EndOfMessage);

                try
                {
                    var cmd = _json.DeserializeObject(sb.ToString()) as Dictionary<string, object>;
                    if (cmd == null) continue;
                    object t0;
                    if (cmd.TryGetValue("t", out t0) && "welcome".Equals(t0))
                    {
                        _acked = true;
                        _lastError = "";
                        _log("Connected to the VBuddy bridge.");
                        continue;
                    }
                    object op, id;
                    if (cmd.TryGetValue("op", out op) && cmd.TryGetValue("id", out id) && op != null && id != null)
                        _onCommand(id.ToString(), op.ToString(), cmd);
                }
                catch (Exception ex) { _log("Bad message from the bridge: " + ex.Message); }
            }
        }
    }
}
