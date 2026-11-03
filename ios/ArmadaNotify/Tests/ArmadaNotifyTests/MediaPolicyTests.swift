import XCTest

@testable import ArmadaNotify

/// The extension's port of `lib/mediaPolicy.ts`, checked against the same cases
/// as `mediaPolicy.test.ts`: the avatar fetch must go to exactly the address
/// the app would have loaded the picture from.
final class MediaPolicyTests: XCTestCase {

    private let proxy = "https://proxy.shakespeare.diy/?url={href}"
    private let img = "https://henk.example/ip/ip.png"
    private let proxied = "https://proxy.shakespeare.diy/?url=https%3A%2F%2Fhenk.example%2Fip%2Fip.png"

    func testProxiesAHostWhenAProxyIsSet() {
        XCTAssertEqual(MediaPolicy(proxy: proxy).resolve(img), proxied)
    }

    func testLoadsDirectlyWithNoProxy() {
        XCTAssertEqual(MediaPolicy(proxy: "").resolve(img), img)
    }

    func testLocalNetworkAddressesAreNeverFetchedOrProxied() {
        XCTAssertNil(MediaPolicy(proxy: proxy).resolve("http://192.168.1.1/x.png"))
        XCTAssertNil(MediaPolicy(proxy: "").resolve("http://localhost:8080/x.png"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://[::ffff:7f00:1]/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://10.0.0.5/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://172.20.1.1/x"))
        XCTAssertFalse(MediaPolicy.isLocalNetworkUrl("http://172.32.1.1/x"))
        XCTAssertFalse(MediaPolicy.isLocalNetworkUrl("https://henk.example/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://[::127.0.0.1]/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://[::7f00:1]/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://[64:ff9b::7f00:1]/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://[::]/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://localhost./x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://router.lan/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://nas.home.arpa/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://100.64.0.1/x"))
        XCTAssertFalse(MediaPolicy.isLocalNetworkUrl("http://100.128.0.1/x"))
        XCTAssertFalse(MediaPolicy.isLocalNetworkUrl("http://[64:ff9b::808:808]/x"))
        XCTAssertFalse(MediaPolicy.isLocalNetworkUrl("https://example.com./x"))
    }

    func testNumericAndLongFormIpSpellingsMatchTheUrlParser() {
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://127.1/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://2130706433/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://0x7f000001/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://0300.0250.0.1/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://[0:0:0:0:0:0:0:1]/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://[0000::0001]/x"))
        XCTAssertTrue(MediaPolicy.isLocalNetworkUrl("http://user@127.1:8080/x"))
        XCTAssertFalse(MediaPolicy.isLocalNetworkUrl("http://134744072/x"))
        XCTAssertFalse(MediaPolicy.isLocalNetworkUrl("http://[2001:db8:0:0:0:0:0:1]/x"))
    }

    func testNonHttpAndEmptyUrlsResolveToNothing() {
        let p = MediaPolicy(proxy: "")
        XCTAssertNil(p.resolve(nil))
        XCTAssertNil(p.resolve(""))
        XCTAssertNil(p.resolve("data:image/png;base64,AAAA"))
        XCTAssertNil(p.resolve("ftp://host/x.png"))
    }

    func testAnAlreadyProxiedUrlIsNotWrappedTwice() {
        XCTAssertEqual(MediaPolicy(proxy: proxy).resolve(proxied), proxied)
    }

    func testProxyTemplateNormalizationMatchesTheApp() {
        XCTAssertEqual(MediaPolicy.normalizeProxy("https://p.example/?url="), "https://p.example/?url={href}")
        XCTAssertEqual(MediaPolicy.normalizeProxy(" https://p.example/{+href} "), "https://p.example/{+href}")
        XCTAssertEqual(MediaPolicy.normalizeProxy("https://proxy.corsfix.com/?"), "https://proxy.corsfix.com/?{+href}")
        XCTAssertEqual(MediaPolicy.normalizeProxy("https://cors.example/"), "https://cors.example/{+href}")
        XCTAssertEqual(MediaPolicy.normalizeProxy(""), "")
        XCTAssertEqual(MediaPolicy.normalizeProxy(nil), "")
        XCTAssertEqual(MediaPolicy.normalizeProxy("javascript:alert(1)//{href}"), "")
        XCTAssertEqual(MediaPolicy.normalizeProxy("not a url"), "")
    }

    func testEncodingMatchesEncodeUriComponent() {
        XCTAssertEqual(
            MediaPolicy.encodeComponent("https://a.example/x?y=1&z=2 w"),
            "https%3A%2F%2Fa.example%2Fx%3Fy%3D1%26z%3D2%20w"
        )
        XCTAssertEqual(
            MediaPolicy.fillTemplate("https://p.example/{+href}", href: "https://a.example/x?y=1"),
            "https://p.example/https://a.example/x?y=1"
        )
    }

    func testParseReadsTheAppShapeAndDefaultsTheRest() {
        XCTAssertEqual(MediaPolicy.parse(["proxy": "https://p.example/?u="]).proxy, "https://p.example/?u={href}")
        // Empty and absent are both proxying off, the app's default.
        XCTAssertEqual(MediaPolicy.parse(["proxy": ""]).proxy, "")
        XCTAssertEqual(MediaPolicy.parse([:]).proxy, "")
        XCTAssertFalse(MediaPolicy.parse(["proxy": ""]).allCommunityAvatars)
        XCTAssertTrue(MediaPolicy.parse(["proxy": "", "allCommunityAvatars": true]).allCommunityAvatars)
    }

    func testMissingConfigIsTheDefaultPolicyProxyOff() {
        XCTAssertEqual(MediaPolicy.defaults.proxy, "")
        let p = MediaPolicy.parse(nil)
        XCTAssertEqual(p, MediaPolicy.defaults)
        XCTAssertEqual(p.resolve(img), img)
    }

    func testPushConfigCarriesThePolicy() {
        let json = """
        {"self":"\(String(repeating: "a", count: 64))","policy":"generic",
         "mediaPolicy":{"proxy":""}}
        """
        let config = PushConfig.parse(json: json)
        XCTAssertEqual(config?.mediaPolicy.proxy, "")

        let legacy = PushConfig.parse(json: "{\"self\":\"\(String(repeating: "a", count: 64))\"}")
        XCTAssertEqual(legacy?.mediaPolicy, MediaPolicy.defaults)
    }
}
