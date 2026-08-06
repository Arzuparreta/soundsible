import AVFoundation
import SoundsibleKit
import SwiftUI

/// First run: point the app at a Soundsible.
struct PairingView: View {
    @EnvironmentObject private var model: AppModel

    @State private var isScanning = false
    @State private var serverAddress = ""
    @State private var code = ""
    @State private var manualToken = ""
    @State private var showManualEntry = false
    @State private var isWorking = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        isScanning = true
                    } label: {
                        Label("Scan the pairing code", systemImage: "qrcode.viewfinder")
                    }
                } header: {
                    Text("Pair")
                } footer: {
                    Text(
                        """
                        On your Soundsible, open Settings and show the pairing QR \
                        code. Keep that sheet open while you scan — it is what \
                        lets this phone finish pairing on its own.
                        """
                    )
                }

                Section("Or type it") {
                    TextField("http://192.168.1.40:5005", text: $serverAddress)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Pairing code", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Button("Pair") {
                        Task { await pair() }
                    }
                    .disabled(!canPair || isWorking)
                }

                Section {
                    DisclosureGroup("I already have a device token", isExpanded: $showManualEntry) {
                        SecureField("Paired-device token", text: $manualToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Connect") {
                            Task { await connectManually() }
                        }
                        .disabled(serverAddress.isEmpty || manualToken.isEmpty || isWorking)
                    }
                } footer: {
                    Text(
                        """
                        Use this when your Soundsible cannot show the pairing \
                        sheet — a headless server, for instance.
                        """
                    )
                }

                if let error = model.lastError {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.callout)
                    }
                }
            }
            .navigationTitle("Soundsible")
            .disabled(isWorking)
            .overlay {
                if isWorking { ProgressView().controlSize(.large) }
            }
            .sheet(isPresented: $isScanning) {
                QRScannerView { scanned in
                    isScanning = false
                    guard let payload = PairingPayload.parse(scanned) else {
                        model.lastError = "That code is not a Soundsible pairing code."
                        return
                    }
                    code = payload.code
                    if let base = payload.baseURL {
                        serverAddress = base.absoluteString
                    }
                    Task { await pair() }
                }
            }
        }
    }

    private var canPair: Bool {
        normalizedURL != nil && !code.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Accept what somebody would actually type.
    ///
    /// `192.168.1.40:5005` with no scheme is the normal shape of a self-hosted
    /// address, and rejecting it as "invalid URL" would be pedantry.
    private var normalizedURL: URL? {
        var text = serverAddress.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://\(text)" }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host != nil else { return nil }
        return url
    }

    private func pair() async {
        guard let url = normalizedURL else { return }
        isWorking = true
        defer { isWorking = false }
        _ = await model.pair(baseURL: url, code: code)
    }

    private func connectManually() async {
        guard let url = normalizedURL else { return }
        isWorking = true
        defer { isWorking = false }
        _ = await model.pairManually(baseURL: url, token: manualToken)
    }
}

/// Camera view that reports the first QR payload it sees.
struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onScan = onScan
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onScan: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var hasReported = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black

            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input)
            else { return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer

            // Starting a capture session blocks; doing it on the main thread is
            // a watchdog kill waiting to happen.
            Task.detached { [session] in
                session.startRunning()
            }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            let session = self.session
            Task.detached { session.stopRunning() }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !hasReported,
                  let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let value = object.stringValue
            else { return }
            hasReported = true
            onScan?(value)
        }
    }
}
