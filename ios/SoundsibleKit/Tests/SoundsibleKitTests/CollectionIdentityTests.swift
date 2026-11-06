import Foundation
import XCTest
@testable import SoundsibleKit

final class CollectionIdentityTests: XCTestCase {
    func testBrowseIdentityIsSeparateFromTheSelectedAudio() throws {
        let data = Data(#"{"id":"musical-item","item_id":"musical-item","track_id":"7N3rFdE3u3Y","source":"preview","stream_url":"/api/preview/stream/7N3rFdE3u3Y","is_playable":true}"#.utf8)
        let item = try JSONDecoder().decode(CarItem.self, from: data)
        XCTAssertEqual(item.id, "musical-item")
        XCTAssertEqual(item.itemID, "musical-item")
        XCTAssertEqual(item.trackID, "7N3rFdE3u3Y")
        XCTAssertEqual(try JSONDecoder().decode(CarItem.self, from: JSONEncoder().encode(item)), item)
    }

    func testAnOfflineSourceStaysPinnedWhenTheServerSelectsAnotherSource() {
        var library = OfflineLibrary()
        library.store(trackID: "copied-source", itemID: "musical-item", filename: "copied.m4a", byteSize: 100, collectionID: "playlist:Mix")
        let changed = CarItem(id: "musical-item", kind: "track", trackID: "replacement-source", itemID: "musical-item", title: "Autorretrato", isPlayable: true)
        XCTAssertTrue(library.pin(collectionID: "playlist:Other", items: [changed]).isEmpty)
        XCTAssertEqual(library.heldTrackID(for: changed), "copied-source")
        XCTAssertEqual(library.filename(for: "copied-source"), "copied.m4a")
        XCTAssertEqual(library.usedBytes, 100)
    }
}
