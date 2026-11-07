import Foundation

/// What a Concord reaction may say, the extension's port of `concord/lib/reactionContent.ts`
/// (Vector `is_renderable_reaction`): one no row could render rings nobody.
enum ReactionContent {
    static func renderable(_ content: String) -> Bool {
        if content.isEmpty || content == "+" || content == "-" { return true }
        if content.count >= 2, content.hasPrefix(":"), content.hasSuffix(":") {
            let inner = content.unicodeScalars.dropFirst().dropLast()
            let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_~+-".unicodeScalars)
            if !inner.isEmpty, inner.count <= 48, inner.allSatisfy({ allowed.contains($0) }) { return true }
        }
        let scalars = content.unicodeScalars
        return scalars.count <= 12
            && !scalars.contains(where: { $0.properties.isWhitespace })
            && !content.contains("://")
    }
}
