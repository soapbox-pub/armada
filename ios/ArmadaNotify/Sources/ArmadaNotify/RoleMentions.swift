/// Role mentions (CORD-03 §3, CORD-04 §8), the extension's port of
/// `concord/lib/roleMentions.ts`: a `["role", id]` tag pings a reader holding
/// that Role when the text names it as `@Name`, and the Role is mentionable or
/// its author may mention any Role.
enum RoleMentions {
    static let maxRoleMentions = 16

    /// A Role the reader holds: its current name, and whether any author may ping it.
    struct Held: Equatable {
        let id: String
        let name: String
        let anyone: Bool
    }

    static func isRoleId(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    /// The config's `roleMentions`; an absent or malformed entry holds nothing.
    static func parse(_ raw: Any?) -> [Held] {
        guard let list = raw as? [[String: Any]] else { return [] }
        return list.compactMap { o in
            guard let id = o["id"] as? String, isRoleId(id) else { return nil }
            return Held(id: id, name: (o["name"] as? String) ?? "", anyone: (o["anyone"] as? Bool) ?? false)
        }
    }

    /// 64 lowercase hex characters, once each, in tag order, capped.
    static func ids(_ tags: [[String]]) -> [String] {
        var out: [String] = []
        for t in tags where t.count >= 2 && t[0] == "role" && isRoleId(t[1]) {
            if out.count == maxRoleMentions { break }
            if !out.contains(t[1]) { out.append(t[1]) }
        }
        return out
    }

    static func pings(content: String, tags: [[String]], held: [Held], authorMentionsAny: Bool) -> Bool {
        guard !held.isEmpty else { return false }
        // Byte for byte: Swift's `contains` on String compares by canonical equivalence.
        let bytes = Array(content.utf8)
        return ids(tags).contains { id in
            // An empty name would match any `@`.
            guard let role = held.first(where: { $0.id == id }), !role.name.isEmpty, role.anyone || authorMentionsAny else { return false }
            return containsBytes(bytes, Array("@\(role.name)".utf8))
        }
    }

    private static func containsBytes(_ hay: [UInt8], _ needle: [UInt8]) -> Bool {
        guard needle.count <= hay.count else { return false }
        if needle.isEmpty { return true }
        for i in 0...(hay.count - needle.count) where hay[i] == needle[0] {
            if hay[i..<(i + needle.count)].elementsEqual(needle) { return true }
        }
        return false
    }
}
