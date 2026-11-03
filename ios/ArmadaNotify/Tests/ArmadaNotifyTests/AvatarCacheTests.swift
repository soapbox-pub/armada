import XCTest

@testable import ArmadaNotify

/// The avatar cache, which is the only thing in this pipeline that exists to
/// make a NETWORK request rarer. Its job is to be boring; these pin the parts
/// that would be quietly wrong.
final class AvatarCacheTests: XCTestCase {

    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("avatar-cache-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private let url = "https://example.com/alex.png"

    func testRoundTripsBytes() {
        let bytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        AvatarCache.store(url: url, data: bytes, in: dir)
        XCTAssertEqual(AvatarCache.cached(url: url, in: dir), bytes)
    }

    func testMissesForAnUncachedUrl() {
        XCTAssertNil(AvatarCache.cached(url: url, in: dir))
    }

    func testDifferentUrlsDoNotShareAnEntry() {
        AvatarCache.store(url: url, data: Data([1]), in: dir)
        AvatarCache.store(url: "https://example.com/bob.png", data: Data([2]), in: dir)
        XCTAssertEqual(AvatarCache.cached(url: url, in: dir), Data([1]))
        XCTAssertEqual(
            AvatarCache.cached(url: "https://example.com/bob.png", in: dir), Data([2])
        )
    }

    /// A changed picture URL is a different key, so nothing has to invalidate
    /// anything — the new one simply misses once.
    func testANewPictureUrlIsANewEntry() {
        AvatarCache.store(url: url, data: Data([1]), in: dir)
        XCTAssertNil(AvatarCache.cached(url: url + "?v=2", in: dir))
    }

    /// The filename is a hash, never the URL: a remote string reaching the
    /// filesystem verbatim could contain a separator or a `..`.
    func testFileNameIsAHashAndNotThePath() {
        let name = AvatarCache.fileName(for: "https://example.com/../../etc/passwd")
        XCTAssertEqual(name.count, 64)
        XCTAssertFalse(name.contains("/"))
        XCTAssertFalse(name.contains("."))
        XCTAssertNil(name.range(of: "[^0-9a-f]", options: .regularExpression))
    }

    func testRefusesAnOversizedImage() {
        let huge = Data(repeating: 0xAB, count: AvatarCache.maxBytes + 1)
        AvatarCache.store(url: url, data: huge, in: dir)
        XCTAssertNil(AvatarCache.cached(url: url, in: dir), "an oversized avatar is not cached")
    }

    func testRefusesEmptyData() {
        AvatarCache.store(url: url, data: Data(), in: dir)
        XCTAssertNil(AvatarCache.cached(url: url, in: dir))
    }

    func testBytesSumsTheCachedFiles() {
        XCTAssertEqual(AvatarCache.bytes(in: dir), 0)
        AvatarCache.store(url: url, data: Data([1, 2, 3]), in: dir)
        AvatarCache.store(url: "https://example.com/bob.png", data: Data([4, 5]), in: dir)
        XCTAssertEqual(AvatarCache.bytes(in: dir), 5)
    }

    func testBytesOfAMissingDirectoryIsZero() {
        XCTAssertEqual(AvatarCache.bytes(in: dir.appendingPathComponent("absent")), 0)
    }

    /// Eviction keeps the cache bounded. The exact victims are timestamp-driven
    /// and not worth pinning; the count is.
    func testEvictsDownToTheEntryCap() {
        for i in 0..<(AvatarCache.maxEntries + 10) {
            AvatarCache.store(url: "https://example.com/\(i).png", data: Data([UInt8(i % 251)]), in: dir)
        }
        let remaining = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil
        ))?.count ?? 0
        XCTAssertLessThanOrEqual(remaining, AvatarCache.maxEntries)
        XCTAssertGreaterThan(remaining, 0)
    }
}
