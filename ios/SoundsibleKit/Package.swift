// swift-tools-version: 6.2
import PackageDescription

// SoundsibleKit is deliberately dependency-free and free of any Apple-only
// framework. That is what lets `swift test` run on Linux, where the whole
// package is developed and verified before a macOS runner ever sees it.
//
// The app target defaults to `MainActor` isolation (Xcode 26's default for new
// projects). This package deliberately does not: it is the part that talks to
// the network and does work off the main thread, so leaving it `nonisolated`
// keeps that boundary explicit rather than making every call an actor hop.
let package = Package(
    name: "SoundsibleKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "SoundsibleKit", targets: ["SoundsibleKit"]),
    ],
    targets: [
        .target(
            name: "SoundsibleKit",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "SoundsibleKitTests",
            dependencies: ["SoundsibleKit"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
