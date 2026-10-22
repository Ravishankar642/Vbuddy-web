import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private let root = RootViewController()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AppSettings.registerDefaults()
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.backgroundColor = .vbBackground
        w.rootViewController = root
        w.makeKeyAndVisible()
        window = w
        root.start()
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        AppSettings.applyKeepScreenOn()
        root.becameActive()
    }

    func applicationWillResignActive(_ application: UIApplication) {
        UIApplication.shared.isIdleTimerDisabled = false
    }
}
