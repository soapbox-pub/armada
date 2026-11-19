package buzz.armada.app;

import java.io.IOException;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Image bytes for the page from hosts that send no CORS headers, so it can draw a
 * small copy (src/lib/imageThumb.ts) instead of the WebView keeping, and on a GIF
 * re-rastering, every frame at full size. One 256px animated avatar measured ~70%
 * of a core on the GPU thread of a mid-range phone.
 *
 * A port of electron/imageFetch.js, with the same rules: the request is the one
 * the page's {@code <img>} already makes, but READING the bytes cross-origin is
 * new, so it answers only for public https hosts — every redirect hop checked,
 * by name and, on a direct connection, by what the name resolves to (a public
 * name can point at the LAN), with the connection pinned to the addresses
 * checked — never sends cookies, caps the size, and returns only bytes that are
 * an image by their own signature.
 */
final class ImageFetch {
    static final int MAX_BYTES = 8 * 1024 * 1024;
    static final int MAX_REDIRECTS = 3;

    /** One response: a status, a {@code Location}, and a body to read. */
    interface Response extends AutoCloseable {
        int status();
        String location();
        InputStream body() throws IOException;
        @Override void close();
    }

    /** One request, without following redirects or sending cookies. {@code pinned} null = through a proxy. */
    interface Transport {
        Response get(URI url, List<InetAddress> pinned) throws IOException;
    }

    /** The addresses a direct connection to {@code host} would use; null when a proxy resolves it. */
    interface Resolver {
        List<InetAddress> resolve(URI url) throws IOException;
    }

    /** An image, by its own signature. */
    static final class Image {
        final String type;
        final byte[] data;

        Image(String type, byte[] data) {
            this.type = type;
            this.data = data;
        }
    }

    private ImageFetch() {}

    /** The image at {@code raw}, or null. Never throws. */
    static Image fetch(String raw, Transport transport, Resolver resolver) {
        URI url = publicHttps(raw);
        if (url == null) return null;
        try {
            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                List<InetAddress> pinned = resolver.resolve(url);
                if (pinned != null && (pinned.isEmpty() || anyLocal(pinned))) return null;
                try (Response res = transport.get(url, pinned)) {
                    int status = res.status();
                    if (status >= 300 && status < 400) {
                        String next = res.location();
                        url = next == null ? null : publicHttps(url.resolve(next).toString());
                        if (url == null) return null;
                        continue;
                    }
                    if (status < 200 || status >= 300) return null;
                    byte[] data = readCapped(res.body());
                    String type = data == null ? null : imageType(data);
                    return type == null ? null : new Image(type, data);
                }
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    static URI publicHttps(String raw) {
        try {
            URI u = new URI(raw);
            String host = u.getHost();
            if (!"https".equalsIgnoreCase(u.getScheme()) || host == null || isLocalHost(host)) return null;
            return u;
        } catch (Exception e) {
            return null;
        }
    }

    private static byte[] readCapped(InputStream in) throws IOException {
        if (in == null) return null;
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int total = 0;
        for (int n; (n = in.read(buf)) != -1; ) {
            total += n;
            if (total > MAX_BYTES) return null;
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    /** The image type by signature, or null: GIF, PNG/APNG, JPEG, WebP, AVIF. */
    static String imageType(byte[] b) {
        if (startsWith(b, 0, "GIF8")) return "image/gif";
        if (b.length >= 4 && (b[0] & 0xff) == 0x89 && startsWith(b, 1, "PNG")) return "image/png";
        if (b.length >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff) return "image/jpeg";
        if (startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP")) return "image/webp";
        if (startsWith(b, 4, "ftypavif") || startsWith(b, 4, "ftypavis")) return "image/avif";
        return null;
    }

    private static boolean startsWith(byte[] b, int at, String ascii) {
        if (b.length < at + ascii.length()) return false;
        for (int i = 0; i < ascii.length(); i++) if (b[at + i] != (byte) ascii.charAt(i)) return false;
        return true;
    }

    private static final String[] LOCAL_SUFFIXES = {".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa"};
    private static final Pattern EMBEDDED_HEX = Pattern.compile("^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$");
    private static final Pattern EMBEDDED_DOTTED = Pattern.compile("^(?:::ffff:|::|64:ff9b::)(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})$");
    private static final Pattern V4 = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$");

    /** A local or private host by its name or literal address (mirrors isLocalNetworkUrl in src/lib/sanitizeUrl.ts). */
    static boolean isLocalHost(String hostname) {
        String h = hostname.toLowerCase(Locale.ROOT).replaceAll("^\\[|\\]$", "").replaceAll("\\.$", "");
        if (h.equals("localhost")) return true;
        for (String s : LOCAL_SUFFIXES) if (h.endsWith(s)) return true;
        if (h.equals("::1") || h.equals("::") || h.equals("0.0.0.0")) return true;
        Matcher hex = EMBEDDED_HEX.matcher(h);
        if (hex.matches()) {
            int n = (Integer.parseInt(hex.group(1), 16) << 16) | Integer.parseInt(hex.group(2), 16);
            h = ((n >>> 24) & 255) + "." + ((n >>> 16) & 255) + "." + ((n >>> 8) & 255) + "." + (n & 255);
        } else {
            Matcher dotted = EMBEDDED_DOTTED.matcher(h);
            if (dotted.matches()) h = dotted.group(1);
        }
        Matcher v4 = V4.matcher(h);
        if (v4.matches()) return isLocalV4(Integer.parseInt(v4.group(1)), Integer.parseInt(v4.group(2)));
        if (h.matches("^f[cd][0-9a-f]*:.*")) return true;
        return h.matches("^fe[89ab][0-9a-f]*:.*");
    }

    private static boolean isLocalV4(int a, int b) {
        return a == 127 || a == 10 || a == 0
            || (a == 192 && b == 168)
            || (a == 172 && b >= 16 && b <= 31)
            || (a == 169 && b == 254)
            || (a == 100 && b >= 64 && b <= 127);
    }

    /** A resolved address that isn't on the public internet. */
    static boolean isLocalAddress(InetAddress a) {
        if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress()) return true;
        byte[] b = a.getAddress();
        if (a instanceof Inet4Address) return isLocalV4(b[0] & 0xff, b[1] & 0xff);
        if (a instanceof Inet6Address) {
            // Unique local fc00::/7, and v4-embedded forms Java doesn't unwrap.
            if ((b[0] & 0xfe) == 0xfc) return true;
            boolean zeros = true;
            for (int i = 0; i < 10; i++) if (b[i] != 0) zeros = false;
            boolean mapped = zeros && (((b[10] & 0xff) == 0xff && (b[11] & 0xff) == 0xff) || (b[10] == 0 && b[11] == 0));
            boolean nat64 = (b[0] & 0xff) == 0x00 && (b[1] & 0xff) == 0x64 && (b[2] & 0xff) == 0xff && (b[3] & 0xff) == 0x9b;
            if (mapped || nat64) return isLocalV4(b[12] & 0xff, b[13] & 0xff);
        }
        return false;
    }

    private static boolean anyLocal(List<InetAddress> addresses) {
        for (InetAddress a : addresses) if (isLocalAddress(a)) return true;
        return false;
    }
}
