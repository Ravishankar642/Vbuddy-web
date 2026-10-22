import UIKit

/// Shows the address screen until the app knows where VBuddy is, then VBuddy itself.
final class RootViewController: UIViewController {
    private var current: UIViewController?

    override var childForStatusBarStyle: UIViewController? { current }
    override var childForHomeIndicatorAutoHidden: UIViewController? { current }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .vbBackground
    }

    func start() {
        if AppSettings.takeResetRequest() { AppSettings.address = nil }
        if let url = AppSettings.address { showWeb(url) } else { showSetup(prefill: nil, message: nil) }
    }

    /// Back from the background: "Change address" may have been switched on in iOS Settings meanwhile.
    func becameActive() {
        if AppSettings.takeResetRequest() {
            let old = AppSettings.address
            AppSettings.address = nil
            showSetup(prefill: old, message: nil)
        } else {
            (current as? WebViewController)?.retryIfOffline()
        }
    }

    func showSetup(prefill: URL?, message: String?) {
        let vc = SetupViewController(prefill: prefill, message: message) { [weak self] url in
            AppSettings.address = url
            self?.showWeb(url)
        }
        swap(to: vc)
    }

    func showWeb(_ url: URL) {
        let vc = WebViewController(base: url)
        vc.onChangeAddress = { [weak self] in
            self?.showSetup(prefill: AppSettings.address, message: nil)
        }
        swap(to: vc)
    }

    private func swap(to vc: UIViewController) {
        if let old = current {
            old.willMove(toParent: nil)
            old.view.removeFromSuperview()
            old.removeFromParent()
        }
        addChild(vc)
        vc.view.frame = view.bounds
        vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(vc.view)
        vc.didMove(toParent: self)
        current = vc
        setNeedsStatusBarAppearanceUpdate()
    }
}
