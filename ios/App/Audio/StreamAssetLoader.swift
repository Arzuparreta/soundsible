import AVFoundation
import Foundation
import os

/// Plays engine URLs that need an `Authorization` header.
///
/// `AVPlayer` has no public way to add a header to the requests it makes, and
/// the private `AVURLAssetHTTPHeaderFieldsKey` is exactly the kind of thing that
/// breaks on an iOS update. The supported answer is a custom URL scheme handled
/// by a resource loader: `AVPlayer` asks us for bytes, and we fetch them with
/// `URLSession`, where headers are ordinary.
///
/// Ranges matter here — seeking in a 60 MB FLAC works because the engine answers
/// `206` with `Content-Range` and this forwards both headers and body faithfully.
/// Body data is forwarded as URLSession receives it; an open-ended range never
/// has to finish downloading before AVPlayer may start decoding.
nonisolated final class StreamAssetLoader: NSObject, @unchecked Sendable {
    static let scheme = "soundsible-stream"

    private final class Transfer: @unchecked Sendable {
        let loadingRequest: AVAssetResourceLoadingRequest

        init(_ loadingRequest: AVAssetResourceLoadingRequest) {
            self.loadingRequest = loadingRequest
        }
    }

    private let token: String
    private let configuration: URLSessionConfiguration
    private lazy var session = URLSession(
        configuration: configuration,
        delegate: self,
        delegateQueue: nil
    )
    private let log = Logger(subsystem: "com.soundsible.player", category: "stream-loader")
    private var tasksByRequest: [ObjectIdentifier: URLSessionDataTask] = [:]
    private var transfersByTask: [Int: Transfer] = [:]
    private let lock = NSLock()

    init(token: String, configuration: URLSessionConfiguration = .default) {
        self.token = token
        self.configuration = configuration
        super.init()
    }

    static func asset(for url: URL, loader: StreamAssetLoader, queue: DispatchQueue) -> AVURLAsset? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        // The original scheme is kept so it can be restored when we fetch. One
        // loader therefore serves LAN HTTP and ordinary HTTPS without knowing
        // what proxy, VPN or tunnel carries either connection.
        components.scheme = "\(scheme)+\(url.scheme ?? "http")"
        guard let tagged = components.url else { return nil }

        let asset = AVURLAsset(url: tagged)
        asset.resourceLoader.setDelegate(loader, queue: queue)
        return asset
    }

    private func originalURL(from url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme,
              scheme.hasPrefix("\(Self.scheme)+")
        else { return nil }
        components.scheme = String(scheme.dropFirst(Self.scheme.count + 1))
        return components.url
    }

    private func transfer(for task: URLSessionTask) -> Transfer? {
        lock.lock()
        let transfer = transfersByTask[task.taskIdentifier]
        lock.unlock()
        return transfer
    }

    private func removeTransfer(for task: URLSessionTask) -> Transfer? {
        lock.lock()
        let transfer = transfersByTask.removeValue(forKey: task.taskIdentifier)
        if let transfer {
            tasksByRequest.removeValue(forKey: ObjectIdentifier(transfer.loadingRequest))
        }
        lock.unlock()
        return transfer
    }
}

// AVFoundation and URLSession call these on their delegate queues, never on the
// main actor.
nonisolated extension StreamAssetLoader: AVAssetResourceLoaderDelegate {
    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        guard let requestURL = loadingRequest.request.url,
              let target = originalURL(from: requestURL)
        else { return false }

        var request = URLRequest(url: target)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        if let dataRequest = loadingRequest.dataRequest {
            let start = dataRequest.requestedOffset
            if dataRequest.requestsAllDataToEndOfResource {
                request.setValue("bytes=\(start)-", forHTTPHeaderField: "Range")
            } else {
                let end = start + Int64(dataRequest.requestedLength) - 1
                request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
            }
        }

        let task = session.dataTask(with: request)
        lock.lock()
        tasksByRequest[ObjectIdentifier(loadingRequest)] = task
        transfersByTask[task.taskIdentifier] = Transfer(loadingRequest)
        lock.unlock()
        task.resume()
        return true
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        lock.lock()
        let task = tasksByRequest.removeValue(forKey: ObjectIdentifier(loadingRequest))
        if let task { transfersByTask.removeValue(forKey: task.taskIdentifier) }
        lock.unlock()
        task?.cancel()
    }
}

/// A completion-handler data task buffers the entire response in `Data`.
/// Delegate delivery is the real streaming boundary: each received chunk is
/// handed to AVPlayer while the standard HTTP range remains open.
nonisolated extension StreamAssetLoader: URLSessionDataDelegate {
    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let transfer = transfer(for: dataTask),
              !transfer.loadingRequest.isCancelled
        else {
            completionHandler(.cancel)
            return
        }
        guard let http = response as? HTTPURLResponse else {
            _ = removeTransfer(for: dataTask)
            transfer.loadingRequest.finishLoading(with: URLError(.badServerResponse))
            completionHandler(.cancel)
            return
        }
        guard (200..<300).contains(http.statusCode) else {
            log.error("Stream request returned \(http.statusCode)")
            _ = removeTransfer(for: dataTask)
            transfer.loadingRequest.finishLoading(
                with: NSError(
                    domain: NSURLErrorDomain,
                    code: http.statusCode == 401 || http.statusCode == 403
                        ? URLError.userAuthenticationRequired.rawValue
                        : URLError.badServerResponse.rawValue
                )
            )
            completionHandler(.cancel)
            return
        }

        if let info = transfer.loadingRequest.contentInformationRequest {
            info.contentType = Self.uniformTypeIdentifier(for: http)
            info.isByteRangeAccessSupported =
                (http.value(forHTTPHeaderField: "Accept-Ranges") ?? "").contains("bytes")
                || http.statusCode == 206
            info.contentLength = Self.totalLength(from: http)
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let transfer = transfer(for: dataTask),
              !transfer.loadingRequest.isCancelled
        else { return }
        transfer.loadingRequest.dataRequest?.respond(with: data)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard let transfer = removeTransfer(for: task),
              !transfer.loadingRequest.isCancelled
        else { return }
        if let error {
            log.error("Stream request failed: \(error.localizedDescription)")
            transfer.loadingRequest.finishLoading(with: error)
        } else {
            transfer.loadingRequest.finishLoading()
        }
    }

    static func totalLength(from response: HTTPURLResponse) -> Int64 {
        if let range = response.value(forHTTPHeaderField: "Content-Range"),
           let total = range.split(separator: "/").last,
           let value = Int64(total.trimmingCharacters(in: .whitespaces)) {
            return value
        }
        return response.expectedContentLength
    }

    static func uniformTypeIdentifier(for response: HTTPURLResponse) -> String {
        let mime = (response.value(forHTTPHeaderField: "Content-Type") ?? "")
            .split(separator: ";")
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? ""

        switch mime {
        case "audio/mpeg": return "public.mp3"
        case "audio/mp4", "audio/x-m4a": return "public.mpeg-4-audio"
        case "audio/flac", "audio/x-flac": return "org.xiph.flac"
        case "audio/wav", "audio/x-wav": return "com.microsoft.waveform-audio"
        case "audio/ogg": return "org.xiph.ogg-audio"
        default: return "public.audio"
        }
    }
}
