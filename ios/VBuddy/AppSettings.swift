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

    /// "Change phone link" was switched on in iOS Settings: forget the address once and switch it back off.
    static func takeResetRequest() -> Bool {
        guard UserDefaults.standard.bool(forKey: resetAddressKey) else { return false }
        UserDefaults.standard.set(false, forKey: resetAddressKey)
        return true
    }

    static func applyKeepScreenOn() {
        UIApplication.shared.isIdleTimerDisabled = UserDefaults.standard.bool(forKey: keepScreenOnKey)
    }

    /// The VBuddy cloud relay. The phone link in the VBuddy window is https://<relay>/?r=<12-character ID>.
    static let defaultRelayHost = "vbuddy.duckdns.org"
    /// The cookie the relay routes by, and the query parameter that sets it (packages/protocol/src/tunnel.ts).
    static let routeCookie = "vb"
    static let routeParam = "r"

    static func isLinkId(_ s: String) -> Bool {
        s.count == 12 && s.allSatisfy { ("a"..."z").contains($0) || ("2"..."7").contains($0) }
    }

    /// What people paste or scan, turned into the address the app opens:
    ///  - "abcd2345wxyz" (the phone link ID)            → https://vbuddy.duckdns.org/?r=abcd2345wxyz
    ///  - "https://vbuddy.duckdns.org/?r=abcd2345wxyz"  → as it is (another relay works too)
    ///  - "192.168.1.23" (the PC on the same Wi-Fi)      → http://192.168.1.23:4799/
    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if isLinkId(s.lowercased()) { return URL(string: "https://\(defaultRelayHost)/?\(routeParam)=\(s.lowercased())") }
        let lower = s.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            let looksLocal = s.range(of: #"^(localhost|\d{1,3}(\.\d{1,3}){3})(:|/|$)"#, options: .regularExpression) != nil
            s = (looksLocal ? "http://" : "https://") + s
        }
        guard var c = URLComponents(string: s), let host = c.host, !host.isEmpty else { return nil }
        if c.port == nil && c.scheme?.lowercased() == "http" && host.range(of: #"^(localhost|\d{1,3}(\.\d{1,3}){3})$"#, options: .regularExpression) != nil {
            c.port = defaultPort
        }
        let id = c.queryItems?.first(where: { $0.name == routeParam })?.value?.lowercased()
        c.path = "/"
        c.queryItems = (id.map(isLinkId) ?? false) ? [URLQueryItem(name: routeParam, value: id)] : nil
        c.fragment = nil
        return c.url
    }

    /// https://vbuddy.duckdns.org/?r=abcd2345wxyz → https://vbuddy.duckdns.org/
    static func base(of url: URL) -> URL {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false) ?? URLComponents()
        c.path = "/"
        c.query = nil
        c.fragment = nil
        return c.url ?? url
    }

    /// The phone link ID in an address, if it goes through the relay.
    static func linkId(of url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == routeParam })?.value
    }

    /// Asks VBuddy whether it's there (GET /api/health, through the relay when the address has a phone link ID).
    static func check(_ address: URL, completion: @escaping (String?) -> Void) {
        let root = base(of: address)
        let id = linkId(of: address)
        var req = URLRequest(url: root.appendingPathComponent("api/health"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        if let id {
            req.httpShouldHandleCookies = false
            req.setValue("\(routeCookie)=\(id)", forHTTPHeaderField: "Cookie")
        }
        let where_ = root.host ?? "that address"
        URLSession.shared.dataTask(with: req) { _, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let problem: String?
            if let error = error as? URLError {
                switch error.code {
                case .notConnectedToInternet, .dataNotAllowed:
                    problem = "This phone isn't online. Turn on Wi-Fi or mobile data."
                case .timedOut, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .dnsLookupFailed:
                    problem = id != nil
                        ? "No answer from the VBuddy relay (\(where_)). Check your internet connection and try again."
                        : "No answer from \(where_). Check that VBuddy is running on your PC and that this phone is on the same Wi-Fi."
                case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot:
                    problem = "\(where_) didn't offer a secure connection. Check the link."
                default:
                    problem = "Couldn't connect (\(error.localizedDescription))."
                }
            } else if let error {
                problem = "Couldn't connect (\(error.localizedDescription))."
            } else if id != nil && code == 503 {
                problem = "Your PC isn't connected to the relay. Start VBuddy on the PC and switch on Away from home (cloud relay) in its window."
            } else if code == 0 || code >= 500 {
                problem = "\(where_) answered, but VBuddy didn't (error \(code)). Try again in a moment."
            } else if code == 404 {
                problem = "\(where_) doesn't look like VBuddy. Check the link."
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
