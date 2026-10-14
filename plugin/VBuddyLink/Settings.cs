using System;
using System.IO;

namespace VBuddyLink
{
    /// <summary>VBuddyLink.ini next to the DLL (optional). Lines like Port=4789. # starts a comment.</summary>
    internal class Settings
    {
        public string Host = "127.0.0.1";
        public int Port = 4789;

        public static Settings Load(string dir)
        {
            var s = new Settings();
            try
            {
                var path = Path.Combine(dir ?? ".", "VBuddyLink.ini");
                if (!File.Exists(path)) return s;
                foreach (var raw in File.ReadAllLines(path))
                {
                    var line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#") || line.StartsWith(";") || line.StartsWith("[")) continue;
                    var i = line.IndexOf('=');
                    if (i < 0) continue;
                    var k = line.Substring(0, i).Trim().ToLowerInvariant();
                    var v = line.Substring(i + 1).Trim();
                    int n;
                    if (k == "port" && int.TryParse(v, out n) && n > 0 && n < 65536) s.Port = n;
                    else if (k == "host" && v.Length > 0) s.Host = v;
                }
            }
            catch { /* defaults */ }
            return s;
        }
    }
}
