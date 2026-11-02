package buzz.armada.app;

import fr.acinq.secp256k1.Secp256k1;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The secp256k1 side of Nostr for the background service: x-only public keys,
 * NIP-44 conversation keys (ECDH), BIP-340 Schnorr sign/verify and canonical
 * NIP-01 event ids — enough to open ANY gift wrap addressed to the user, verify
 * every event the untrusted relay streams, and answer NIP-42 AUTH challenges
 * natively, without the WebView.
 *
 * <p>The elliptic-curve operations delegate to ACINQ's {@link Secp256k1}
 * bindings over the audited libsecp256k1 C library (the same one Bitcoin Core
 * and Amethyst use) — we do NOT hand-roll curve arithmetic. Wire compatibility
 * with the WebView (nostr-tools / @noble/curves) is pinned by NostrCryptoTest,
 * whose expected values were generated with those exact libraries.
 */
final class NostrCrypto {

    private NostrCrypto() {}

    private static final Secp256k1 SECP = Secp256k1.get();
    private static final SecureRandom RANDOM = new SecureRandom();

    // ── Keys ─────────────────────────────────────────────────────────────────

    /** x-only (BIP-340 / Nostr) public key for a 32-byte secret key, hex. */
    static String pubkeyOf(byte[] sk) {
        // pubkeyCreate → 65-byte uncompressed; compress → 33 bytes (prefix +
        // x); the x-only key drops the parity prefix.
        byte[] compressed = SECP.pubKeyCompress(SECP.pubkeyCreate(sk));
        byte[] xonly = new byte[32];
        System.arraycopy(compressed, 1, xonly, 0, 32);
        return bytesToHex(xonly);
    }

    /**
     * NIP-44 v2 conversation key between {@code sk} and an x-only peer pubkey:
     * {@code HKDF-Extract(salt="nip44-v2", ikm=ECDH_x(sk, lift_x(peer)))}.
     * Symmetric — conv(a, B) == conv(b, A). Returns null on any invalid input
     * (bad hex, x not on curve) instead of throwing.
     *
     * <p>Uses the raw shared-point x-coordinate (via scalar point
     * multiplication), NOT libsecp's {@code ecdh} helper, which returns a
     * SHA-256 of the point — NIP-44 hashes the bare x itself. The even-Y lift
     * (0x02 prefix) matches nostr-tools; a point and its negation share an x,
     * so the peer's true Y parity doesn't change the result.
     */
    static byte[] conversationKey(byte[] sk, String peerPkHex) {
        try {
            byte[] x = ConcordCrypto.hexToBytes(peerPkHex);
            if (x == null || x.length != 32) return null;
            byte[] compressed = new byte[33];
            compressed[0] = 0x02; // lift_x: the even-Y point
            System.arraycopy(x, 0, compressed, 1, 32);
            // sk · peerPoint → 65-byte uncompressed point; take its x-coord.
            byte[] shared = SECP.pubKeyTweakMul(compressed, sk);
            byte[] sharedX = new byte[32];
            System.arraycopy(shared, 1, sharedX, 0, 32);
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec("nip44-v2".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(sharedX);
        } catch (Exception e) {
            return null;
        }
    }

    // ── BIP-340 Schnorr ──────────────────────────────────────────────────────

    /** Sign a 32-byte message hash per BIP-340. {@code aux} is 32 random bytes. */
    static byte[] schnorrSign(byte[] msg32, byte[] sk, byte[] aux32) throws Exception {
        return SECP.signSchnorr(msg32, sk, aux32);
    }

    /**
     * Verify a 64-byte BIP-340 Schnorr signature over {@code msg32} for the
     * x-only public key {@code pk32}. Returns false (never throws) on any
     * malformed input or a signature that doesn't check out.
     */
    static boolean schnorrVerify(byte[] msg32, byte[] pk32, byte[] sig64) {
        try {
            if (msg32 == null || msg32.length != 32) return false;
            if (pk32 == null || pk32.length != 32) return false;
            if (sig64 == null || sig64.length != 64) return false;
            return SECP.verifySchnorr(sig64, msg32, pk32);
        } catch (Exception ex) {
            return false;
        }
    }

    /**
     * Verify a complete Nostr event: recompute its canonical NIP-01 id from the
     * signed fields (a mismatch means {@code content}/{@code tags} were tampered
     * with) and check its Schnorr signature against {@code pubkey}. Returns
     * false (never throws) on any malformed field. This is the same check the
     * WebView runs via nostr-tools' {@code verifyEvent}; the background service
     * must run it for every non-wrap event and every inner seal, since the
     * relay is untrusted.
     */
    static boolean verifyEvent(JSONObject event) {
        if (!ServiceProfiler.ON) return verifyEventInner(event);
        long t = ServiceProfiler.begin("crypto.verify");
        try {
            return verifyEventInner(event);
        } finally {
            ServiceProfiler.end("crypto.verify", t);
        }
    }

    private static boolean verifyEventInner(JSONObject event) {
        try {
            if (event == null) return false;
            String id = event.optString("id", "");
            String pubkey = event.optString("pubkey", "");
            String sig = event.optString("sig", "");
            if (id.length() != 64 || pubkey.length() != 64 || sig.length() != 128) return false;
            long createdAt = event.optLong("created_at", -1);
            if (createdAt < 0) return false;
            int kind = event.optInt("kind", -1);
            if (kind < 0) return false;
            JSONArray tags = event.optJSONArray("tags");
            if (tags == null) tags = new JSONArray();
            String content = event.optString("content", "");

            String computedId = eventId(pubkey, createdAt, kind, tags, content);
            if (!computedId.equals(id)) return false;

            byte[] msg = ConcordCrypto.hexToBytes(id);
            byte[] pk = ConcordCrypto.hexToBytes(pubkey);
            byte[] sigBytes = ConcordCrypto.hexToBytes(sig);
            if (msg == null || pk == null || sigBytes == null) return false;
            return schnorrVerify(msg, pk, sigBytes);
        } catch (Exception ex) {
            return false;
        }
    }

    // ── NIP-01 events ────────────────────────────────────────────────────────

    /**
     * The canonical NIP-01 event id: sha256 of
     * {@code [0,pubkey,created_at,kind,tags,content]} serialized exactly as
     * JavaScript's {@code JSON.stringify} would (see {@link #jsonString}) —
     * org.json's own serializer escapes differently and must not be used here.
     */
    static String eventId(String pubkey, long createdAt, int kind, JSONArray tags, String content) {
        StringBuilder sb = new StringBuilder();
        sb.append("[0,\"").append(pubkey).append("\",").append(createdAt).append(',').append(kind).append(',');
        sb.append('[');
        for (int i = 0; i < tags.length(); i++) {
            if (i > 0) sb.append(',');
            JSONArray tag = tags.optJSONArray(i);
            sb.append('[');
            if (tag != null) {
                for (int j = 0; j < tag.length(); j++) {
                    if (j > 0) sb.append(',');
                    jsonString(sb, tag.optString(j));
                }
            }
            sb.append(']');
        }
        sb.append("],");
        jsonString(sb, content);
        sb.append(']');
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            return bytesToHex(sha.digest(sb.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new RuntimeException(e); // SHA-256 always exists
        }
    }

    /**
     * Whether a rumor carries an id that IS its NIP-01 hash. A rumor is
     * unsigned, so its id is otherwise the sender's choice — and it is the key
     * the store files it under and what replies, edits and deletes name.
     */
    static boolean rumorIdMatches(JSONObject rumor) {
        JSONArray tags = rumor.optJSONArray("tags");
        if (tags == null) return false;
        if (!(rumor.opt("kind") instanceof Number)) return false;
        if (!(rumor.opt("created_at") instanceof Number)) return false;
        if (!(rumor.opt("content") instanceof String)) return false;
        if (!(rumor.opt("pubkey") instanceof String)) return false;
        String claimed = rumor.optString("id", "");
        if (claimed.isEmpty()) return false;
        return claimed.equals(eventId(rumor.optString("pubkey"), rumor.optLong("created_at"),
                rumor.optInt("kind"), tags, rumor.optString("content")));
    }

    /** Build, id and Schnorr-sign a complete event with the given secret key. */
    static JSONObject finalizeEvent(int kind, String content, JSONArray tags, long createdAt, byte[] sk)
            throws Exception {
        String pubkey = pubkeyOf(sk);
        String id = eventId(pubkey, createdAt, kind, tags, content);
        byte[] aux = new byte[32];
        RANDOM.nextBytes(aux);
        byte[] sig = schnorrSign(ConcordCrypto.hexToBytes(id), sk, aux);
        JSONObject ev = new JSONObject();
        ev.put("id", id);
        ev.put("pubkey", pubkey);
        ev.put("created_at", createdAt);
        ev.put("kind", kind);
        ev.put("tags", tags);
        ev.put("content", content);
        ev.put("sig", bytesToHex(sig));
        return ev;
    }

    /**
     * Append a JSON string literal exactly as JavaScript's JSON.stringify:
     * escape {@code "} and {@code \}, use the two-char forms for
     * {@code \b \t \n \f \r}, {@code \\u00xx} for other control chars, and emit
     * everything else (including all non-ASCII) literally. org.json instead
     * escapes {@code /} after {@code <} and high code points, which would
     * change the hash.
     */
    private static void jsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\t': sb.append("\\t"); break;
                case '\n': sb.append("\\n"); break;
                case '\f': sb.append("\\f"); break;
                case '\r': sb.append("\\r"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16));
            sb.append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }
}
