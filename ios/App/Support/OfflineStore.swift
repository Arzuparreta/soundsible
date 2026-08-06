import Foundation
import os
import SoundsibleKit

/// Holds downloaded audio on the phone and the bookkeeping that goes with it.
///
/// `OfflineLibrary` in the kit decides *what* should be here and what has to go;
/// this type is the part that touches the disk, which is why the policy is
/// tested on Linux and this is kept as thin as it can be.
@MainActor
@Observable
final class OfflineStore {
    private(set) var library: OfflineLibrary
    private(set) var inFlight: Set<String> = []

    private let directory: URL
    private let indexURL: URL
    private let session: URLSession
    private let log = Logger(subsystem: "com.soundsible.player", category: "offline")

    init(session: URLSession = .shared) {
        self.session = session
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = base.appendingPathComponent("Offline", isDirectory: true)
        indexURL = base.appendingPathComponent("offline-index.json")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        if let data = try? Data(contentsOf: indexURL),
           let decoded = try? JSONDecoder().decode([OfflineTrack].self, from: data) {
            library = OfflineLibrary(tracks: decoded, byteBudget: Self.storedBudget)
        } else {
            library = OfflineLibrary(byteBudget: Self.storedBudget)
        }
        // The application support directory is backed up by default, and a music
        // cache in an iCloud backup is both slow and pointless.
        excludeFromBackup()
    }

    // MARK: - Reading

    func localURL(for trackID: String) -> URL? {
        guard let filename = library.filename(for: trackID) else { return nil }
        let url = directory.appendingPathComponent(filename)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func isAvailableOffline(_ trackID: String) -> Bool {
        localURL(for: trackID) != nil
    }

    var usedBytes: Int64 { library.usedBytes }

    var byteBudget: Int64? {
        get { library.byteBudget }
        set {
            library.byteBudget = newValue
            UserDefaults.standard.set(newValue ?? 0, forKey: Self.budgetKey)
            applyBudget()
        }
    }

    // MARK: - Downloading

    /// Make a collection available offline, fetching only what is missing.
    func pin(collectionID: String, items: [CarItem], connection: ServerConnection) async {
        let missing = library.pin(collectionID: collectionID, items: items)
        persist()

        for item in missing {
            guard let trackID = item.trackID ?? (item.kind == "track" ? item.id : nil),
                  let path = item.streamURL,
                  let url = connection.resolve(path)
            else { continue }
            await download(
                trackID: trackID,
                from: url,
                token: connection.token,
                collectionID: collectionID
            )
        }
        applyBudget()
    }

    func unpin(collectionID: String) {
        let orphaned = library.unpin(collectionID: collectionID)
        for track in orphaned {
            try? FileManager.default.removeItem(
                at: directory.appendingPathComponent(track.filename)
            )
        }
        persist()
    }

    func markPlayed(_ trackID: String) {
        library.markPlayed(trackID)
        persist()
    }

    private func download(
        trackID: String,
        from url: URL,
        token: String,
        collectionID: String
    ) async {
        guard !inFlight.contains(trackID) else { return }
        inFlight.insert(trackID)
        defer { inFlight.remove(trackID) }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (temporary, response) = try await session.download(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode)
            else {
                log.error("Download of \(trackID) returned a failure status")
                try? FileManager.default.removeItem(at: temporary)
                return
            }
            // The extension has to survive: AVFoundation picks a parser from it
            // when the file is played back from disk.
            let ext = Self.fileExtension(for: http, fallback: url.pathExtension)
            let filename = "\(trackID).\(ext)"
            let destination = directory.appendingPathComponent(filename)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: temporary, to: destination)

            let attributes = try? FileManager.default.attributesOfItem(atPath: destination.path)
            let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
            library.store(
                trackID: trackID,
                filename: filename,
                byteSize: size,
                collectionID: collectionID
            )
            persist()
        } catch {
            log.error("Download of \(trackID) failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Housekeeping

    private func applyBudget() {
        let evicted = library.evictToFitBudget()
        for track in evicted {
            try? FileManager.default.removeItem(
                at: directory.appendingPathComponent(track.filename)
            )
        }
        if !evicted.isEmpty { persist() }
    }

    func removeEverything() {
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        library = OfflineLibrary(byteBudget: library.byteBudget)
        persist()
    }

    private func persist() {
        let tracks = Array(library.tracks.values)
        guard let data = try? JSONEncoder().encode(tracks) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }

    private func excludeFromBackup() {
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    private static let budgetKey = "com.soundsible.player.offline-budget"

    private static var storedBudget: Int64? {
        let stored = UserDefaults.standard.object(forKey: budgetKey) as? Int64 ?? 0
        return stored > 0 ? stored : nil
    }

    static func fileExtension(for response: HTTPURLResponse, fallback: String) -> String {
        let mime = (response.value(forHTTPHeaderField: "Content-Type") ?? "")
            .split(separator: ";")
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? ""
        switch mime {
        case "audio/mpeg": return "mp3"
        case "audio/mp4", "audio/x-m4a": return "m4a"
        case "audio/flac", "audio/x-flac": return "flac"
        case "audio/wav", "audio/x-wav": return "wav"
        case "audio/ogg": return "ogg"
        default: return fallback.isEmpty ? "mp3" : fallback
        }
    }
}
