import Foundation
import UIKit

/// Fetches cover art, with the token attached and a small memory cache.
///
/// The cache is what stops a car screen from re-downloading the same cover every
/// time the same album comes round in Auto Mode.
actor ArtworkLoader {
    private let token: String
    private let session: URLSession
    private let cache = NSCache<NSURL, UIImage>()
    private var inFlight: [URL: Task<UIImage?, Never>] = [:]
    /// Small on purpose: covers are a few hundred kilobytes decoded, and this
    /// runs on a phone that is also holding an audio buffer.
    private func dataCost(_ image: UIImage) -> Int { Int(image.size.width * image.scale * image.size.height * image.scale * 4) }

    init(token: String, session: URLSession = .shared) {
        self.token = token
        self.session = session
        cache.countLimit = 40
        cache.totalCostLimit = 20 * 1024 * 1024
    }

    func image(at url: URL) async -> UIImage? {
        if let cached = cache.object(forKey: url as NSURL) { return cached }
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
            let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? dataCost(image)
            cache.setObject(image, forKey: url as NSURL, cost: cost)
        }
        return image
    }
}
