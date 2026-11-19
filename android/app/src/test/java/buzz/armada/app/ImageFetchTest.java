package buzz.armada.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import org.junit.Test;

/** Mirrors electron/imageFetch.test.mjs: the two fetchers keep one set of rules. */
public class ImageFetchTest {
    private static final byte[] GIF = "GIF89a\u0001\u0000".getBytes(StandardCharsets.ISO_8859_1);

    private static ImageFetch.Response respond(int status, byte[] body, String location) {
        return new ImageFetch.Response() {
            @Override public int status() { return status; }
            @Override public String location() { return location; }
            @Override public InputStream body() { return body == null ? null : new ByteArrayInputStream(body); }
            @Override public void close() {}
        };
    }

    /** Records each request, answering every one with {@code reply}. */
    private static final class FakeTransport implements ImageFetch.Transport {
        final List<URI> urls = new ArrayList<>();
        final List<List<InetAddress>> pins = new ArrayList<>();
        final ImageFetch.Response reply;

        FakeTransport(ImageFetch.Response reply) {
            this.reply = reply;
        }

        @Override public ImageFetch.Response get(URI url, List<InetAddress> pinned) {
            urls.add(url);
            pins.add(pinned);
            return reply;
        }
    }

    private static List<InetAddress> ips(String... literals) {
        List<InetAddress> out = new ArrayList<>();
        for (String l : literals) {
            try {
                out.add(InetAddress.getByName(l));
            } catch (UnknownHostException e) {
                throw new AssertionError(e);
            }
        }
        return out;
    }

    private static final ImageFetch.Resolver PUBLIC = url -> ips("93.184.216.34");

    @Test
    public void returnsAPublicHttpsImagePinnedToTheCheckedAddresses() {
        FakeTransport t = new FakeTransport(respond(200, GIF, null));
        ImageFetch.Image out = ImageFetch.fetch("https://cdn.example/a.gif", t, PUBLIC);
        assertNotNull(out);
        assertEquals("image/gif", out.type);
        assertArrayEquals(GIF, out.data);
        assertEquals(ips("93.184.216.34"), t.pins.get(0));
    }

    @Test
    public void refusesHttpLocalAndPrivateHostsBeforeAsking() {
        FakeTransport t = new FakeTransport(respond(200, GIF, null));
        for (String url : Arrays.asList("http://cdn.example/a.gif", "https://localhost/a.gif", "https://printer.local/a.gif", "https://192.168.1.4/a.gif", "https://[::ffff:7f00:1]/a.gif", "not a url")) {
            assertNull(url, ImageFetch.fetch(url, t, PUBLIC));
        }
        assertTrue(t.urls.isEmpty());
    }

    @Test
    public void checksEveryRedirectHop() {
        FakeTransport t = new FakeTransport(respond(302, null, "https://10.0.0.2/a.gif"));
        assertNull(ImageFetch.fetch("https://cdn.example/a.gif", t, PUBLIC));
        assertEquals(1, t.urls.size());
    }

    @Test
    public void refusesAPublicNameThatResolvesToALocalAddressOnEveryHop() {
        FakeTransport t = new FakeTransport(respond(302, null, "https://rebind.example/a.gif"));
        ImageFetch.Resolver rebind = url -> url.getHost().equals("rebind.example") ? ips("93.184.216.34", "::1") : ips("93.184.216.34");
        assertNull(ImageFetch.fetch("https://cdn.example/a.gif", t, rebind));
        assertEquals(1, t.urls.size());

        FakeTransport lan = new FakeTransport(respond(200, GIF, null));
        assertNull(ImageFetch.fetch("https://x.127.0.0.1.nip.io/a.gif", lan, url -> ips("127.0.0.1")));
        assertTrue(lan.urls.isEmpty());
    }

    @Test
    public void leavesResolutionToAProxyAndRefusesANameThatDoesntResolve() {
        FakeTransport t = new FakeTransport(respond(200, GIF, null));
        assertNotNull(ImageFetch.fetch("https://cdn.example/a.gif", t, url -> null));
        assertNull("through a proxy, nothing is pinned", t.pins.get(0));
        assertNull(ImageFetch.fetch("https://cdn.example/a.gif", t, url -> Collections.emptyList()));
        assertNull(ImageFetch.fetch("https://cdn.example/a.gif", t, url -> {
            throw new UnknownHostException("NXDOMAIN");
        }));
    }

    @Test
    public void returnsNothingThatIsntAnImageByItsOwnSignature() {
        FakeTransport t = new FakeTransport(respond(200, "<html>secret</html>".getBytes(StandardCharsets.UTF_8), null));
        assertNull(ImageFetch.fetch("https://cdn.example/a.gif", t, PUBLIC));
    }

    @Test
    public void refusesABodyPastTheCap() {
        byte[] big = new byte[ImageFetch.MAX_BYTES + 1];
        System.arraycopy(GIF, 0, big, 0, GIF.length);
        assertNull(ImageFetch.fetch("https://cdn.example/a.gif", new FakeTransport(respond(200, big, null)), PUBLIC));
    }

    @Test
    public void aTransportFailureIsNull() {
        ImageFetch.Transport broken = (url, pinned) -> {
            throw new IOException("reset");
        };
        assertNull(ImageFetch.fetch("https://cdn.example/a.gif", broken, PUBLIC));
    }

    @Test
    public void knowsImageSignaturesAndLocalHosts() {
        assertEquals("image/jpeg", ImageFetch.imageType(new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0}));
        assertEquals("image/avif", ImageFetch.imageType("....ftypavif".getBytes(StandardCharsets.ISO_8859_1)));
        assertTrue(ImageFetch.isLocalHost("172.20.0.1"));
        assertFalse(ImageFetch.isLocalHost("example.com"));
    }

    @Test
    public void knowsLocalResolvedAddresses() {
        for (String a : Arrays.asList("127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.9", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:192.168.1.1", "64:ff9b::a00:1")) {
            assertTrue(a, ImageFetch.isLocalAddress(ips(a).get(0)));
        }
        for (String a : Arrays.asList("93.184.216.34", "2606:2800:220:1::1", "::ffff:93.184.216.34")) {
            assertFalse(a, ImageFetch.isLocalAddress(ips(a).get(0)));
        }
    }
}
