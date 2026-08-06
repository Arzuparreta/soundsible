import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The one seam between the client and the network.
///
/// Every test in this package drives a stub transport instead of a server, which
/// is what keeps the suite runnable on a Linux box with no Soundsible around.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        // Deliberately the completion-handler API wrapped by hand rather than
        // `session.data(for:)`. The async overloads are still uneven across
        // swift-corelibs-foundation releases, and this package has to compile
        // and run on Linux, which is where it is developed.
        try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: SoundsibleError.transport(error.localizedDescription))
                    return
                }
                guard let http = response as? HTTPURLResponse else {
                    continuation.resume(throwing: SoundsibleError.transport("Response was not HTTP"))
                    return
                }
                continuation.resume(returning: (data ?? Data(), http))
            }
            task.resume()
        }
    }
}

public enum SoundsibleError: Error, Equatable, LocalizedError {
    /// The server answered, and said no.
    case http(status: Int, message: String)
    /// The server never answered, or answered something that was not HTTP.
    case transport(String)
    /// The body arrived but did not match the contract.
    case decoding(String)
    /// No server has been paired yet.
    case notConfigured
    /// The credential was rejected or has been revoked.
    case unauthorized

    public var errorDescription: String? {
        switch self {
        case let .http(status, message):
            return message.isEmpty ? "The server returned \(status)." : message
        case let .transport(detail):
            return "Could not reach your Soundsible: \(detail)"
        case let .decoding(detail):
            return "Unexpected answer from your Soundsible: \(detail)"
        case .notConfigured:
            return "No Soundsible paired yet."
        case .unauthorized:
            return "This device is no longer paired with your Soundsible."
        }
    }
}

/// Body the engine sends with a failure, so the message shown is the server's own.
struct ErrorBody: Decodable {
    let error: String?
    let code: String?
}
