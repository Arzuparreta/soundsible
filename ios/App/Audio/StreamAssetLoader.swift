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
/// `206` with `Content-Range` and this forwards that faithfully.
nonisolated final class StreamAssetLoader: NSObject {
    /// Scheme swapped in so `AVPlayer` hands the request to us instead of
    /// fetching it itself.
    static let scheme = "soundsible-stream"

    private let token: String
    private let session: URLSession
    private let log = Logger(subsystem: "com.soundsible.player", category: "stream-loader")
    private var tasks: [ObjectIdentifier: URLSessionDataTask] = [:]
    private let lock = NSLock()

    init(token: String, session: URLSession = .shared) {
        self.token = token
        self.session = session
        super.init()
    }

    /// Build an `AVURLAsset` that will route its loading through this object.
    static func asset(for url: URL, loader: StreamAssetLoader, queue: DispatchQueue) -> AVURLAsset? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        // The original scheme is kept so it can be restored when we fetch, which
        // is what lets one loader serve both a LAN http:// engine and an https://
        // one behind a Tailscale funnel.
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
}

extension StreamAssetLoader: AVAssetResourceLoaderDelegate {
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
            // `requestsAllDataToEndOfResource` means "from here to the end", and
            // an open-ended range is the honest way to say that.
            if dataRequest.requestsAllDataToEndOfResource {
                request.setValue("bytes=\(start)-", forHTTPHeaderField: "Range")
            } else {
                let end = start + Int64(dataRequest.requestedLength) - 1
                request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
            }
        }

        let task = session.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            self.finish(loadingRequest, data: data, response: response, error: error)
        }

        lock.lock()
        tasks[ObjectIdentifier(loadingRequest)] = task
        lock.unlock()
        task.resume()
        return true
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        lock.lock()
        let task = tasks.removeValue(forKey: ObjectIdentifier(loadingRequest))
        lock.unlock()
        task?.cancel()
    }

    private func finish(
        _ loadingRequest: AVAssetResourceLoadingRequest,
        data: Data?,
        response: URLResponse?,
        error: Error?
    ) {
        lock.lock()
        tasks.removeValue(forKey: ObjectIdentifier(loadingRequest))
        lock.unlock()

        guard !loadingRequest.isCancelled else { return }

        if let error {
            log.error("Stream request failed: \(error.localizedDescription)")
            loadingRequest.finishLoading(with: error)
            return
        }
        guard let http = response as? HTTPURLResponse else {
            loadingRequest.finishLoading(with: URLError(.badServerResponse))
            return
        }
        guard (200..<300).contains(http.statusCode) else {
            log.error("Stream request returned \(http.statusCode)")
            loadingRequest.finishLoading(
                with: NSError(
                    domain: NSURLErrorDomain,
                    code: http.statusCode == 401 || http.statusCode == 403
                        ? URLError.userAuthenticationRequired.rawValue
                        : URLError.badServerResponse.rawValue
                )
            )
            return
        }

        if let info = loadingRequest.contentInformationRequest {
            info.contentType = Self.uniformTypeIdentifier(for: http)
            info.isByteRangeAccessSupported =
                (http.value(forHTTPHeaderField: "Accept-Ranges") ?? "").contains("bytes")
                || http.statusCode == 206
            info.contentLength = Self.totalLength(from: http)
        }

        if let data {
            loadingRequest.dataRequest?.respond(with: data)
        }
        loadingRequest.finishLoading()
    }

    /// Total size of the resource, not of this range.
    ///
    /// A `206` answers with `Content-Length` for the slice it sent; the whole
    /// length is the last field of `Content-Range`, and giving `AVPlayer` the
    /// slice length instead is what makes a long track look a few seconds long.
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

        // The engine serves exactly these (see the mimetypes map in
        // shared/api/routes/playback.py), and AVFoundation plays all of them.
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
