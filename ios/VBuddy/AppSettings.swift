import UIKit

/// What the app remembers, and the switches in iOS Settings → VBuddy (Settings.bundle).
enum AppSettings {
    static let addressKey = "bridgeAddress"
    static let keepScreenOnKey = "keepScreenOn"
    static let resetAddressKey = "resetAddress"
    /// The port the VBuddy bridge listens on when none is typed.
    static let defaultPort = 4799

    static var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }

    static func registerDefaults() {
        UserDefaults.standard.register(defaults: [keepScreenOnKey: true, resetAddressKey: false])
    }

    static var address: URL? {
        get { UserDefaults.standard.string(forKey: addressKey).flatMap { URL(string: $0) } }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: addressKey) }
    }

    /// "Change address" was switched on in iOS Settings: forget the address once and switch it back off.
    static func takeResetRequest() -> Bool {
        guard UserDefaults.standard.bool(forKey: resetAddressKey) else { return false }
        UserDefaults.standard.set(false, forKey: resetAddressKey)
        return true
    }

    static func applyKeepScreenOn() {
        UIApplication.shared.isIdleTimerDisabled = UserDefaults.standard.bool(forKey: keepScreenOnKey)
    }

    /// "192.168.1.23" → http://192.168.1.23:4799/ ; "https://relay.example.com" stays as it is.
    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        let lower = s.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") { s = "http://" + s }
        guard var c = URLComponents(string: s), let host = c.host, !host.isEmpty else { return nil }
        if c.port == nil && c.scheme?.lowercased() == "http" { c.port = defaultPort }
        c.path = "/"
        c.query = nil
        c.fragment = nil
        return c.url
    }

    /// Asks the bridge whether it's there (GET /api/health).
    static func check(_ base: URL, completion: @escaping (String?) -> Void) {
        let url = base.appendingPathComponent("api/health")
        let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
        URLSession.shared.dataTask(with: req) { _, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let problem: String?
            if let error = error as? URLError {
                switch error.code {
                case .timedOut, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost:
                    problem = "No answer from \(base.host ?? "that address"). Check that VBuddy is running on your PC and that this phone is on the same Wi-Fi."
                case .notConnectedToInternet:
                    problem = "This phone isn't on a network. Join the same Wi-Fi as your PC."
                default:
                    problem = "Couldn't connect (\(error.localizedDescription)). If iPhone asked to find devices on your local network, tap Allow, then try again."
                }
            } else if let error {
                problem = "Couldn't connect (\(error.localizedDescription))."
            } else if code == 0 || code >= 500 {
                problem = "\(base.host ?? "That address") answered, but it doesn't look like VBuddy."
            } else {
                problem = nil
            }
            DispatchQueue.main.async { completion(problem) }
        }.resume()
    }
}

extension UIColor {
    private static func hex(_ v: UInt32) -> UIColor {
        UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
    private static func pair(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? hex(dark) : hex(light) }
    }
    /// The same colours as the web app (styles.css).
    static let vbBackground = pair(0xf7f1f3, 0x13060c)
    static let vbPanel = pair(0xffffff, 0x1e0b15)
    static let vbWell = pair(0xf4ebef, 0x170810)
    static let vbInk = pair(0x2a0a1a, 0xf7eef2)
    static let vbMuted = pair(0x7a5a68, 0xc9a9b8)
    static let vbBrand = hex(0x8e1052)
    static let vbDanger = pair(0xb3261e, 0xf2a0aa)
}
