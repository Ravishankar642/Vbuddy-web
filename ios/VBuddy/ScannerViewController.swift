import AVFoundation
import UIKit

/// Scans the phone link QR code shown in the VBuddy window on the PC.
final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let onFound: (String) -> Void
    private var preview: AVCaptureVideoPreviewLayer?
    private var found = false
    private let frameBox = UIView()

    init(onFound: @escaping (String) -> Void) {
        self.onFound = onFound
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let ready = setUpCamera()

        frameBox.layer.borderColor = UIColor.white.withAlphaComponent(0.9).cgColor
        frameBox.layer.borderWidth = 3
        frameBox.layer.cornerRadius = 24
        frameBox.layer.cornerCurve = .continuous
        frameBox.isUserInteractionEnabled = false
        frameBox.translatesAutoresizingMaskIntoConstraints = false
        frameBox.isHidden = !ready
        view.addSubview(frameBox)

        let hint = UILabel()
        hint.text = ready ? "Point the camera at the QR code in the VBuddy window on your PC (Connect → Away from home → QR code)." : "This device has no camera VBuddy can use. Type the phone link ID instead."
        hint.textColor = .white
        hint.font = .preferredFont(forTextStyle: .body)
        hint.adjustsFontForContentSizeCategory = true
        hint.numberOfLines = 0
        hint.textAlignment = .center
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)

        var c = UIButton.Configuration.filled()
        c.title = "Cancel"
        c.baseBackgroundColor = UIColor.white.withAlphaComponent(0.18)
        c.baseForegroundColor = .white
        c.cornerStyle = .capsule
        c.buttonSize = .large
        let close = UIButton(configuration: c)
        close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            frameBox.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            frameBox.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -30),
            frameBox.widthAnchor.constraint(equalTo: frameBox.heightAnchor),
            frameBox.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.68),
            hint.topAnchor.constraint(equalTo: frameBox.bottomAnchor, constant: 24),
            hint.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 28),
            hint.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -28),
            close.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            close.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -24),
        ])
    }

    private func setUpCamera() -> Bool {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return false }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return false }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        return true
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let s = session
        DispatchQueue.global(qos: .userInitiated).async { if !s.isRunning { s.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let s = session
        DispatchQueue.global(qos: .userInitiated).async { if s.isRunning { s.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !found, let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject, let text = code.stringValue else { return }
        // Only a VBuddy phone link (or a bare ID) counts; anything else keeps scanning.
        guard AppSettings.normalize(text).flatMap(AppSettings.linkId(of:)) != nil else { return }
        found = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        dismiss(animated: true) { [onFound] in onFound(text) }
    }

    @objc private func cancel() {
        dismiss(animated: true)
    }
}
