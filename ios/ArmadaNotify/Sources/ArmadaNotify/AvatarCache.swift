import Foundation

/// A tiny on-disk cache of sender avatars, in the App Group container.
///
/// It exists because of a constraint the other two platforms don't have. iOS
/// will only show a person's picture on a notification via a communication
/// notification, and the image has to be IN HAND when the extension hands its
/// content back — there is no URL the system will fetch on our behalf. So the
/// extension has to do the one thing this pipeline otherwise refuses to do and
/// touch the network, inside a budget measured in seconds, for every push.
///
/// Caching turns that into a per-sender cost rather than a per-message one: the
/// second message from someone is served from disk with no request at all. A
/// miss is never fatal — the notification simply shows the monogram iOS derives
/// from the sender's name, which is still the person rather than the app icon.
///
/// Keyed by the SHA-256 of the URL, so a profile that changes its picture
/// misses once and then caches the new one; nothing has to invalidate anything.
/// Hashing also keeps a remote string out of the filesystem: a URL can contain
/// a path separator, a `..`, or 4 KB of query, and none of that should be
/// deciding what file gets written.
///
/// The directory is a parameter rather than a lookup, so everything here — the
/// keying, the size cap, the eviction order — runs under `swift test` on Linux,
/// where an App Group container does not exist. Only `directory(appGroup:)`
/// needs a device.
public enum AvatarCache {

    /// Largest avatar worth keeping. A notification icon is rendered at a few
    /// dozen points; anything past this is someone's un-resized camera roll,
    /// and both the download and the decode come out of the extension's budget.
    public static let maxBytes = 256 * 1024

    /// How many avatars to keep before evicting the least recently used. A
    /// handful of conversations are live at once, and this is a convenience —
    /// it is not a store, and losing an entry costs one request.
    static let maxEntries = 64

    // MARK: - Core (directory injected, so Linux can test it)

    static func fileName(for url: String) -> String {
        Hex.encode(Crypto.sha256(url))
    }

    /// The cached bytes for a picture URL, or nil on a miss.
    static func cached(url: String, in directory: URL) -> Data? {
        let file = directory.appendingPathComponent(fileName(for: url))
        guard let data = try? Data(contentsOf: file) else { return nil }
        // Touch it so the eviction below is least-recently-USED rather than
        // least-recently-written: someone who messages daily should not be
        // evicted by a burst from people who messaged once.
        try? FileManager.default.setAttributes(
            [.modificationDate: Date()], ofItemAtPath: file.path
        )
        return data
    }

    /// Keep an avatar for next time. Oversized payloads are refused rather than
    /// truncated: half an image is not an image.
    static func store(url: String, data: Data, in directory: URL) {
        guard data.count <= maxBytes, !data.isEmpty else { return }
        let files = FileManager.default
        try? files.createDirectory(at: directory, withIntermediateDirectories: true)

        // PROTECTION CLASS is load-bearing, exactly as it is for
        // `push-config.json`: these files are written and read while the device
        // is LOCKED, so anything stronger than
        // `.completeUntilFirstUserAuthentication` would leave the extension
        // unable to read a file it wrote itself. (The option is Darwin-only;
        // the Linux suite exercises the same code path without it.)
        let file = directory.appendingPathComponent(fileName(for: url))
        #if canImport(Darwin)
            try? data.write(
                to: file,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        #else
            try? data.write(to: file, options: [.atomic])
        #endif
        evict(in: directory)
    }

    /// Total bytes of the cached avatars, for Settings › Storage.
    static func bytes(in directory: URL) -> Int {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.fileSizeKey]
        ) else { return 0 }
        return entries.reduce(0) { total, entry in
            total + ((try? entry.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        }
    }

    /// Drop the least recently used entries past `maxEntries`.
    static func evict(in directory: URL) {
        let files = FileManager.default
        guard let entries = try? files.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey]
        ), entries.count > maxEntries else { return }

        let byAge = entries.sorted { lhs, rhs in
            modified(lhs) < modified(rhs)
        }
        for stale in byAge.prefix(entries.count - maxEntries) {
            try? files.removeItem(at: stale)
        }
    }

    private static func modified(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate ?? .distantPast
    }
}

#if canImport(Darwin)

    extension AvatarCache {

        /// The cache directory inside the App Group container, or nil when the
        /// container is unavailable (the same condition that makes the store
        /// and the config unreadable — see `PushConfigStore.describe`).
        public static func directory(
            appGroup group: String = "group.buzz.armada.app"
        ) -> URL? {
            FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: group)?
                .appendingPathComponent("avatar-cache", isDirectory: true)
        }

        public static func cached(url: String) -> Data? {
            guard let directory = directory() else { return nil }
            return cached(url: url, in: directory)
        }

        public static func store(url: String, data: Data) {
            guard let directory = directory() else { return }
            store(url: url, data: data, in: directory)
        }

        public static func bytes() -> Int {
            guard let directory = directory() else { return 0 }
            return bytes(in: directory)
        }

        /// Forget every cached avatar. Called alongside the config on logout,
        /// so a signed-out device keeps no pictures of the people it was
        /// talking to.
        public static func clear() {
            guard let directory = directory() else { return }
            try? FileManager.default.removeItem(at: directory)
        }
    }

#endif
