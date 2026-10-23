import UIKit
import WebKit

/// VBuddy itself: the web app from your PC, through the VBuddy cloud relay (or straight from the PC on the same Wi-Fi), full screen.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    /// The address the app opens: the phone link (https://relay/?r=ID), or the PC's own address.
    let base: URL
    var onChangeAddress: (() -> Void)?

    private var webView: WKWebView!
    private let offline = OfflineView()
    private var loadedOnce = false

    init(base: URL) {
        self.base = base
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "vbuddy")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .default }
    override var prefersHomeIndicatorAutoHidden: Bool { false }
    override var canBecomeFirstResponder: Bool { true }

    override func loadView() {
        let content = WKUserContentController()
        if let path = Bundle.main.path(forResource: "vbuddy-ios", ofType: "js"),
           let src = try? String(contentsOfFile: path, encoding: .utf8) {
            let js = src.replacingOccurrences(of: "__VBUDDY_APP_VERSION__", with: AppSettings.version)
            content.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        content.add(WeakHandler(self), name: "vbuddy")

        let config = WKWebViewConfiguration()
        config.userContentController = content
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()
        // Keep "Mobile/…" so the web app still knows it's on an iPhone, and say it's the app.
        config.applicationNameForUserAgent = "Mobile/15E148 VBuddyApp/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1")"

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = false
        wv.isOpaque = false
        wv.backgroundColor = .vbBackground
        wv.scrollView.backgroundColor = .vbBackground
        // The web app lays itself out around the notch and home bar (env(safe-area-inset-*)).
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.bounces = false
        if #available(iOS 16.4, *) { wv.isInspectable = true }
        webView = wv

        let root = UIView()
        root.backgroundColor = .vbBackground
        wv.translatesAutoresizingMaskIntoConstraints = false
        offline.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(wv)
        root.addSubview(offline)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: root.topAnchor),
            wv.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            offline.topAnchor.constraint(equalTo: root.topAnchor),
            offline.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            offline.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            offline.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        ])
        offline.isHidden = true
        offline.onRetry = { [weak self] in self?.reconnect() }
        offline.onChangeAddress = { [weak self] in self?.onChangeAddress?() }
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        reconnect()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    private func reconnect() {
        offline.showConnecting()
        AppSettings.check(base) { [weak self] problem in
            guard let self else { return }
            if let problem {
                self.offline.showProblem(problem, address: self.base)
            } else {
                // After the first load, reloading keeps the page you were on (#comms and so on).
                if self.loadedOnce, self.webView.url?.host == self.base.host { self.webView.reload() } else { self.webView.load(URLRequest(url: self.base)) }
            }
        }
    }

    /// Back in the foreground after the PC was asleep or VBuddy was closed.
    func retryIfOffline() {
        if !offline.isHidden && !offline.isBusy { reconnect() }
    }

    // MARK: Shake for the app's own menu

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake else { return super.motionEnded(motion, with: event) }
        showAppMenu()
    }

    private func showAppMenu() {
        let sheet = UIAlertController(title: "VBuddy \(AppSettings.version)", message: "Connected to \(base.host ?? base.absoluteString)", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Reload", style: .default) { [weak self] _ in self?.reconnect() })
        sheet.addAction(UIAlertAction(title: "Change phone link", style: .default) { [weak self] _ in self?.onChangeAddress?() })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        present(sheet, from: nil)
    }

    // MARK: Navigation

    private func isBridge(_ url: URL) -> Bool {
        url.host?.lowercased() == base.host?.lowercased() && (url.port ?? defaultPort(url)) == (base.port ?? defaultPort(base))
    }

    private func defaultPort(_ url: URL) -> Int { url.scheme == "https" ? 443 : 80 }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if ["about", "blob", "data"].contains(scheme) || !mainFrame || isBridge(url) { return decisionHandler(.allow) }
        // Anything else the main page tries to open (a photo's page, GitHub, SimBrief) goes to Safari.
        if ["http", "https", "mailto", "tel"].contains(scheme) { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isBridge(url) { webView.load(URLRequest(url: url)) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadedOnce = true
        offline.hide()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    private func failed(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return } // frame load interrupted (a download or an external link)
        let why = AppSettings.linkId(of: base) != nil
            ? "Lost the connection to VBuddy. Check that this phone is online, and that VBuddy is running on your PC with Away from home (cloud relay) switched on."
            : "Lost VBuddy on \(base.host ?? "your PC"). Check that VBuddy is running and that this phone is on the same Wi-Fi."
        offline.showProblem(why, address: base)
    }

    /// iOS dropped the page to free memory (common after a while in the background): load it again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reconnect()
    }

    // MARK: alert(), confirm(), prompt()

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, from: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, from: { completionHandler(false) })
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { [weak a] _ in completionHandler(a?.textFields?.first?.text) })
        present(a, from: { completionHandler(nil) })
    }

    /// Presents over whatever is showing; if something else is already up, gives up cleanly.
    private func present(_ vc: UIViewController, from cancel: (() -> Void)?) {
        guard presentedViewController == nil, viewIfLoaded?.window != nil else { cancel?(); return }
        if let pop = vc.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        present(vc, animated: true)
    }

    // MARK: Messages from the page (vbuddy-ios.js)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "share": share(body)
        case "changeAddress": onChangeAddress?()
        case "reload": reconnect()
        case "menu": showAppMenu()
        default: break
        }
    }

    /// navigator.share() from the page: the iOS share sheet ("Save Image" puts a screenshot in Photos).
    private func share(_ body: [String: Any]) {
        let id = body["id"] as? Int ?? 0
        var items: [Any] = []
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(id)-\(UUID().uuidString.prefix(6))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for f in body["files"] as? [[String: Any]] ?? [] {
            guard let b64 = f["data"] as? String, let data = Data(base64Encoded: b64) else { continue }
            let raw = (f["name"] as? String) ?? "file"
            let name = raw.replacingOccurrences(of: "/", with: "-").isEmpty ? "file" : raw.replacingOccurrences(of: "/", with: "-")
            let url = dir.appendingPathComponent(name)
            if (try? data.write(to: url)) != nil { items.append(url) }
        }
        if let text = body["text"] as? String, !text.isEmpty { items.append(text) }
        if let s = body["url"] as? String, !s.isEmpty, let u = URL(string: s) { items.append(u) }
        guard !items.isEmpty else { return finishShare(id, ok: false, error: "Nothing to share") }

        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        sheet.completionWithItemsHandler = { [weak self] _, completed, _, error in
            try? FileManager.default.removeItem(at: dir)
            self?.finishShare(id, ok: completed, error: error?.localizedDescription ?? (completed ? nil : "Share canceled"))
        }
        present(sheet, from: { [weak self] in self?.finishShare(id, ok: false, error: "Couldn't open the share sheet") })
    }

    private func finishShare(_ id: Int, ok: Bool, error: String?) {
        let err = (error ?? "").replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        webView.evaluateJavaScript("window.__vbuddyShareDone && window.__vbuddyShareDone(\(id), \(ok), '\(err)')", completionHandler: nil)
    }
}

/// WKUserContentController keeps its handlers alive; this keeps it from keeping the screen alive too.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}

/// Shown while connecting, and when VBuddy on the PC can't be reached.
final class OfflineView: UIView {
    var onRetry: (() -> Void)?
    var onChangeAddress: (() -> Void)?
    private(set) var isBusy = false

    private let spinner = UIActivityIndicatorView(style: .large)
    private let title = UILabel()
    private let detail = UILabel()
    private let retry = UIButton(type: .system)
    private let change = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .vbBackground

        title.font = .systemFont(ofSize: 24, weight: .bold)
        title.textColor = .vbInk
        title.numberOfLines = 0
        title.textAlignment = .center
        detail.font = .preferredFont(forTextStyle: .body)
        detail.adjustsFontForContentSizeCategory = true
        detail.textColor = .vbMuted
        detail.numberOfLines = 0
        detail.textAlignment = .center

        var r = UIButton.Configuration.filled()
        r.title = "Try again"
        r.baseBackgroundColor = .vbBrand
        r.baseForegroundColor = .white
        r.cornerStyle = .large
        r.buttonSize = .large
        retry.configuration = r
        retry.addTarget(self, action: #selector(tapRetry), for: .touchUpInside)

        var c = UIButton.Configuration.plain()
        c.title = "Change phone link"
        c.baseForegroundColor = .vbInk
        c.buttonSize = .large
        change.configuration = c
        change.addTarget(self, action: #selector(tapChange), for: .touchUpInside)

        spinner.color = .vbMuted
        spinner.hidesWhenStopped = true

        let stack = UIStackView(arrangedSubviews: [spinner, title, detail, retry, change])
        stack.axis = .vertical
        stack.spacing = 14
        stack.setCustomSpacing(24, after: detail)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        let w = stack.widthAnchor.constraint(equalTo: widthAnchor, constant: -48)
        w.priority = .defaultHigh
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            w,
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func showConnecting() {
        isHidden = false
        isBusy = true
        spinner.startAnimating()
        title.text = "Connecting to VBuddy…"
        detail.text = nil
        retry.isHidden = true
        change.isHidden = true
    }

    func showProblem(_ text: String, address: URL) {
        isHidden = false
        isBusy = false
        spinner.stopAnimating()
        title.text = "Can't reach VBuddy"
        detail.text = text
        retry.isHidden = false
        change.isHidden = false
        UIAccessibility.post(notification: .screenChanged, argument: title)
    }

    func hide() {
        isBusy = false
        spinner.stopAnimating()
        isHidden = true
    }

    @objc private func tapRetry() { onRetry?() }
    @objc private func tapChange() { onChangeAddress?() }
}
