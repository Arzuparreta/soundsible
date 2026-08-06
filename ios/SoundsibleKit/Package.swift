// swift-tools-version:5.9
import PackageDescription

// SoundsibleKit is deliberately dependency-free and free of any Apple-only
// framework. That is what lets `swift test` run on Linux, where the whole
// package is developed and verified before a macOS runner ever sees it.
let package = Package(
    name: "SoundsibleKit",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "SoundsibleKit", targets: ["SoundsibleKit"]),
    ],
    targets: [
        .target(name: "SoundsibleKit"),
        .testTarget(name: "SoundsibleKitTests", dependencies: ["SoundsibleKit"]),
    ]
)
