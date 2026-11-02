import Foundation

/// NIP-44 v2 decryption under a raw 32-byte conversation key.
///
/// Wire format, after base64-decoding the payload:
/// `[version=2 (1)] [nonce (32)] [ciphertext (n)] [mac (32)]`. Message keys are
/// `HKDF-Expand(SHA-256, conversationKey, info: nonce, 76)` split into
/// `chacha_key[0..32]`, `chacha_nonce[32..44]`, `hmac_key[44..76]`, and the MAC
/// is `HMAC-SHA256(hmac_key, nonce || ciphertext)`.
///
/// Decrypting is nearly all of it. The one thing that encrypts is the NIP-46
/// client (`Nip46Client`), which has to seal an RPC to the user's bunker —
/// there is no other reason for this process to produce ciphertext, and none
/// of it ever touches the identity key.
///
/// Ported from `ConcordCrypto.java`.
enum Nip44 {

    /// Decrypt a base64 payload, or nil on any malformed input, MAC mismatch or
    /// decode failure. Never throws — every caller here treats an unopenable
    /// payload as "not ours", which is indistinguishable from "corrupt" and
    /// must be handled the same way regardless.
    static func decrypt(conversationKey: [UInt8], payloadBase64: String) -> String? {
        guard conversationKey.count == 32 else { return nil }
        // A leading '#' is NIP-44's explicit "unsupported future version" marker
        // and is not base64 at all.
        guard let first = payloadBase64.first, first != "#" else { return nil }
        guard let data = Data(base64Encoded: payloadBase64) else { return nil }

        let bytes = [UInt8](data)
        // version(1) + nonce(32) + minimum ciphertext(32) + mac(32).
        guard bytes.count >= 99, bytes[0] == 2 else { return nil }

        let nonce = Array(bytes[1..<33])
        let ciphertext = Array(bytes[33..<(bytes.count - 32)])
        let mac = Array(bytes[(bytes.count - 32)...])

        let keys = Crypto.hkdfExpand(prk: conversationKey, info: nonce, length: 76)
        guard keys.count == 76 else { return nil }
        let chachaKey = Array(keys[0..<32])
        let chachaNonce = Array(keys[32..<44])
        let hmacKey = Array(keys[44..<76])

        let expected = Crypto.hmacSha256(key: hmacKey, message: nonce + ciphertext)
        guard Crypto.constantTimeEquals(expected, mac) else { return nil }

        return unpad(Crypto.chacha20(key: chachaKey, nonce: chachaNonce, input: ciphertext))
    }

    /// Encrypt to a base64 payload under a raw conversation key.
    ///
    /// `nonce` is injectable so the round-trip can be pinned against a vector;
    /// the caller that matters generates a fresh random one per message, which
    /// NIP-44 requires — the message keys are derived from it, so a repeat
    /// would reuse a ChaCha20 keystream.
    static func encrypt(
        conversationKey: [UInt8],
        plaintext: String,
        nonce: [UInt8] = randomNonce()
    ) -> String? {
        guard conversationKey.count == 32, nonce.count == 32 else { return nil }
        let unpadded = [UInt8](plaintext.utf8)
        guard unpadded.count >= 1, unpadded.count <= 65535 else { return nil }

        let keys = Crypto.hkdfExpand(prk: conversationKey, info: nonce, length: 76)
        guard keys.count == 76 else { return nil }
        let chachaKey = Array(keys[0..<32])
        let chachaNonce = Array(keys[32..<44])
        let hmacKey = Array(keys[44..<76])

        var padded = [UInt8]()
        padded.reserveCapacity(2 + paddedLength(unpadded.count))
        padded.append(UInt8(truncatingIfNeeded: unpadded.count >> 8))
        padded.append(UInt8(truncatingIfNeeded: unpadded.count))
        padded.append(contentsOf: unpadded)
        padded.append(
            contentsOf: [UInt8](repeating: 0, count: paddedLength(unpadded.count) - unpadded.count)
        )

        let ciphertext = Crypto.chacha20(key: chachaKey, nonce: chachaNonce, input: padded)
        let mac = Crypto.hmacSha256(key: hmacKey, message: nonce + ciphertext)
        return Data([2] + nonce + ciphertext + mac).base64EncodedString()
    }

    /// 32 fresh random bytes. `SystemRandomNumberGenerator` is documented as
    /// cryptographically secure on every platform this builds for.
    static func randomNonce() -> [UInt8] {
        var generator = SystemRandomNumberGenerator()
        return (0..<32).map { _ in UInt8.random(in: UInt8.min...UInt8.max, using: &generator) }
    }

    /// NIP-44's padded length: a 32-byte floor, then power-of-two-derived chunks.
    private static func paddedLength(_ unpadded: Int) -> Int {
        if unpadded <= 32 { return 32 }
        let nextPower = 1 << (Int.bitWidth - (unpadded - 1).leadingZeroBitCount)
        let chunk = nextPower <= 256 ? 32 : nextPower / 8
        return chunk * ((unpadded - 1) / chunk + 1)
    }

    /// Strip NIP-44 padding: `[u16-BE len][plaintext][zeros]`, with the extended
    /// u32 form (a zero u16 followed by a u32) for lengths from 65536.
    private static func unpad(_ padded: [UInt8]) -> String? {
        guard padded.count >= 2 else { return nil }
        let firstTwo = Int(padded[0]) << 8 | Int(padded[1])

        let unpaddedLength: Int
        let prefixLength: Int
        if firstTwo == 0 {
            guard padded.count >= 6 else { return nil }
            unpaddedLength = Int(padded[2]) << 24 | Int(padded[3]) << 16
                | Int(padded[4]) << 8 | Int(padded[5])
            prefixLength = 6
            guard unpaddedLength >= 65536 else { return nil }
        } else {
            unpaddedLength = firstTwo
            prefixLength = 2
        }

        // nostr-tools' rule: the padding is exactly what the length implies, so
        // this port accepts no ciphertext the WebView would refuse.
        guard unpaddedLength >= 1, padded.count == prefixLength + paddedLength(unpaddedLength) else { return nil }
        return String(
            decoding: padded[prefixLength..<(prefixLength + unpaddedLength)],
            as: UTF8.self
        )
    }
}
