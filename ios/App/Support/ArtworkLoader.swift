import Foundation
import UIKit

/// Fetches cover art, with the token attached and a small memory cache.
///
/// The cache is what stops a car screen from re-downloading the same cover every
/// time the same album comes round in Auto Mode.
actor ArtworkLoader {
    private let token: String
    private let session: URLSession
    private var cache: [URL: UIImage] = [:]
    private var inFlight: [URL: Task<UIImage?, Never>] = [:]
    /// Small on purpose: covers are a few hundred kilobytes decoded, and this
    /// runs on a phone that is also holding an audio buffer.
    private let limit = 40

    init(token: String, session: URLSession = .shared) {
        self.token = token
        self.session = session
    }

    func image(at url: URL) async -> UIImage? {
        if let cached = cache[url] { return cached }
        if let existing = inFlight[url] { return await existing.value }

        let task = Task<UIImage?, Never> { [token, session] in
            var request = URLRequest(url: url)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            guard let (data, response) = try? await session.data(for: request),
                  let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let image = UIImage(data: data)
            else { return nil }
            return image
        }
        inFlight[url] = task
        let image = await task.value
        inFlight.removeValue(forKey: url)

        if let image {
            if cache.count >= limit { cache.removeAll() }
            cache[url] = image
        }
        return image
    }
}
