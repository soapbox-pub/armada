import Foundation

/// Where a sender-named image is fetched FROM, decided the same way the app
/// decides it — the port of `src/lib/mediaPolicy.ts`, for the one fetch the
/// extension makes unprompted: a sender's kind-0 avatar. Keep the two (and
/// the Android `MediaPolicy.java`) in step.
///
/// An avatar fetch is a request from the phone's address to whatever host the
/// sender's profile names, made while the device is locked, for every message
/// that notifies. So the one control applies here too: a PROXY. With a proxy
/// set, the fetch goes through it and the host sees the proxy's address; with
/// none, the fetch is direct. A loopback/private address is never proxied (a
/// public proxy cannot reach it) and never fetched, so it resolves to nil.
struct MediaPolicy: Equatable {

    /// Normalized proxy template, or "" for none.
    let proxy: String
    /// Any community sender's avatar may be a notification icon (the reader
    /// loads everyone's media); false = known peers only.
    let allCommunityAvatars: Bool

    init(proxy: String = "", allCommunityAvatars: Bool = false) {
        self.proxy = MediaPolicy.normalizeProxy(proxy)
        self.allCommunityAvatars = allCommunityAvatars
    }

    /// The policy a fresh install has: proxying off, the app's own default. A
    /// proxy is only ever one the user turned on in settings.
    static let defaults = MediaPolicy()

    /// Parse the `mediaPolicy` object the app writes into the push config
    /// (`{proxy}`). A missing or unreadable one is the default policy —
    /// proxying off — since a config written without it belongs to a user who
    /// never turned a proxy on.
    static func parse(_ object: [String: Any]?) -> MediaPolicy {
        guard let object else { return defaults }
        return MediaPolicy(
            proxy: object["proxy"] as? String ?? "",
            allCommunityAvatars: object["allCommunityAvatars"] as? Bool ?? false
        )
    }

    /// The URL to fetch `url` from, or nil when the policy would not fetch it at
    /// all (a loopback/private address). Mirrors `mediaSrc`.
    func resolve(_ url: String?) -> String? {
        guard let url, !url.isEmpty else { return nil }
        guard let scheme = MediaPolicy.scheme(of: url), scheme == "https" || scheme == "http" else {
            return nil
        }
        // Never fetched and never proxied: a public proxy cannot reach it, and
        // the attempt would tell it the address.
        if MediaPolicy.isLocalNetworkUrl(url) { return nil }
        return proxy.isEmpty ? url : proxyUrl(url)
    }

    /// `url` through the proxy template, or unchanged when already on it.
    func proxyUrl(_ url: String) -> String {
        if proxy.isEmpty { return url }
        // The template's braces are not URL characters, so the proxy's own host
        // is read off a filled probe rather than the template itself.
        let probe = MediaPolicy.fillTemplate(proxy, href: "https://example.com/x")
        if let proxyHost = MediaPolicy.host(of: probe), proxyHost == MediaPolicy.host(of: url) {
            return url
        }
        return MediaPolicy.fillTemplate(proxy, href: url)
    }

    // MARK: - Pure helpers

    /// The stored form of a proxy template: trimmed, http(s) once filled, and
    /// carrying a placeholder (appended to a bare prefix). "" for anything
    /// unusable, which reads as "no proxy".
    ///
    /// A bare prefix ending in `=` is a query parameter value (`?url=`) and
    /// takes the percent-encoded `{href}`; anything else — a bare `?` or a path
    /// — takes the URL RAW via `{+href}`, which is what corsfix-style proxies
    /// want. Mirrors `normalizeMediaProxy`.
    static func normalizeProxy(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        let probe = fillTemplate(trimmed, href: "https://example.com/x")
        guard let scheme = scheme(of: probe), scheme == "https" || scheme == "http",
              host(of: probe) != nil
        else { return "" }
        if trimmed.contains("{href}") || trimmed.contains("{+href}") { return trimmed }
        return trimmed.hasSuffix("=") ? trimmed + "{href}" : trimmed + "{+href}"
    }

    /// RFC 6570 simple (`{href}`, percent-encoded like `encodeURIComponent`)
    /// and reserved (`{+href}`, kept raw) expansion of the one variable used.
    static func fillTemplate(_ template: String, href: String) -> String {
        template
            .replacingOccurrences(of: "{+href}", with: href)
            .replacingOccurrences(of: "{href}", with: encodeComponent(href))
    }

    /// `encodeURIComponent`'s unreserved set.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    static func encodeComponent(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s
    }

    /// Lowercase scheme of a URL string, or nil.
    static func scheme(of url: String) -> String? {
        guard let colon = url.firstIndex(of: ":"), colon > url.startIndex else { return nil }
        let scheme = url[url.startIndex..<colon]
        for (i, c) in scheme.enumerated() {
            let ok = c.isASCII && (c.isLetter || (i > 0 && (c.isNumber || c == "+" || c == "-" || c == ".")))
            if !ok { return nil }
        }
        return scheme.lowercased()
    }

    /// Lowercase hostname of a URL (IPv6 brackets stripped), or nil.
    static func host(of url: String) -> String? {
        guard !url.isEmpty, let components = URLComponents(string: url), var host = components.host,
              !host.isEmpty
        else { return nil }
        host = host.lowercased()
        if host.hasPrefix("[") { host.removeFirst() }
        if host.hasSuffix("]") { host.removeLast() }
        return canonicalHost(host)
    }

    /// An IP literal as WHATWG's `URL` serializes it, so the checks below see
    /// what `sanitizeUrl.ts` sees: IPv4 in any of its numeric forms (`127.1`,
    /// `2130706433`, `0x7f000001`) as a dotted quad, and IPv6 in lowercase hex
    /// with the longest zero run compressed. Anything else is returned unchanged.
    static func canonicalHost(_ h: String) -> String {
        if h.contains(":") {
            guard let groups = parseIpv6(h) else { return h }
            return serializeIpv6(groups)
        }
        return parseIpv4(h) ?? h
    }

    private static func ipv4Part(_ part: Substring) -> UInt64? {
        if part.isEmpty { return nil }
        var radix = 10
        var digits = part
        if part.count > 1, part.hasPrefix("0x") || part.hasPrefix("0X") {
            radix = 16
            digits = part.dropFirst(2)
            if digits.isEmpty { return 0 }
        } else if part.count > 1, part.hasPrefix("0") {
            radix = 8
            digits = part.dropFirst()
        }
        if digits.count > 32 { return nil }
        return UInt64(digits, radix: radix)
    }

    private static func parseIpv4(_ h: String) -> String? {
        var parts = h.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count > 1, parts.last?.isEmpty == true { parts.removeLast() }
        let n = parts.count
        guard n >= 1, n <= 4 else { return nil }
        var nums: [UInt64] = []
        for part in parts {
            guard let v = ipv4Part(part) else { return nil }
            nums.append(v)
        }
        for i in 0..<(n - 1) where nums[i] > 255 { return nil }
        guard nums[n - 1] < (UInt64(1) << (8 * UInt64(5 - n))) else { return nil }
        var ip = nums[n - 1]
        for i in 0..<(n - 1) { ip += nums[i] << (8 * UInt64(3 - i)) }
        return "\((ip >> 24) & 255).\((ip >> 16) & 255).\((ip >> 8) & 255).\(ip & 255)"
    }

    private static func parseIpv6(_ h: String) -> [Int]? {
        if h.contains("%") { return nil }
        let halves = h.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        let gap = halves.count == 2
        guard let head = ipv6Groups(halves[0], last: !gap || halves[1].isEmpty) else { return nil }
        let tail = gap ? ipv6Groups(halves[1], last: true) : []
        guard let tail else { return nil }
        let total = head.count + tail.count
        guard gap ? total <= 7 : total == 8 else { return nil }
        return head + Array(repeating: 0, count: 8 - total) + tail
    }

    /// Colon-separated hex groups; a dotted quad may end the address.
    private static func ipv6Groups(_ s: String, last: Bool) -> [Int]? {
        if s.isEmpty { return [] }
        let parts = s.split(separator: ":", omittingEmptySubsequences: false)
        var out: [Int] = []
        for (i, p) in parts.enumerated() {
            if last, i == parts.count - 1, p.contains(".") {
                guard isDottedQuad(String(p)) else { return nil }
                var b: [Int] = []
                for q in p.split(separator: ".") {
                    if q.count > 1, q.hasPrefix("0") { return nil }
                    guard let v = Int(q), v <= 255 else { return nil }
                    b.append(v)
                }
                out.append((b[0] << 8) | b[1])
                out.append((b[2] << 8) | b[3])
                continue
            }
            guard (1...4).contains(p.count), p.allSatisfy({ $0.isHexDigit && $0.isASCII }),
                  let v = Int(p, radix: 16) else { return nil }
            out.append(v)
        }
        return out
    }

    private static func serializeIpv6(_ g: [Int]) -> String {
        var best = -1
        var bestLen = 1
        var i = 0
        while i < 8 {
            if g[i] != 0 {
                i += 1
                continue
            }
            var j = i
            while j < 8 && g[j] == 0 { j += 1 }
            if j - i > bestLen {
                best = i
                bestLen = j - i
            }
            i = j
        }
        var out = ""
        i = 0
        while i < 8 {
            if i == best {
                out += i == 0 ? "::" : ":"
                i += bestLen
                continue
            }
            out += String(g[i], radix: 16)
            if i < 7 { out += ":" }
            i += 1
        }
        return out
    }

    private static let localSuffixes = [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa"]
    // Longest first: "::" is a prefix of "::ffff:".
    private static let embeddedV4Prefixes = ["::ffff:", "64:ff9b::", "::"]

    /// The port of `isLocalNetworkUrl` in `sanitizeUrl.ts`.
    static func isLocalNetworkUrl(_ url: String) -> Bool {
        guard var h = host(of: url) else { return false }
        if h.hasSuffix(".") { h.removeLast() }
        if h == "localhost" || localSuffixes.contains(where: { h.hasSuffix($0) }) { return true }
        if h == "::1" || h == "::" || h == "0.0.0.0" { return true }
        // IPv4 inside IPv6 (mapped, compatible, NAT64) reaches the same host by another spelling.
        for prefix in embeddedV4Prefixes where h.hasPrefix(prefix) {
            let rest = String(h.dropFirst(prefix.count))
            if isDottedQuad(rest) {
                h = rest
                break
            }
            let parts = rest.split(separator: ":", omittingEmptySubsequences: false)
            if parts.count == 2, parts.allSatisfy({ (1...4).contains($0.count) }),
               let a = UInt32(parts[0], radix: 16), let b = UInt32(parts[1], radix: 16) {
                let n = (a << 16) | b
                h = "\((n >> 24) & 255).\((n >> 16) & 255).\((n >> 8) & 255).\(n & 255)"
                break
            }
        }
        if isDottedQuad(h) {
            let p = h.split(separator: ".").compactMap { Int($0) }
            let a = p[0], b = p[1]
            if a == 127 || a == 10 || a == 0 { return true }
            if a == 192 && b == 168 { return true }
            if a == 172 && b >= 16 && b <= 31 { return true }
            if a == 169 && b == 254 { return true }
            if a == 100 && b >= 64 && b <= 127 { return true }
        }
        if h.range(of: "^f[cd][0-9a-f]*:", options: .regularExpression) != nil { return true }
        if h.range(of: "^fe[89ab][0-9a-f]*:", options: .regularExpression) != nil { return true }
        return false
    }

    private static func isDottedQuad(_ s: String) -> Bool {
        s.range(of: "^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$", options: .regularExpression) != nil
    }
}
