import UIKit

/// First launch (or "Change address"): where is VBuddy running?
final class SetupViewController: UIViewController, UITextFieldDelegate {
    private let prefill: URL?
    private let initialMessage: String?
    private let onConnect: (URL) -> Void

    private let scroll = UIScrollView()
    private let field = UITextField()
    private let button = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let status = UILabel()

    init(prefill: URL?, message: String?, onConnect: @escaping (URL) -> Void) {
        self.prefill = prefill
        self.initialMessage = message
        self.onConnect = onConnect
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .default }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .vbBackground

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)

        let mark = UIImageView(image: UIImage(named: "Mark"))
        mark.contentMode = .scaleAspectFit
        mark.layer.cornerRadius = 18
        mark.layer.cornerCurve = .continuous
        mark.clipsToBounds = true
        mark.translatesAutoresizingMaskIntoConstraints = false
        let markRow = UIView()
        markRow.addSubview(mark)
        NSLayoutConstraint.activate([
            mark.widthAnchor.constraint(equalToConstant: 72),
            mark.heightAnchor.constraint(equalToConstant: 72),
            mark.leadingAnchor.constraint(equalTo: markRow.leadingAnchor),
            mark.topAnchor.constraint(equalTo: markRow.topAnchor),
            mark.bottomAnchor.constraint(equalTo: markRow.bottomAnchor),
        ])
        mark.isAccessibilityElement = false

        let title = label("Connect to VBuddy", font: .systemFont(ofSize: 30, weight: .bold), color: .vbInk)
        let lead = label("Type the address shown in the VBuddy window on your PC, under Connect. Your iPhone needs to be on the same Wi-Fi as the PC.", font: .preferredFont(forTextStyle: .body), color: .vbMuted)

        let fieldLabel = label("VBuddy address", font: .systemFont(ofSize: 15, weight: .semibold), color: .vbInk)
        field.placeholder = "192.168.1.23"
        field.text = prefill.map { Self.display($0) }
        field.keyboardType = .URL
        field.textContentType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.returnKeyType = .go
        field.clearButtonMode = .whileEditing
        field.delegate = self
        field.font = .monospacedSystemFont(ofSize: 18, weight: .regular)
        field.textColor = .vbInk
        field.backgroundColor = .vbWell
        field.layer.cornerRadius = 12
        field.layer.borderWidth = 1
        field.layer.borderColor = UIColor.vbMuted.withAlphaComponent(0.35).cgColor
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        field.leftViewMode = .always
        field.heightAnchor.constraint(equalToConstant: 52).isActive = true
        field.accessibilityLabel = "VBuddy address"

        var config = UIButton.Configuration.filled()
        config.title = "Connect"
        config.baseBackgroundColor = .vbBrand
        config.baseForegroundColor = .white
        config.cornerStyle = .large
        config.buttonSize = .large
        button.configuration = config
        button.addTarget(self, action: #selector(connect), for: .touchUpInside)
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true

        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .callout)
        status.adjustsFontForContentSizeCategory = true
        status.textColor = .vbDanger
        status.text = initialMessage
        status.accessibilityTraits = .updatesFrequently

        spinner.hidesWhenStopped = true
        spinner.color = .vbMuted

        let hint = label("The address looks like 192.168.1.23 (VBuddy adds :4799 for you). If iPhone asks to find devices on your local network, tap Allow.", font: .preferredFont(forTextStyle: .footnote), color: .vbMuted)

        let stack = UIStackView(arrangedSubviews: [markRow, title, lead, fieldLabel, field, button, spinner, status, hint])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 12
        stack.setCustomSpacing(20, after: markRow)
        stack.setCustomSpacing(8, after: title)
        stack.setCustomSpacing(28, after: lead)
        stack.setCustomSpacing(6, after: fieldLabel)
        stack.setCustomSpacing(16, after: field)
        stack.setCustomSpacing(24, after: status)
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)

        let g = scroll.contentLayoutGuide
        let w = stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40)
        w.priority = .defaultHigh
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: g.topAnchor, constant: 72),
            stack.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -40),
            stack.centerXAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerXAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
            w,
        ])

        NotificationCenter.default.addObserver(self, selector: #selector(keyboard(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if (field.text ?? "").isEmpty { field.becomeFirstResponder() }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        connect()
        return false
    }

    @objc private func keyboard(_ n: Notification) {
        guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let overlap = max(0, view.bounds.maxY - view.convert(end, from: nil).minY)
        scroll.contentInset.bottom = overlap
        scroll.verticalScrollIndicatorInsets.bottom = overlap
    }

    @objc private func connect() {
        guard let url = AppSettings.normalize(field.text ?? "") else {
            status.text = "Type the address from the VBuddy window on your PC, for example 192.168.1.23."
            return
        }
        field.resignFirstResponder()
        status.text = nil
        button.isEnabled = false
        spinner.startAnimating()
        AppSettings.check(url) { [weak self] problem in
            guard let self else { return }
            self.spinner.stopAnimating()
            self.button.isEnabled = true
            if let problem {
                self.status.text = problem
                UIAccessibility.post(notification: .announcement, argument: problem)
            } else {
                self.onConnect(url)
            }
        }
    }

    private func label(_ text: String, font: UIFont, color: UIColor) -> UILabel {
        let l = UILabel()
        l.text = text
        l.font = font
        l.textColor = color
        l.numberOfLines = 0
        l.adjustsFontForContentSizeCategory = true
        return l
    }

    /// http://192.168.1.23:4799/ → 192.168.1.23 (what people type).
    private static func display(_ url: URL) -> String {
        guard let host = url.host else { return url.absoluteString }
        if url.scheme == "http" && (url.port == nil || url.port == AppSettings.defaultPort) { return host }
        var s = "\(url.scheme ?? "http")://\(host)"
        if let p = url.port { s += ":\(p)" }
        return s
    }
}
