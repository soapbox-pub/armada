import Capacitor
import UIKit
import WebKit

/// The app's Capacitor view controller. It exists to:
///
/// 1. register the app-local plugins (`ArmadaDbPlugin`, `ArmadaPushPlugin`,
///    `ArmadaYouTubePlugin` and `ArmadaStoragePlugin`), and
/// 2. limit the native bridge to the app's own top-level document
///    (`MainFrameBridgeGate`).
///
/// Capacitor's automatic registration walks `packageClassList` in
/// `capacitor.config.json`, which `cap sync` regenerates from the installed npm
/// plugin packages — so a plugin that lives in the app target rather than in a
/// package can't be listed there without the next sync dropping it.
/// `registerPluginInstance` is the supported path for exactly that case, and
/// `capacitorDidLoad()` is the moment the bridge exists but the web view has
/// not yet loaded.
///
/// Android registers the equivalent in `MainActivity.java`.
class ViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ArmadaDbPlugin())
        bridge?.registerPluginInstance(ArmadaPushPlugin())
        bridge?.registerPluginInstance(ArmadaYouTubePlugin())
        bridge?.registerPluginInstance(ArmadaStoragePlugin())
        MainFrameBridgeGate.install(on: bridge)
    }
}

/// Stands in front of Capacitor's `bridge` script message handler and forwards
/// only messages from the main frame of the app's own origin.
///
/// A `WKScriptMessageHandler` is reachable from every frame of the web view,
/// and Capacitor's iOS handler dispatches without looking at
/// `message.frameInfo`, so an embedded frame (a link embed, a Mini App) would
/// otherwise be able to post plugin calls. Android's Capacitor already scopes
/// its listener to the main frame and the allowed origins; this is the same
/// rule on iOS. Capacitor's own injected scripts are `forMainFrameOnly`, so
/// nothing legitimate is lost.
///
/// Installed before the first load and under the same handler name, so
/// Capacitor's `cleanUp()` (which removes the handler by name) removes it too.
final class MainFrameBridgeGate: NSObject, WKScriptMessageHandler {
    private static let handlerName = "bridge"

    private weak var inner: WebViewDelegationHandler?
    private let origin: (scheme: String, host: String, port: Int)

    private init(inner: WebViewDelegationHandler, serverURL: URL) {
        self.inner = inner
        let scheme = serverURL.scheme?.lowercased() ?? ""
        self.origin = (scheme, serverURL.host?.lowercased() ?? "", Self.port(serverURL.port, scheme: scheme))
    }

    static func install(on bridge: CAPBridgeProtocol?) {
        guard let bridge = bridge as? CapacitorBridge else { return }
        let handler = bridge.webViewDelegationHandler
        let controller = handler.contentController
        controller.removeScriptMessageHandler(forName: handlerName)
        controller.add(MainFrameBridgeGate(inner: handler, serverURL: bridge.config.serverURL), name: handlerName)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        let source = message.frameInfo.securityOrigin
        let scheme = source.protocol.lowercased()
        guard scheme == origin.scheme,
              source.host.lowercased() == origin.host,
              Self.port(source.port, scheme: scheme) == origin.port else { return }
        inner?.userContentController(userContentController, didReceive: message)
    }

    /// `WKSecurityOrigin` reports 0 for a scheme's default port and `URL` reports
    /// nil; both mean the same origin.
    private static func port(_ port: Int?, scheme: String) -> Int {
        guard let port = port, port != 0 else { return 0 }
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) { return 0 }
        return port
    }
}
