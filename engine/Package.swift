// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "TintaEngine",
    platforms: [.macOS("14.2")],
    products: [
        .executable(name: "tinta-engine", targets: ["TintaEngine"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "eabcd9e36dab48f1f7180165396d84b9688650e0"
        )
    ],
    targets: [
        .executableTarget(
            name: "TintaEngine",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/TintaEngine",
            // The Apple on-device model exists only on macOS 26 and later. Older systems run without summaries.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "FoundationModels"])]
        )
    ]
)
