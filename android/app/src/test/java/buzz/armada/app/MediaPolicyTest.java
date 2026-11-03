package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The service's port of {@code lib/mediaPolicy.ts}, checked against the same
 * cases as {@code mediaPolicy.test.ts}: a background avatar fetch must go to
 * exactly the address the WebView would have loaded the picture from.
 */
public class MediaPolicyTest {
    private static final String PROXY = "https://proxy.shakespeare.diy/?url={href}";
    private static final String IMG = "https://henk.example/ip/ip.png";
    private static final String PROXIED =
            "https://proxy.shakespeare.diy/?url=https%3A%2F%2Fhenk.example%2Fip%2Fip.png";

    @Test public void proxiesAHostWhenAProxyIsSet() {
        assertEquals(PROXIED, new MediaPolicy(PROXY).resolve(IMG));
    }

    @Test public void loadsDirectlyWithNoProxy() {
        assertEquals(IMG, new MediaPolicy("").resolve(IMG));
    }

    @Test public void localNetworkAddressesAreNeverFetchedOrProxied() {
        assertNull(new MediaPolicy(PROXY).resolve("http://192.168.1.1/x.png"));
        assertNull(new MediaPolicy("").resolve("http://localhost:8080/x.png"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://[::ffff:7f00:1]/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://10.0.0.5/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://172.20.1.1/x"));
        assertFalse(MediaPolicy.isLocalNetworkUrl("http://172.32.1.1/x"));
        assertFalse(MediaPolicy.isLocalNetworkUrl("https://henk.example/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://[::127.0.0.1]/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://[::7f00:1]/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://[64:ff9b::7f00:1]/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://[::]/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://localhost./x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://router.lan/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://nas.home.arpa/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://100.64.0.1/x"));
        assertFalse(MediaPolicy.isLocalNetworkUrl("http://100.128.0.1/x"));
        assertFalse(MediaPolicy.isLocalNetworkUrl("http://[64:ff9b::808:808]/x"));
        assertFalse(MediaPolicy.isLocalNetworkUrl("https://example.com./x"));
    }

    @Test public void numericAndLongFormIpSpellingsMatchTheUrlParser() {
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://127.1/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://2130706433/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://0x7f000001/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://0300.0250.0.1/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://[0:0:0:0:0:0:0:1]/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://[0000::0001]/x"));
        assertTrue(MediaPolicy.isLocalNetworkUrl("http://user@127.1:8080/x"));
        assertFalse(MediaPolicy.isLocalNetworkUrl("http://134744072/x"));
        assertFalse(MediaPolicy.isLocalNetworkUrl("http://[2001:db8:0:0:0:0:0:1]/x"));
    }

    @Test public void nonHttpAndEmptyUrlsResolveToNothing() {
        MediaPolicy p = new MediaPolicy("");
        assertNull(p.resolve(null));
        assertNull(p.resolve(""));
        assertNull(p.resolve("data:image/png;base64,AAAA"));
        assertNull(p.resolve("ftp://host/x.png"));
    }

    @Test public void anAlreadyProxiedUrlIsNotWrappedTwice() {
        assertEquals(PROXIED, new MediaPolicy(PROXY).resolve(PROXIED));
    }

    @Test public void proxyTemplateNormalizationMatchesTheWebView() {
        assertEquals("https://p.example/?url={href}", MediaPolicy.normalizeProxy("https://p.example/?url="));
        assertEquals("https://p.example/{+href}", MediaPolicy.normalizeProxy(" https://p.example/{+href} "));
        assertEquals("https://proxy.corsfix.com/?{+href}", MediaPolicy.normalizeProxy("https://proxy.corsfix.com/?"));
        assertEquals("https://cors.example/{+href}", MediaPolicy.normalizeProxy("https://cors.example/"));
        assertEquals("", MediaPolicy.normalizeProxy(""));
        assertEquals("", MediaPolicy.normalizeProxy(null));
        assertEquals("", MediaPolicy.normalizeProxy("javascript:alert(1)//{href}"));
        assertEquals("", MediaPolicy.normalizeProxy("not a url"));
    }

    @Test public void encodingMatchesEncodeUriComponent() {
        assertEquals("https%3A%2F%2Fa.example%2Fx%3Fy%3D1%26z%3D2%20w",
                MediaPolicy.encodeComponent("https://a.example/x?y=1&z=2 w"));
        assertEquals("https://p.example/https://a.example/x?y=1",
                MediaPolicy.fillTemplate("https://p.example/{+href}", "https://a.example/x?y=1"));
    }

    @Test public void parseReadsTheWebViewShapeAndDefaultsTheRest() {
        assertEquals("https://p.example/?u={href}",
                MediaPolicy.parse("{\"proxy\":\"https://p.example/?u=\"}").proxy);
        // Empty and absent are both proxying off, the WebView's default.
        assertEquals("", MediaPolicy.parse("{\"proxy\":\"\"}").proxy);
        assertEquals("", MediaPolicy.parse("{}").proxy);
        assertFalse(MediaPolicy.parse("{\"proxy\":\"\"}").allCommunityAvatars);
        assertTrue(MediaPolicy.parse("{\"proxy\":\"\",\"allCommunityAvatars\":true}").allCommunityAvatars);
    }

    @Test public void missingOrBrokenConfigIsTheDefaultPolicyProxyOff() {
        assertEquals("", MediaPolicy.defaults().proxy);
        for (String json : new String[] {null, "", "{", "[]"}) {
            MediaPolicy p = MediaPolicy.parse(json);
            assertEquals("", p.proxy);
            assertEquals(IMG, p.resolve(IMG));
        }
    }
}
