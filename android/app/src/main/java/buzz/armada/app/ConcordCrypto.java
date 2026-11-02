package buzz.armada.app;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Minimal, dependency-free NIP-44 v2 encryption/decryption under a raw
 * conversation key — the service's shared NIP-44 core, used to open Concord
 * (CORD-02) stream wraps and NIP-17 DM seals in the background notification
 * service, and by {@code NativeSigner}/{@code NostrCrypto} for the reverse
 * (encrypt) direction of native quick replies.
 *
 * <p>A Concord wrap carries, as the outer event's string {@code content}, a
 * base64 NIP-44 v2 payload encrypted under the stream's raw 32-byte
 * conversation key (no ECDH). The decrypted plaintext is the JSON of the seal
 * / rumor, whose {@code pubkey} is the real author and whose {@code content}
 * is the message text.
 *
 * <p>The HMAC over the ciphertext authenticates the
 * payload against the conversation key: a party without the key cannot forge a
 * payload that decrypts, so the recovered author/content are key-authenticated.
 * The WebView performs the full binding-triad verification when the user opens
 * the app.
 *
 * <p>Wire format (after base64 decode of the payload):
 * {@code [version=2 (1)] [nonce (32)] [ciphertext (n)] [mac (32)]}.
 * Message keys are {@code HKDF-Expand(SHA-256, conversationKey, nonce, 76)} →
 * {@code chacha_key[0:32]}, {@code chacha_nonce[32:44]}, {@code hmac_key[44:76]}.
 * The MAC is {@code HMAC-SHA256(hmac_key, nonce || ciphertext)}.
 */
final class ConcordCrypto {

    private ConcordCrypto() {}

    /**
     * Decrypt a NIP-44 v2 base64 payload under a raw 32-byte conversation key.
     * Returns the plaintext, or {@code null} on any malformed input / MAC
     * mismatch / decode failure (best-effort; never throws).
     */
    static String decrypt(byte[] conversationKey, String payloadB64) {
        if (!ServiceProfiler.ON) return decryptInner(conversationKey, payloadB64);
        long t = ServiceProfiler.begin("crypto.nip44.decrypt");
        try {
            return decryptInner(conversationKey, payloadB64);
        } finally {
            ServiceProfiler.end("crypto.nip44.decrypt", t);
        }
    }

    private static String decryptInner(byte[] conversationKey, String payloadB64) {
        try {
            if (conversationKey == null || conversationKey.length != 32) return null;
            if (payloadB64 == null || payloadB64.isEmpty() || payloadB64.charAt(0) == '#') return null;

            byte[] data = android.util.Base64.decode(payloadB64, android.util.Base64.DEFAULT);
            // version(1) + nonce(32) + mac(32) = 65 minimum; ciphertext >= 32.
            if (data.length < 99) return null;
            if ((data[0] & 0xff) != 2) return null;

            byte[] nonce = Arrays.copyOfRange(data, 1, 33);
            byte[] ciphertext = Arrays.copyOfRange(data, 33, data.length - 32);
            byte[] mac = Arrays.copyOfRange(data, data.length - 32, data.length);

            // HKDF-Expand(SHA-256, prk=conversationKey, info=nonce, len=76).
            byte[] keys = hkdfExpand(conversationKey, nonce, 76);
            byte[] chachaKey = Arrays.copyOfRange(keys, 0, 32);
            byte[] chachaNonce = Arrays.copyOfRange(keys, 32, 44);
            byte[] hmacKey = Arrays.copyOfRange(keys, 44, 76);

            // Verify MAC = HMAC-SHA256(hmac_key, nonce || ciphertext).
            byte[] aadMsg = new byte[nonce.length + ciphertext.length];
            System.arraycopy(nonce, 0, aadMsg, 0, nonce.length);
            System.arraycopy(ciphertext, 0, aadMsg, nonce.length, ciphertext.length);
            byte[] expectedMac = hmacSha256(hmacKey, aadMsg);
            if (!constantTimeEquals(expectedMac, mac)) return null;

            byte[] padded = chacha20(chachaKey, chachaNonce, ciphertext);
            return unpad(padded);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Encrypt a plaintext to a NIP-44 v2 base64 payload under a raw 32-byte
     * conversation key (the inverse of {@link #decrypt}) — used by the native
     * NIP-46 client to seal RPC requests to the bunker. Returns null on any
     * failure.
     */
    static String encrypt(byte[] conversationKey, String plaintext) {
        byte[] nonce = new byte[32];
        new java.security.SecureRandom().nextBytes(nonce);
        byte[] payload = encryptBytes(conversationKey, plaintext, nonce);
        return payload != null
                ? android.util.Base64.encodeToString(payload, android.util.Base64.NO_WRAP)
                : null;
    }

    /** The byte-level encrypt core (fixed nonce injectable for the unit test). */
    static byte[] encryptBytes(byte[] conversationKey, String plaintext, byte[] nonce) {
        try {
            if (conversationKey == null || conversationKey.length != 32) return null;
            byte[] unpadded = plaintext.getBytes(StandardCharsets.UTF_8);
            if (unpadded.length < 1 || unpadded.length > 65535) return null;

            byte[] keys = hkdfExpand(conversationKey, nonce, 76);
            byte[] chachaKey = Arrays.copyOfRange(keys, 0, 32);
            byte[] chachaNonce = Arrays.copyOfRange(keys, 32, 44);
            byte[] hmacKey = Arrays.copyOfRange(keys, 44, 76);

            byte[] padded = new byte[2 + calcPaddedLen(unpadded.length)];
            padded[0] = (byte) (unpadded.length >>> 8);
            padded[1] = (byte) unpadded.length;
            System.arraycopy(unpadded, 0, padded, 2, unpadded.length);

            byte[] ciphertext = chacha20(chachaKey, chachaNonce, padded);
            byte[] macMsg = new byte[nonce.length + ciphertext.length];
            System.arraycopy(nonce, 0, macMsg, 0, nonce.length);
            System.arraycopy(ciphertext, 0, macMsg, nonce.length, ciphertext.length);
            byte[] mac = hmacSha256(hmacKey, macMsg);

            byte[] payload = new byte[1 + 32 + ciphertext.length + 32];
            payload[0] = 2;
            System.arraycopy(nonce, 0, payload, 1, 32);
            System.arraycopy(ciphertext, 0, payload, 33, ciphertext.length);
            System.arraycopy(mac, 0, payload, 33 + ciphertext.length, 32);
            return payload;
        } catch (Exception e) {
            return null;
        }
    }

    // ── NIP-44 padding ──────────────────────────────────────────────────────

    /** NIP-44 padded length: 32-byte floor, then power-of-two-derived chunks. */
    private static int calcPaddedLen(int unpaddedLen) {
        if (unpaddedLen <= 32) return 32;
        int nextPower = Integer.highestOneBit(unpaddedLen - 1) << 1;
        int chunk = nextPower <= 256 ? 32 : nextPower / 8;
        return chunk * ((unpaddedLen - 1) / chunk + 1);
    }

    /** Strip NIP-44 padding: [u16-BE len][plaintext][zeros] (extended u32 form for >= 65536). */
    private static String unpad(byte[] padded) {
        if (padded.length < 2) return null;
        int firstTwo = ((padded[0] & 0xff) << 8) | (padded[1] & 0xff);
        int unpaddedLen;
        int prefixLen;
        if (firstTwo == 0) {
            if (padded.length < 6) return null;
            unpaddedLen = ((padded[2] & 0xff) << 24) | ((padded[3] & 0xff) << 16)
                    | ((padded[4] & 0xff) << 8) | (padded[5] & 0xff);
            prefixLen = 6;
            if (unpaddedLen >= 0 && unpaddedLen < 65536) return null;
        } else {
            unpaddedLen = firstTwo;
            prefixLen = 2;
        }
        if (unpaddedLen < 1) return null;
        // nostr-tools' rule: the padding is exactly what the length implies, so
        // this port accepts no ciphertext the WebView would refuse.
        if (padded.length != prefixLen + paddedLenLong(unpaddedLen)) return null;
        return new String(padded, prefixLen, unpaddedLen, StandardCharsets.UTF_8);
    }

    /** {@link #calcPaddedLen} without int overflow, for a length read off the wire. */
    private static long paddedLenLong(long unpaddedLen) {
        if (unpaddedLen <= 32) return 32;
        long nextPower = Long.highestOneBit(unpaddedLen - 1) << 1;
        long chunk = nextPower <= 256 ? 32 : nextPower / 8;
        return chunk * ((unpaddedLen - 1) / chunk + 1);
    }

    // ── HKDF (expand only) ────────────────────────────────────────────────────

    /** RFC 5869 HKDF-Expand with SHA-256. {@code prk} is the conversation key. */
    private static byte[] hkdfExpand(byte[] prk, byte[] info, int length) throws Exception {
        int hashLen = 32;
        int n = (int) Math.ceil((double) length / hashLen);
        byte[] okm = new byte[n * hashLen];
        byte[] t = new byte[0];
        int pos = 0;
        for (int i = 1; i <= n; i++) {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(prk, "HmacSHA256"));
            mac.update(t);
            mac.update(info);
            mac.update((byte) i);
            t = mac.doFinal();
            System.arraycopy(t, 0, okm, pos, hashLen);
            pos += hashLen;
        }
        return Arrays.copyOfRange(okm, 0, length);
    }

    private static byte[] hmacSha256(byte[] key, byte[] message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(message);
    }

    private static boolean constantTimeEquals(byte[] a, byte[] b) {
        if (a == null || b == null || a.length != b.length) return false;
        int diff = 0;
        for (int i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }

    // ── ChaCha20 (RFC 8439, 12-byte nonce, counter from 0) ────────────────────

    /**
     * ChaCha20 keystream XOR (IETF variant): 256-bit key, 96-bit nonce, 32-bit
     * block counter starting at 0 — matching @noble/ciphers' {@code chacha20}
     * used by nostr-tools' NIP-44. Pure Java so it works below API 28 (where the
     * JCE {@code "ChaCha20"} cipher isn't available; minSdk is 24).
     */
    static byte[] chacha20(byte[] key, byte[] nonce, byte[] input) {
        int[] state = new int[16];
        state[0] = 0x61707865;
        state[1] = 0x3320646e;
        state[2] = 0x79622d32;
        state[3] = 0x6b206574;
        for (int i = 0; i < 8; i++) state[4 + i] = leInt(key, i * 4);
        state[12] = 0; // counter
        state[13] = leInt(nonce, 0);
        state[14] = leInt(nonce, 4);
        state[15] = leInt(nonce, 8);

        byte[] out = new byte[input.length];
        byte[] block = new byte[64];
        int offset = 0;
        while (offset < input.length) {
            chachaBlock(state, block);
            int n = Math.min(64, input.length - offset);
            for (int i = 0; i < n; i++) {
                out[offset + i] = (byte) (input[offset + i] ^ block[i]);
            }
            offset += n;
            state[12]++; // increment 32-bit counter
        }
        return out;
    }

    private static void chachaBlock(int[] state, byte[] out) {
        int[] x = Arrays.copyOf(state, 16);
        for (int i = 0; i < 10; i++) {
            // column rounds
            quarterRound(x, 0, 4, 8, 12);
            quarterRound(x, 1, 5, 9, 13);
            quarterRound(x, 2, 6, 10, 14);
            quarterRound(x, 3, 7, 11, 15);
            // diagonal rounds
            quarterRound(x, 0, 5, 10, 15);
            quarterRound(x, 1, 6, 11, 12);
            quarterRound(x, 2, 7, 8, 13);
            quarterRound(x, 3, 4, 9, 14);
        }
        for (int i = 0; i < 16; i++) {
            int v = x[i] + state[i];
            out[i * 4] = (byte) v;
            out[i * 4 + 1] = (byte) (v >>> 8);
            out[i * 4 + 2] = (byte) (v >>> 16);
            out[i * 4 + 3] = (byte) (v >>> 24);
        }
    }

    private static void quarterRound(int[] x, int a, int b, int c, int d) {
        x[a] += x[b]; x[d] ^= x[a]; x[d] = Integer.rotateLeft(x[d], 16);
        x[c] += x[d]; x[b] ^= x[c]; x[b] = Integer.rotateLeft(x[b], 12);
        x[a] += x[b]; x[d] ^= x[a]; x[d] = Integer.rotateLeft(x[d], 8);
        x[c] += x[d]; x[b] ^= x[c]; x[b] = Integer.rotateLeft(x[b], 7);
    }

    private static int leInt(byte[] b, int off) {
        return (b[off] & 0xff)
                | ((b[off + 1] & 0xff) << 8)
                | ((b[off + 2] & 0xff) << 16)
                | ((b[off + 3] & 0xff) << 24);
    }

    // ── Hex ───────────────────────────────────────────────────────────────────

    /** Decode a hex string to bytes; returns {@code null} on malformed input. */
    static byte[] hexToBytes(String hex) {
        if (hex == null) return null;
        int len = hex.length();
        if (len % 2 != 0) return null;
        byte[] out = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            int hi = Character.digit(hex.charAt(i), 16);
            int lo = Character.digit(hex.charAt(i + 1), 16);
            if (hi < 0 || lo < 0) return null;
            out[i / 2] = (byte) ((hi << 4) | lo);
        }
        return out;
    }
}
